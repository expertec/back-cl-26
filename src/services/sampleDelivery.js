import { db, FieldValue } from "../firebase.js";
import { logEvent } from "./eventLog.js";
import { markSongDelivered } from "./songProduction.js";
import { sendSongWithWhatsapp } from "./whatsappDeliveryService.js";

const MUSIC_COLLECTION = "musica";

/**
 * Reenvia manualmente las muestras que ya fueron generadas. Se usa cuando el
 * envio automatico fallo porque la sesion de WhatsApp/Baileys se desconecto.
 */
export async function deliverSongSamples({ musicId, actor }) {
  const ref = db.collection(MUSIC_COLLECTION).doc(musicId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Pedido no encontrado.");

  const song = { id: snap.id, ...snap.data() };
  const clipUrls = getClipUrls(song);
  const leadPhone = song.leadWaJid || song.leadPhone || song.phone;

  if (!leadPhone) throw new Error("El pedido no tiene telefono.");
  if (!song.lyrics) throw new Error("Este pedido todavia no tiene letra.");
  if (!clipUrls.length) throw new Error("Este pedido todavia no tiene muestras.");

  await ref.update({
    status: "Enviando musica",
    manualSamplesSendingAt: FieldValue.serverTimestamp(),
    manualSamplesSentBy: actor?.email || null,
    sendAttemptCount: FieldValue.increment(1),
    updatedAt: FieldValue.serverTimestamp()
  });

  try {
    const delivery = await sendSongWithWhatsapp(
      {
        ...song,
        leadPhone,
        clipUrls
      },
      { idempotencySuffix: `manual-${Date.now()}` }
    );

    await ref.update({
      status: "Enviada",
      sentAt: FieldValue.serverTimestamp(),
      manualSamplesSentAt: FieldValue.serverTimestamp(),
      manualSamplesError: FieldValue.delete(),
      errorMsg: FieldValue.delete(),
      delivery,
      updatedAt: FieldValue.serverTimestamp()
    });

    await markSongDelivered({ ...song, leadPhone, clipUrls });

    logEvent({
      level: "warn",
      scope: "admin",
      message: "Muestras enviadas manualmente",
      musicId,
      leadId: song.leadId,
      phone: leadPhone,
      detail: actor?.email || null
    });

    return { sent: true, clips: clipUrls.length };
  } catch (error) {
    await ref.update({
      status: "Error envio",
      errorMsg: error.message,
      manualSamplesError: error.message,
      errorAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    throw error;
  }
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
