import { config } from "../config.js";
import { db, FieldValue } from "../firebase.js";
import { normalizePhone } from "../schemas.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "./songConversation/constants.js";
import { setConversationStage } from "./songConversation/conversationState.js";
import { buildSongForLyrics } from "./songConversation/songBrief.js";

const MUSIC_COLLECTION = "musica";

/**
 * Puente entre la conversacion de WhatsApp y el pipeline de musica.
 * La conversacion vive en `songOrders`; el pipeline solo lee `musica`.
 * Al aprobar la letra creamos aqui el pedido que el pipeline sabe procesar.
 */
export async function startSongProduction({ order, orderRef, lead, leadId, conversationId }) {
  const lock = await lockOrderForProduction(orderRef);
  if (!lock.locked) {
    console.log("[production] start skipped", { songOrderId: orderRef.id, reason: lock.reason });
    return { started: false, reason: lock.reason, musicId: lock.musicId || null };
  }

  try {
    // La fuente de verdad es el snapshot de la transaccion: el `order` en memoria
    // puede venir de antes de la ultima revision de letra.
    const freshOrder = { ...order, ...lock.order };
    const brief = buildSongForLyrics(freshOrder, lead);
    const leadPhone = normalizePhone(freshOrder.phone || lead.phone);

    // Entra como "Sin prompt" y no "Sin letra": la letra ya fue aprobada por el
    // cliente y el pipeline la reescribiria con OpenAI si arrancara desde cero.
    const musicRef = await db.collection(MUSIC_COLLECTION).add({
      ...brief,
      phone: leadPhone,
      leadPhone,
      lyrics: freshOrder.lyrics,
      lyricsSource: "whatsapp-conversation",
      lyricsVersion: Number(freshOrder.lyricsVersion || 1),
      status: "Sin prompt",
      source: "whatsapp-bot",
      deliveryProvider: config.whatsappProvider,
      leadId,
      conversationId,
      songOrderId: orderRef.id,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    await orderRef.update({
      musicId: musicRef.id,
      musicStatus: "producing",
      productionLock: FieldValue.delete(),
      productionStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    console.log("[production] started", {
      songOrderId: orderRef.id,
      musicId: musicRef.id,
      leadPhone,
      title: brief.title
    });

    // El cron lo tomaria en <=1 min, pero disparamos ya para no hacer esperar al lead.
    const { runMusicPipeline } = await import("../jobs/musicPipeline.js");
    runMusicPipeline().catch((error) => {
      console.error("[production] pipeline trigger failed", { musicId: musicRef.id, error: error.message });
    });

    return { started: true, musicId: musicRef.id };
  } catch (error) {
    await orderRef.update({
      productionLock: FieldValue.delete(),
      musicStatus: "production_error",
      productionError: error.message,
      updatedAt: FieldValue.serverTimestamp()
    });
    throw error;
  }
}

/**
 * Se llama cuando el pipeline ya envio los clips por WhatsApp, para devolver
 * el estado al CRM: sin esto el lead se queda congelado en "Creando cancion".
 */
export async function markSongDelivered(song) {
  if (!song?.songOrderId) return { updated: false, reason: "no-song-order" };

  try {
    const orderRef = db.collection(COLLECTIONS.songOrders).doc(song.songOrderId);
    await orderRef.update({
      musicStatus: "samples_sent",
      clipUrls: song.clipUrls || [],
      fullUrls: song.fullUrls || [],
      samplesSentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    if (song.conversationId && song.leadId) {
      await setConversationStage({
        conversationRef: db.collection(COLLECTIONS.conversations).doc(song.conversationId),
        leadRef: db.collection(COLLECTIONS.leads).doc(song.leadId),
        stage: CONVERSATION_STAGES.SAMPLES_SENT
      });
    }

    console.log("[production] delivered", {
      musicId: song.id,
      songOrderId: song.songOrderId,
      clips: (song.clipUrls || []).length
    });

    return { updated: true };
  } catch (error) {
    // El audio ya se entrego; no queremos revertir el envio por un fallo de CRM.
    console.error("[production] delivered callback failed", {
      musicId: song.id,
      songOrderId: song.songOrderId,
      error: error.message
    });
    return { updated: false, reason: error.message };
  }
}

async function lockOrderForProduction(orderRef) {
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    if (!snap.exists) return { locked: false, reason: "missing-order" };

    const data = snap.data();
    if (data.musicId) return { locked: false, reason: "already-started", musicId: data.musicId };
    if (data.productionLock) return { locked: false, reason: "production-locked" };
    if (!data.lyrics) return { locked: false, reason: "no-lyrics" };
    if (!data.lyricsApproved) return { locked: false, reason: "lyrics-not-approved" };

    transaction.update(orderRef, {
      productionLock: true,
      updatedAt: FieldValue.serverTimestamp()
    });

    return { locked: true, order: data };
  });
}
