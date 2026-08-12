import { config } from "../config.js";
import { normalizePhone } from "../schemas.js";

const VEV_TIMEOUT_MS = 120000;
const SEND_RETRY_DELAYS_MS = [1500, 3500, 7000];

function requireVevConfig() {
  if (!config.vevWhatsappToken) throw new Error("Falta VEV_WHATSAPP_TOKEN.");
  if (!config.vevNegocioId) throw new Error("Falta VEV_NEGOCIO_ID.");
}

function buildVevUrl(path) {
  const baseUrl = config.vevWhatsappApiUrl.replace(/\/+$/, "");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function vevFetch(path, body) {
  requireVevConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VEV_TIMEOUT_MS);

  try {
    const response = await fetch(buildVevUrl(path), {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-negocio-id": config.vevNegocioId,
        Authorization: `Bearer ${config.vevWhatsappToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || payload.ok === false || payload.success === false || payload.error) {
      const message = payload.error?.message || payload.error || payload.message || `Vev WhatsApp respondio HTTP ${response.status}.`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWithRetry(body) {
  let lastError;

  for (let attempt = 0; attempt <= SEND_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await vevFetch("/api/wa/v1/messages", body);
    } catch (error) {
      lastError = error;
      if (error.name !== "AbortError" || attempt === SEND_RETRY_DELAYS_MS.length) break;
      await sleep(SEND_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

export async function sendVevText({ phone, message }) {
  return sendWithRetry({
    to: normalizePhone(phone),
    type: "text",
    text: message
  });
}

export async function sendVevDocument({ phone, url, filename, mimetype, caption }) {
  return sendWithRetry({
    to: normalizePhone(phone),
    type: "document",
    media: { url },
    filename,
    mimetype,
    ...(caption ? { caption } : {})
  });
}

export async function sendSongWithVevWhatsapp(song) {
  const greetingName = song.customerName?.split(" ")[0] || song.recipientName || "";
  const clipUrls = getClipUrls(song);
  const lyricsMessage = [
    greetingName ? `Hola ${greetingName}.` : "Hola.",
    `Ya tenemos lista la cancion "${song.title}".`,
    "",
    "Letra:",
    "",
    song.lyrics
  ].join("\n");

  const intro =
    clipUrls.length > 1
      ? `Ahora te enviamos las ${clipUrls.length} versiones con marca de agua.`
      : "Ahora te enviamos el clip con marca de agua.";

  const textResult = await sendVevText({
    phone: song.leadPhone,
    message: lyricsMessage
  });

  await sendVevText({
    phone: song.leadPhone,
    message: intro
  });

  const documentResults = [];

  for (const [index, clipUrl] of clipUrls.entries()) {
    const version = index + 1;
    const documentResult = await sendVevDocument({
      phone: song.leadPhone,
      url: clipUrl,
      filename: `${safeFilename(song.title || "cancion")}-version-${version}.m4a`,
      mimetype: "audio/mp4",
      caption: clipUrls.length > 1 ? `Version ${version}` : "Clip con marca de agua"
    });

    documentResults.push(documentResult);
  }

  return {
    provider: "vev-whatsapp",
    textMessageId: extractMessageId(textResult),
    audioMessageId: extractMessageId(documentResults[0]),
    audioMessageIds: documentResults.map(extractMessageId),
    raw: {
      text: textResult,
      documents: documentResults
    }
  };
}

function extractMessageId(payload) {
  return payload?.messageId || payload?.id || payload?.data?.messageId || payload?.datos?.mensajeId || null;
}

function getClipUrls(song) {
  if (Array.isArray(song.clipVersions) && song.clipVersions.length) {
    return song.clipVersions.map((item) => item?.clipUrl).filter(Boolean).slice(0, 2);
  }

  if (Array.isArray(song.clipUrls) && song.clipUrls.length) {
    return song.clipUrls.filter(Boolean).slice(0, 2);
  }

  return song.clipUrl ? [song.clipUrl] : [];
}

function safeFilename(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .toLowerCase();
}
