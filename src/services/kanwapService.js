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
    message: lyricsMessage
  });

  await sendKanwapText({
    phone: song.leadPhone,
    message: intro
  });

  const audioResults = [];

  for (const [index, clipUrl] of clipUrls.entries()) {
    if (clipUrls.length > 1) {
      await sendKanwapText({
        phone: song.leadPhone,
        message: `Version ${index + 1}:`
      });
    }

    const audioResult = await sendKanwapAudio({
      phone: song.leadPhone,
      audioUrl: clipUrl
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
