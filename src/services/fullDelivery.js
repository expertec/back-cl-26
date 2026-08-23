import { db, FieldValue } from "../firebase.js";
import { logEvent } from "./eventLog.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "./songConversation/constants.js";
import { setConversationStage } from "./songConversation/conversationState.js";
import { sendAudio, sendDocument, sendText } from "./whatsapp/index.js";
import { logOutboundMedia } from "./conversationLog.js";

const MUSIC_COLLECTION = "musica";

/**
 * Entrega la cancion completa, sin marca de agua, cuando el cliente ya pago.
 * Los archivos ya existen desde que se produjo la muestra: lo que faltaba era
 * poder mandarlos y dejar constancia de la venta.
 */
export async function deliverFullSong({ musicId, version = 1, actor }) {
  const ref = db.collection(MUSIC_COLLECTION).doc(musicId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Pedido no encontrado.");

  const song = { id: snap.id, ...snap.data() };
  const versions = normalizeFullVersions(song);
  if (!versions.length) throw new Error("Este pedido todavia no tiene la version completa.");

  const chosen = versions.find((item) => item.version === Number(version)) || versions[0];
  const phone = song.leadWaJid || song.leadPhone || song.phone;
  if (!phone) throw new Error("El pedido no tiene telefono.");

  const nombre = String(song.customerName || "").trim().split(/\s+/)[0];
  const titulo = song.title || "tu cancion";

  await sendText({
    phone,
    message: [
      nombre ? `¡Gracias ${nombre}!` : "¡Gracias!",
      "",
      `Aqui esta "${titulo}" completa, sin marca de agua y en alta calidad.`
    ].join("\n"),
    idempotencyKey: `${musicId}-full-intro-v${chosen.version}`
  });

  // Se manda dos veces a proposito: como audio se escucha en el chat, y como
  // documento se puede guardar y compartir sin que WhatsApp lo recomprima.
  await sendAudio({
    phone,
    audioUrl: chosen.fullUrl,
    mimetype: "audio/mpeg",
    idempotencyKey: `${musicId}-full-audio-v${chosen.version}`
  });

  await sendDocument({
    phone,
    url: chosen.fullUrl,
    filename: `${sanitizeFilename(titulo)}.mp3`,
    mimetype: "audio/mpeg",
    caption: "Tu cancion para descargar y compartir"
  });

  await logOutboundMedia({
    conversationId: song.conversationId,
    text: `Cancion completa entregada: "${titulo}" (version ${chosen.version})`,
    mediaUrl: chosen.fullUrl,
    meta: { musicId, fullVersion: chosen.version }
  });

  await ref.update({
    fullDeliveredAt: FieldValue.serverTimestamp(),
    fullDeliveredVersion: chosen.version,
    fullDeliveredBy: actor?.email || null,
    paid: true,
    paidAt: song.paidAt || FieldValue.serverTimestamp(),
    status: "Entregada completa",
    updatedAt: FieldValue.serverTimestamp()
  });

  await markSaleWon(song, chosen.version);

  logEvent({
    level: "warn",
    scope: "venta",
    message: `Cancion completa entregada (version ${chosen.version})`,
    musicId,
    leadId: song.leadId,
    phone: song.leadPhone,
    detail: actor?.email || null
  });

  return { version: chosen.version, url: chosen.fullUrl };
}

async function markSaleWon(song, version) {
  if (!song.leadId) return;

  try {
    await db.collection(COLLECTIONS.leads).doc(song.leadId).update({
      kanbanStage: "won",
      soldAt: FieldValue.serverTimestamp(),
      chosenVersion: version,
      updatedAt: FieldValue.serverTimestamp()
    });

    if (song.songOrderId) {
      await db.collection(COLLECTIONS.songOrders).doc(song.songOrderId).update({
        musicStatus: "delivered_full",
        chosenVersion: version,
        updatedAt: FieldValue.serverTimestamp()
      });
    }

    if (song.conversationId) {
      await setConversationStage({
        conversationRef: db.collection(COLLECTIONS.conversations).doc(song.conversationId),
        leadRef: db.collection(COLLECTIONS.leads).doc(song.leadId),
        stage: CONVERSATION_STAGES.SAMPLES_SENT
      });
    }
  } catch (error) {
    // La cancion ya se entrego: un fallo de CRM no debe deshacer eso.
    console.error("[venta] no se pudo marcar como ganada", { musicId: song.id, error: error.message });
  }
}

function normalizeFullVersions(song) {
  if (Array.isArray(song.fullVersions) && song.fullVersions.length) {
    return song.fullVersions
      .filter((item) => item?.fullUrl)
      .map((item, index) => ({ version: Number(item.version || index + 1), fullUrl: item.fullUrl }));
  }

  if (Array.isArray(song.fullUrls) && song.fullUrls.length) {
    return song.fullUrls.filter(Boolean).map((fullUrl, index) => ({ version: index + 1, fullUrl }));
  }

  return song.fullUrl ? [{ version: 1, fullUrl: song.fullUrl }] : [];
}

function sanitizeFilename(value) {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .slice(0, 60) || "cancion";
}
