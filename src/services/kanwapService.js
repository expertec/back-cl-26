import { config } from "../config.js";
import { normalizePhone } from "../schemas.js";

function requireKanwapConfig() {
  if (!config.kanwapApiKey) throw new Error("Falta KANWAP_API_KEY.");
  if (!config.kanwapSessionId) throw new Error("Falta KANWAP_SESION_ID.");
}

async function kanwapFetch(path, options = {}) {
  requireKanwapConfig();

  const response = await fetch(`${config.kanwapApiUrl}${path}`, {
    ...options,
    headers: {
      "X-API-Key": config.kanwapApiKey,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.exito === false) {
    throw new Error(payload.mensaje || `KanWap respondio HTTP ${response.status}.`);
  }

  return payload;
}

export async function verifyKanwapSession() {
  const payload = await kanwapFetch(`/api/v1/sesion/${config.kanwapSessionId}/estado`);
  const estado = payload.datos?.estado;
  if (estado !== "conectada") {
    throw new Error(`La sesion de KanWap no esta conectada: ${estado || "desconocido"}.`);
  }
  return payload.datos;
}

export async function sendKanwapText({ phone, message }) {
  return kanwapFetch("/api/v1/enviar/texto", {
    method: "POST",
    body: JSON.stringify({
      sesionId: config.kanwapSessionId,
      destino: normalizePhone(phone),
      mensaje: message
    })
  });
}

export async function sendKanwapAudio({ phone, audioUrl }) {
  return kanwapFetch("/api/v1/enviar/audio", {
    method: "POST",
    body: JSON.stringify({
      sesionId: config.kanwapSessionId,
      destino: normalizePhone(phone),
      audio: audioUrl
    })
  });
}

export async function sendSongWithKanwap(song) {
  await verifyKanwapSession();

  const greetingName = song.customerName?.split(" ")[0] || song.recipientName || "";
  const lyricsMessage = [
    greetingName ? `Hola ${greetingName}.` : "Hola.",
    `Ya tenemos lista la cancion "${song.title}".`,
    "",
    "Letra:",
    "",
    song.lyrics
  ].join("\n");

  const intro = "Ahora escucha el clip con marca de agua.";

  const textResult = await sendKanwapText({
    phone: song.leadPhone,
    message: lyricsMessage
  });

  await sendKanwapText({
    phone: song.leadPhone,
    message: intro
  });

  const audioResult = await sendKanwapAudio({
    phone: song.leadPhone,
    audioUrl: song.clipUrl
  });

  return {
    textMessageId: textResult.datos?.mensajeId || null,
    audioMessageId: audioResult.datos?.mensajeId || null
  };
}
