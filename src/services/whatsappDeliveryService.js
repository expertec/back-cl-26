import { config } from "../config.js";
import { sendSongWithKanwap } from "./kanwapService.js";
import { sendSongWithVevWhatsapp } from "./vevWhatsappService.js";
import { sendAudio, sendText } from "./whatsapp/index.js";
import { logOutboundMedia } from "./conversationLog.js";

export async function sendSongWithWhatsapp(song, options = {}) {
  if (config.whatsappProvider === "baileys") {
    return sendSongWithBaileys(song, options);
  }

  if (config.whatsappProvider === "vev") {
    return sendSongWithVevWhatsapp(song);
  }

  return sendSongWithKanwap(song);
}

async function sendSongWithBaileys(song, { idempotencySuffix = "" } = {}) {
  const clipUrls = getClipUrls(song);
  const keySuffix = idempotencySuffix ? `-${idempotencySuffix}` : "";
  const greetingName = song.customerName?.split(" ")[0] || song.recipientName || "";
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

  await sendText({
    phone: song.leadPhone,
    message: lyricsMessage,
    idempotencyKey: `${song.id}-lyrics${keySuffix}`
  });

  await logOutboundMedia({
    conversationId: song.conversationId,
    text: lyricsMessage,
    mediaType: "text",
    meta: { musicId: song.id }
  });

  await sendText({
    phone: song.leadPhone,
    message: intro,
    idempotencyKey: `${song.id}-intro${keySuffix}`
  });

  const audioResults = [];

  for (const [index, clipUrl] of clipUrls.entries()) {
    if (clipUrls.length > 1) {
      await sendText({
        phone: song.leadPhone,
        message: `Version ${index + 1}:`,
        idempotencyKey: `${song.id}-version-${index + 1}-label${keySuffix}`
      });
    }

    const audioResult = await sendAudio({
      phone: song.leadPhone,
      audioUrl: clipUrl,
      idempotencyKey: `${song.id}-clip-${index + 1}${keySuffix}`
    });

    await logOutboundMedia({
      conversationId: song.conversationId,
      text: `Muestra ${index + 1} de "${song.title || "tu cancion"}"`,
      mediaUrl: clipUrl,
      meta: { musicId: song.id, sample: index + 1 }
    });

    audioResults.push(audioResult);
  }

  return {
    provider: "baileys",
    audioMessageIds: audioResults.map((result) => result?.key?.id || null)
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
