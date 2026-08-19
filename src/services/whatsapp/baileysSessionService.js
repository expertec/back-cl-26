import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeWASocket
} from "baileys";
import Pino from "pino";
import QRCode from "qrcode";
import { config } from "../../config.js";
import { getWhatsAppWebVersion } from "./baileysVersion.js";
import { clearFirestoreAuthState, listFirestoreSessionIds, useFirestoreAuthState } from "./firestoreAuthState.js";

const APPEND_MAX_AGE_MS = 5 * 60 * 1000;
const RECONNECT_BASE_MS = 5000;
const RECONNECT_MAX_MS = 5 * 60 * 1000;
const SEND_TIMEOUT_MS = 120000;

export const BAILEYS_STATUS = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  QR: "qr",
  CONNECTED: "connected",
  LOGGED_OUT: "logged_out"
});

const sessions = new Map();
const processedInMemory = new Map();
const logger = Pino({ level: process.env.BAILEYS_LOG_LEVEL || process.env.WA_LOG_LEVEL || "warn" });
let inboundHandler = null;
let warnedMissingHandler = false;
let watchdogTimer = null;

export function setBaileysInboundHandler(handler) {
  inboundHandler = typeof handler === "function" ? handler : null;
}

export async function connectBaileysSession(sessionId = config.baileysSessionId) {
  const id = sanitizeSessionId(sessionId);
  const session = getOrInitSession(id);

  if (session.starting) return getBaileysSessionState(id);
  if (session.sock && session.status === BAILEYS_STATUS.CONNECTED) return getBaileysSessionState(id);

  session.starting = true;
  patchSession(session, { status: BAILEYS_STATUS.CONNECTING, lastError: "" });

  try {
    const { state, saveCreds } = await useFirestoreAuthState(id);
    if (state.creds?.me?.id) {
      patchSession(session, { phone: state.creds.me.id.split("@")[0] });
    }

    const sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      version: getWhatsAppWebVersion(),
      browser: Browsers.macOS("Chrome"),
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false
    });

    session.sock = sock;

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        patchSession(session, {
          qr,
          qrDataUrl: null,
          qrAt: Date.now(),
          status: BAILEYS_STATUS.QR,
          lastError: ""
        });
        QRCode.toDataURL(qr, { margin: 1, width: 320 })
          .then((qrDataUrl) => {
            patchSession(session, { qrDataUrl });
          })
          .catch((error) => {
            console.warn("[baileys] qr data url failed", { sessionId: id, error: error.message });
          });
      }

      if (connection === "open") {
        patchSession(session, {
          status: BAILEYS_STATUS.CONNECTED,
          qr: null,
          qrDataUrl: null,
          lastError: "",
          phone: sock.user?.id ? sock.user.id.split("@")[0] : session.phone
        });
        session.reconnectAttempts = 0;
        console.log("[baileys] connected", { sessionId: id, phone: session.phone || null });
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut || reason === 405;

        session.sock = null;

        if (loggedOut) {
          clearFirestoreAuthState(id).catch((clearError) => {
            console.error("[baileys] no se pudo borrar la sesion", { sessionId: id, error: clearError.message });
          });
          patchSession(session, {
            status: BAILEYS_STATUS.LOGGED_OUT,
            qr: null,
            qrDataUrl: null,
            phone: null,
            lastError: "La sesion fue cerrada o rechazada. Escanea un QR nuevo."
          });
          console.warn("[baileys] logged out", { sessionId: id, reason });
          return;
        }

        patchSession(session, {
          status: BAILEYS_STATUS.DISCONNECTED,
          lastError: lastDisconnect?.error?.message || "Conexion cerrada."
        });

        scheduleReconnect(id, session);
      }
    });

    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", (payload) => {
      handleMessagesUpsert(id, payload).catch((error) => {
        console.error("[baileys] messages.upsert failed", { sessionId: id, error: error.message });
      });
    });

    return getBaileysSessionState(id);
  } catch (error) {
    patchSession(session, {
      status: BAILEYS_STATUS.DISCONNECTED,
      lastError: error.message || "No se pudo iniciar Baileys."
    });
    throw error;
  } finally {
    session.starting = false;
  }
}

function scheduleReconnect(sessionId, session) {
  if (session.reconnectTimer) return;

  session.reconnectAttempts = Number(session.reconnectAttempts || 0) + 1;
  const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (session.reconnectAttempts - 1), RECONNECT_MAX_MS);
  const delay = backoff + Math.floor(Math.random() * 3000);

  console.log("[baileys] reconectando", { sessionId, attempt: session.reconnectAttempts, delayMs: delay });

  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    connectBaileysSession(sessionId).catch((error) => {
      console.error("[baileys] reconnect failed", { sessionId, error: error.message });
      // Sin esto un fallo al reconectar dejaba la sesion muerta hasta el proximo deploy.
      scheduleReconnect(sessionId, session);
    });
  }, delay);

  session.reconnectTimer.unref?.();
}

/**
 * Red de seguridad: revisa cada minuto que toda sesion guardada en Firestore
 * siga conectada y la levanta si no. Cubre los casos que el evento
 * connection.update no alcanza a ver (caidas duras, reinicios del contenedor).
 */
export function startBaileysWatchdog(intervalMs = 60000) {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(() => {
    ensureSessionsConnected().catch((error) => {
      console.error("[baileys] watchdog failed", { error: error.message });
    });
  }, intervalMs);

  watchdogTimer.unref?.();
  console.log("[baileys] watchdog activo", { intervalMs });
}

async function ensureSessionsConnected() {
  const sessionIds = await listFirestoreSessionIds();

  for (const sessionId of sessionIds) {
    const id = sanitizeSessionId(sessionId);
    const session = sessions.get(id);
    const status = session?.status;

    if (session?.starting || session?.reconnectTimer) continue;
    if (status === BAILEYS_STATUS.CONNECTED || status === BAILEYS_STATUS.CONNECTING || status === BAILEYS_STATUS.QR) {
      continue;
    }

    console.warn("[baileys] watchdog: sesion caida, reconectando", { sessionId: id, status: status || "sin-socket" });
    await connectBaileysSession(id).catch((error) => {
      console.error("[baileys] watchdog reconnect failed", { sessionId: id, error: error.message });
    });
  }
}

export function getBaileysSessionState(sessionId = config.baileysSessionId) {
  const id = sanitizeSessionId(sessionId);
  const session = sessions.get(id);
  if (!session) {
    return {
      sessionId: id,
      status: BAILEYS_STATUS.DISCONNECTED,
      connected: false,
      qr: null,
      phone: null
    };
  }

  return {
    sessionId: id,
    status: session.status,
    connected: session.status === BAILEYS_STATUS.CONNECTED,
    qr: session.status === BAILEYS_STATUS.QR ? session.qr : null,
    qrDataUrl: session.status === BAILEYS_STATUS.QR ? session.qrDataUrl : null,
    qrAt: session.qrAt || null,
    phone: cleanSessionPhone(session.phone),
    lastError: session.lastError || "",
    updatedAt: session.updatedAt
  };
}

export async function logoutBaileysSession(sessionId = config.baileysSessionId) {
  const id = sanitizeSessionId(sessionId);
  const session = getOrInitSession(id);

  if (session.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }

  try {
    if (session.sock) await session.sock.logout();
  } catch (error) {
    console.warn("[baileys] logout ignored", { sessionId: id, error: error.message });
  }

  await clearFirestoreAuthState(id);
  patchSession(session, {
    sock: null,
    qr: null,
    qrDataUrl: null,
    phone: null,
    status: BAILEYS_STATUS.LOGGED_OUT,
    lastError: ""
  });

  return getBaileysSessionState(id);
}

export async function restoreBaileysSessions() {
  let sessionIds = [];

  try {
    sessionIds = await listFirestoreSessionIds();
  } catch (error) {
    console.error("[baileys] no se pudieron listar sesiones guardadas", { error: error.message });
    return 0;
  }

  sessionIds.forEach((sessionId, index) => {
    setTimeout(() => {
      connectBaileysSession(sessionId).catch((error) => {
        console.error("[baileys] restore failed", { sessionId, error: error.message });
      });
    }, (index + 1) * 400);
  });

  console.log("[baileys] restaurando sesiones desde Firestore", { restored: sessionIds.length, sessionIds });
  return sessionIds.length;
}

export async function sendBaileysText({ phone, message, sessionId = config.baileysSessionId }) {
  const sock = requireSock(sessionId);
  return sock.sendMessage(toJid(phone), { text: String(message || ""), linkPreview: false }, { timeoutMs: SEND_TIMEOUT_MS });
}

export async function sendBaileysAudio({ phone, audioUrl, sessionId = config.baileysSessionId }) {
  const sock = requireSock(sessionId);
  return sock.sendMessage(toJid(phone), { audio: { url: audioUrl }, mimetype: "audio/mp4" }, { timeoutMs: SEND_TIMEOUT_MS });
}

export async function sendBaileysDocument({ phone, url, filename, mimetype, caption, sessionId = config.baileysSessionId }) {
  const sock = requireSock(sessionId);
  return sock.sendMessage(
    toJid(phone),
    {
      document: { url },
      fileName: filename || "archivo",
      mimetype: mimetype || "application/octet-stream",
      caption
    },
    { timeoutMs: SEND_TIMEOUT_MS }
  );
}

export async function sendBaileysImage({ phone, imageUrl, caption, sessionId = config.baileysSessionId }) {
  const sock = requireSock(sessionId);
  return sock.sendMessage(toJid(phone), { image: { url: imageUrl }, caption }, { timeoutMs: SEND_TIMEOUT_MS });
}

export async function markBaileysMessageAsRead({ jid, messageId, sessionId = config.baileysSessionId }) {
  const sock = requireSock(sessionId);
  if (!jid || !messageId) return { ok: true, skipped: true };

  await sock.readMessages([{ remoteJid: jid, id: messageId }]);
  return { ok: true };
}

async function handleMessagesUpsert(sessionId, { messages, type }) {
  if (!inboundHandler) {
    if (!warnedMissingHandler) {
      warnedMissingHandler = true;
      console.warn(
        "[baileys] llegan mensajes pero no hay handler registrado; se estan descartando.",
        { sessionId, fix: "Define WHATSAPP_PROVIDER=baileys (o ENABLE_BAILEYS=true) y reinicia." }
      );
    }
    return;
  }
  if (!["notify", "append", "prepend"].includes(type || "")) return;

  const now = Date.now();
  const list = Array.isArray(messages) ? messages : [];

  for (const message of list) {
    if (!shouldProcessMessage(message, type, now)) continue;

    const normalized = await normalizeBaileysMessage(message, sessionId);
    if (!normalized?.text) continue;

    await inboundHandler(normalized);
  }
}

function shouldProcessMessage(message, type, now) {
  if (!message?.key?.id || message.key.fromMe) return false;
  const jid = message.key.remoteJid || "";
  if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) return false;

  const dedupeKey = `${jid}:${message.key.id}`;
  if (processedInMemory.has(dedupeKey)) return false;
  processedInMemory.set(dedupeKey, now);

  for (const [key, seenAt] of processedInMemory.entries()) {
    if (now - seenAt > 10 * 60 * 1000) processedInMemory.delete(key);
  }

  if (type === "append" || type === "prepend") {
    const messageAge = now - getMessageTimestampMs(message);
    if (messageAge > APPEND_MAX_AGE_MS) return false;
  }

  return true;
}

async function normalizeBaileysMessage(message, sessionId) {
  const { jid, phoneJid, lid } = resolveAddressing(message.key);
  const text = extractMessageText(message.message);
  const messageId = message.key.id;
  const timestampMs = getMessageTimestampMs(message);

  return {
    provider: "baileys",
    sessionId,
    messageId,
    phone: jidToPhone(phoneJid || jid),
    text,
    contactName: message.pushName || "",
    timestamp: timestampMs,
    jid,
    lid,
    raw: {
      key: message.key,
      messageTimestamp: message.messageTimestamp,
      pushName: message.pushName,
      message: message.message
    }
  };
}

function extractMessageText(message = {}) {
  const content = unwrapEphemeral(message);
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.buttonsResponseMessage?.selectedButtonId ||
    content.listResponseMessage?.title ||
    content.templateButtonReplyMessage?.selectedDisplayText ||
    content.templateButtonReplyMessage?.selectedId ||
    ""
  ).trim();
}

function unwrapEphemeral(message = {}) {
  return (
    message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message
  );
}

function getMessageTimestampMs(message) {
  const raw = Number(message?.messageTimestamp || 0);
  if (!raw) return Date.now();
  return raw > 10_000_000_000 ? raw : raw * 1000;
}

function getOrInitSession(sessionId) {
  const id = sanitizeSessionId(sessionId);
  let session = sessions.get(id);
  if (!session) {
    session = {
      sessionId: id,
      sock: null,
      qr: null,
      qrDataUrl: null,
      qrAt: 0,
      status: BAILEYS_STATUS.DISCONNECTED,
      phone: null,
      lastError: "",
      starting: false,
      reconnectTimer: null,
      reconnectAttempts: 0,
      updatedAt: Date.now()
    };
    sessions.set(id, session);
  }
  return session;
}

function patchSession(session, patch) {
  Object.assign(session, patch, { updatedAt: Date.now() });
  return session;
}

function requireSock(sessionId) {
  const id = sanitizeSessionId(sessionId);
  const session = sessions.get(id);
  if (!session?.sock || session.status !== BAILEYS_STATUS.CONNECTED) {
    const error = new Error("La sesion Baileys no esta conectada.");
    error.code = "BAILEYS_NOT_CONNECTED";
    throw error;
  }
  return session.sock;
}




function sanitizeSessionId(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`BAILEYS_SESSION_ID invalido: "${sessionId}"`);
  }
  return id;
}

function toJid(phoneOrJid) {
  const value = String(phoneOrJid || "");
  if (value.includes("@")) return value;
  return `${value.replace(/\D/g, "")}@s.whatsapp.net`;
}

/**
 * WhatsApp esta migrando a LIDs: remoteJid llega como "1234567@lid", que no es
 * un telefono. El numero real viene en remoteJidAlt. Sin esto el lead se
 * guardaba con un identificador anonimo y la respuesta no llegaba a nadie.
 */
function resolveAddressing(key = {}) {
  const remoteJid = key.remoteJid || "";
  const alt = key.remoteJidAlt || "";
  const isLid = remoteJid.endsWith("@lid");
  const phoneJid = isLid ? (alt.endsWith("@s.whatsapp.net") ? alt : "") : remoteJid;

  if (isLid && !phoneJid) {
    console.warn("[baileys] mensaje con LID sin numero asociado; se respondera al LID", { remoteJid });
  }

  return {
    // Para responder preferimos el JID con telefono; si no hay, el LID sirve.
    jid: phoneJid || remoteJid,
    phoneJid,
    lid: isLid ? remoteJid : ""
  };
}

function jidToPhone(jid) {
  return String(jid || "").split("@")[0].replace(/\D/g, "");
}

function cleanSessionPhone(phone) {
  return String(phone || "").split(":")[0] || null;
}

export async function downloadBaileysMedia(message, sessionId = config.baileysSessionId) {
  const sock = requireSock(sessionId);
  return downloadMediaMessage(message, "buffer", {}, { logger, reuploadRequest: sock.updateMediaMessage });
}
