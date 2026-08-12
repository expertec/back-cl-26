import { config } from "../config.js";
import { normalizePhone } from "../schemas.js";

const KANWAP_TIMEOUT_MS = 35000;
const SEND_RETRY_DELAYS_MS = [1500, 3500, 7000];

function requireKanwapConfig() {
  if (!config.kanwapApiKey) throw new Error("Falta KANWAP_API_KEY.");
  if (!config.kanwapSessionId) throw new Error("Falta KANWAP_SESION_ID.");
}

function buildKanwapUrl(path) {
  const baseUrl = config.kanwapApiUrl.replace(/\/+$/, "");
  const apiPath = path.startsWith("/api/v1/") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;

  if (baseUrl.endsWith("/api/v1")) {
    return `${baseUrl}${apiPath.replace(/^\/api\/v1/, "")}`;
  }

  return `${baseUrl}${apiPath}`;
}

async function kanwapFetch(path, options = {}) {
  requireKanwapConfig();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KANWAP_TIMEOUT_MS);

  try {
    const response = await fetch(buildKanwapUrl(path), {
      ...options,
      signal: controller.signal,
      headers: {
        "X-API-Key": config.kanwapApiKey,
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });

    const payload = await response.json().catch(() => ({}));

    if (response.status === 409 && payload.enCurso) {
      const error = new Error(payload.mensaje || "Mensaje KanWap en curso.");
      error.enCurso = true;
      throw error;
    }

    if (!response.ok || payload.exito === false) {
      throw new Error(payload.mensaje || `KanWap respondio HTTP ${response.status}.`);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function sendWithRetry(path, body) {
  let lastError;

  for (let attempt = 0; attempt <= SEND_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await kanwapFetch(path, {
        method: "POST",
        body: JSON.stringify(body)
      });
    } catch (error) {
      lastError = error;
      const canRetry = error.name === "AbortError" || error.enCurso;
      if (!canRetry || attempt === SEND_RETRY_DELAYS_MS.length) break;
      await sleep(SEND_RETRY_DELAYS_MS[attempt]);
    }
  }

  throw lastError;
}

export async function verifyKanwapSession() {
  const payload = await kanwapFetch(`/api/v1/sesion/${config.kanwapSessionId}/estado`);
  const estado = payload.datos?.estado;
  if (estado !== "conectada") {
    throw new Error(`La sesion de KanWap no esta conectada: ${estado || "desconocido"}.`);
  }
  return payload.datos;
}

export async function sendKanwapText({ phone, message, idempotencyKey }) {
  return sendWithRetry("/api/v1/enviar/texto", {
    sesionId: config.kanwapSessionId,
    destino: normalizePhone(phone),
    mensaje: message,
    ...(idempotencyKey ? { idempotencyKey } : {})
  });
}

export async function sendKanwapAudio({ phone, audioUrl, idempotencyKey }) {
  return sendWithRetry("/api/v1/enviar/audio", {
    sesionId: config.kanwapSessionId,
    destino: normalizePhone(phone),
    audio: audioUrl,
    ...(idempotencyKey ? { idempotencyKey } : {})
  });
}

export async function sendSongWithKanwap(song) {
  await verifyKanwapSession();

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
      ? `Ahora escucha las ${clipUrls.length} versiones con marca de agua.`
      : "Ahora escucha el clip con marca de agua.";

  const textResult = await sendKanwapText({
    phone: song.leadPhone,
    message: lyricsMessage,
    idempotencyKey: `${song.id}-lyrics`
  });

  await sendKanwapText({
    phone: song.leadPhone,
    message: intro,
    idempotencyKey: `${song.id}-intro`
  });

  const audioResults = [];

  for (const [index, clipUrl] of clipUrls.entries()) {
    if (clipUrls.length > 1) {
      await sendKanwapText({
        phone: song.leadPhone,
        message: `Version ${index + 1}:`,
        idempotencyKey: `${song.id}-version-${index + 1}-label`
      });
    }

    const audioResult = await sendKanwapAudio({
      phone: song.leadPhone,
      audioUrl: clipUrl,
      idempotencyKey: `${song.id}-clip-${index + 1}`
    });

    audioResults.push(audioResult);
  }

  return {
    textMessageId: textResult.datos?.mensajeId || null,
    audioMessageId: audioResults[0]?.datos?.mensajeId || null,
    audioMessageIds: audioResults.map((result) => result.datos?.mensajeId || null)
  };
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
