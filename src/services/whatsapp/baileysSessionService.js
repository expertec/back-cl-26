import fs from "node:fs";
import path from "node:path";
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  makeWASocket,
  useMultiFileAuthState as baileysUseMultiFileAuthState
} from "baileys";
import Pino from "pino";
import QRCode from "qrcode";
import { config } from "../../config.js";
import { getWhatsAppWebVersion } from "./baileysVersion.js";

const APPEND_MAX_AGE_MS = 5 * 60 * 1000;
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
    ensureRoot();
    const authDir = getAuthDir(id);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await baileysUseMultiFileAuthState(authDir);
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
        console.log("[baileys] connected", { sessionId: id, phone: session.phone || null });
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = reason === DisconnectReason.loggedOut || reason === 405;

        session.sock = null;

        if (loggedOut) {
          clearAuthDir(id);
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

        if (!session.reconnectTimer) {
          const delay = Math.floor(Math.random() * 8000) + 5000;
          session.reconnectTimer = setTimeout(() => {
            session.reconnectTimer = null;
            connectBaileysSession(id).catch((error) => {
              console.error("[baileys] reconnect failed", { sessionId: id, error: error.message });
            });
          }, delay);
        }
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

  clearAuthDir(id);
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
  ensureRoot();
  let restored = 0;

  for (const entry of fs.readdirSync(config.baileysSessionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const credsPath = path.join(config.baileysSessionsRoot, sessionId, "creds.json");
    if (!fs.existsSync(credsPath)) continue;

    try {
      sanitizeSessionId(sessionId);
    } catch {
      console.warn("[baileys] session folder ignored", { sessionId });
      continue;
    }

    restored += 1;
    setTimeout(() => {
      connectBaileysSession(sessionId).catch((error) => {
        console.error("[baileys] restore failed", { sessionId, error: error.message });
      });
    }, restored * 400);
  }

  console.log("[baileys] restoring sessions", { root: config.baileysSessionsRoot, restored });
  return restored;
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
  const jid = message.key.remoteJid || "";
  const text = extractMessageText(message.message);
  const messageId = message.key.id;
  const timestampMs = getMessageTimestampMs(message);

  return {
    provider: "baileys",
    sessionId,
    messageId,
    phone: jidToPhone(jid),
    text,
    contactName: message.pushName || "",
    timestamp: timestampMs,
    jid,
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

function ensureRoot() {
  if (!fs.existsSync(config.baileysSessionsRoot)) {
    fs.mkdirSync(config.baileysSessionsRoot, { recursive: true });
  }
}

function clearAuthDir(sessionId) {
  const authDir = getAuthDir(sessionId);
  if (!fs.existsSync(authDir)) return;

  for (const file of fs.readdirSync(authDir)) {
    fs.rmSync(path.join(authDir, file), { force: true, recursive: true });
  }
}

function getAuthDir(sessionId) {
  return path.join(config.baileysSessionsRoot, sanitizeSessionId(sessionId));
}

function sanitizeSessionId(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw new Error(`BAILEYS_SESSION_ID invalido: "${sessionId}"`);
  }
  return id;
}

function toJid(phone) {
  const raw = String(phone || "").trim();
  if (raw.includes("@")) return raw;
  const digits = raw.replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
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
