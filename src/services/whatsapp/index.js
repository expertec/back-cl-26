import crypto from "node:crypto";
import { config } from "../../config.js";
import { normalizePhone } from "../../schemas.js";
import { sendKanwapAudio, sendKanwapText } from "../kanwapService.js";
import { sendVevDocument, sendVevText } from "../vevWhatsappService.js";

export async function sendText({ phone, message, idempotencyKey }) {
  if (config.whatsappProvider === "vev") {
    return sendVevText({ phone, message, idempotencyKey });
  }

  return sendKanwapText({ phone, message, idempotencyKey });
}

export async function sendAudio({ phone, audioUrl, idempotencyKey, caption }) {
  if (config.whatsappProvider === "vev") {
    return sendVevDocument({
      phone,
      url: audioUrl,
      filename: "cantalab-audio.m4a",
      mimetype: "audio/mp4",
      caption
    });
  }

  return sendKanwapAudio({ phone, audioUrl, idempotencyKey });
}

export async function sendDocument({ phone, url, filename, mimetype, caption }) {
  if (config.whatsappProvider === "vev") {
    return sendVevDocument({ phone, url, filename, mimetype, caption });
  }

  return sendText({
    phone,
    message: [caption, filename, url].filter(Boolean).join("\n")
  });
}

export async function sendImage({ phone, imageUrl, caption }) {
  return sendText({
    phone,
    message: [caption || "Imagen", imageUrl].filter(Boolean).join("\n")
  });
}

export async function markAsRead() {
  return { ok: true, skipped: true };
}

export function normalizeIncomingMessage(payload = {}) {
  const nested = payload.message || payload.data || payload.datos || payload;
  const from =
    nested.from ||
    nested.phone ||
    nested.telefono ||
    nested.sender ||
    nested.remoteJid ||
    nested.contact?.phone ||
    payload.from;
  const text =
    nested.text ||
    nested.body ||
    nested.messageText ||
    nested.conversation ||
    nested.message?.text ||
    nested.message?.conversation ||
    payload.text ||
    payload.body;
  const providerMessageId =
    nested.id ||
    nested.messageId ||
    nested.mensajeId ||
    nested.key?.id ||
    payload.id ||
    payload.messageId;
  const phone = normalizePhone(from);
  const hash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);

  return {
    provider: String(payload.provider || config.whatsappProvider || "unknown").toLowerCase(),
    messageId: String(providerMessageId || `${phone}-${hash}`),
    phone,
    text: typeof text === "string" ? text.trim() : "",
    contactName: nested.name || nested.pushName || nested.contact?.name || payload.name || "",
    timestamp: nested.timestamp || payload.timestamp || Date.now(),
    raw: payload
  };
}
