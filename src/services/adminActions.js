import { db, FieldValue } from "../firebase.js";
import { logEvent } from "./eventLog.js";
import { createLyrics } from "./openaiService.js";
import { startSongProduction } from "./songProduction.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "./songConversation/constants.js";
import { setConversationStage } from "./songConversation/conversationState.js";
import { buildSongForLyrics } from "./songConversation/songBrief.js";
import { sendText } from "./whatsapp/index.js";

/**
 * Acciones manuales para destrabar una conversacion desde el panel. Todas
 * avisan al cliente por WhatsApp: si un humano interviene, el cliente tiene que
 * ver que algo paso, no quedarse esperando en silencio.
 */
export async function forceGenerateLyrics(leadId) {
  const context = await loadContext(leadId);
  const { order, orderRef, lead } = context;

  if (order.lyrics) throw new Error("Este pedido ya tiene letra. Usa 'aprobar y producir'.");

  const lyrics = await createLyrics(buildSongForLyrics(order, lead));
  const version = Number(order.lyricsVersion || 0) + 1;

  await orderRef.update({
    lyrics,
    lyricsApproved: false,
    lyricsVersion: version,
    lyricVersions: FieldValue.arrayUnion({
      version,
      lyrics,
      createdAt: new Date().toISOString(),
      source: "manual"
    }),
    lyricsGenerationLock: FieldValue.delete(),
    musicStatus: "lyrics_ready",
    updatedAt: FieldValue.serverTimestamp()
  });

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL
  });

  await notify(context, ["Ya tengo lista tu letra:", "", lyrics, "", "¿La dejamos asi y produzco la musica?"].join("\n"));

  logEvent({ level: "warn", scope: "admin", message: "Letra generada manualmente", leadId, phone: lead.phone });
  return { lyricsVersion: version };
}

export async function forceApproveAndProduce(leadId) {
  const context = await loadContext(leadId);
  const { order, orderRef, lead } = context;

  if (!order.lyrics) throw new Error("Todavia no hay letra que aprobar.");
  if (order.musicId) throw new Error("La produccion ya habia arrancado.");

  await orderRef.update({
    lyricsApproved: true,
    lyricsApprovedAt: FieldValue.serverTimestamp(),
    musicStatus: "lyrics_approved",
    lyricsRevisionLock: FieldValue.delete(),
    lyricsGenerationLock: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  });

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.PRODUCING_SONG
  });

  await notify(context, "Dejamos la letra asi. Ya estoy produciendo la musica, en unos minutos te la mando.");

  const result = await startSongProduction({
    order: { ...order, lyricsApproved: true },
    orderRef,
    lead,
    leadId,
    conversationId: context.conversationRef.id
  });

  logEvent({
    level: "warn",
    scope: "admin",
    message: "Aprobacion y produccion forzadas",
    leadId,
    phone: lead.phone,
    detail: result
  });

  return result;
}

export async function forceProduce(leadId) {
  const context = await loadContext(leadId);
  const { order, orderRef, lead } = context;

  if (!order.lyrics) throw new Error("No hay letra para producir.");

  if (!order.lyricsApproved) {
    await orderRef.update({ lyricsApproved: true, updatedAt: FieldValue.serverTimestamp() });
    order.lyricsApproved = true;
  }

  const result = await startSongProduction({
    order,
    orderRef,
    lead,
    leadId,
    conversationId: context.conversationRef.id
  });

  if (!result.started) throw new Error(`No se pudo arrancar la produccion: ${result.reason}`);

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.PRODUCING_SONG
  });

  logEvent({ level: "warn", scope: "admin", message: "Produccion forzada", leadId, phone: lead.phone });
  return result;
}

export async function releaseConversationLocks(leadId) {
  const { orderRef, lead } = await loadContext(leadId);

  await orderRef.update({
    lyricsGenerationLock: FieldValue.delete(),
    lyricsRevisionLock: FieldValue.delete(),
    productionLock: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  });

  logEvent({ level: "warn", scope: "admin", message: "Locks liberados manualmente", leadId, phone: lead.phone });
  return { released: true };
}

export async function sendManualMessage(leadId, message) {
  const text = String(message || "").trim();
  if (!text) throw new Error("El mensaje viene vacio.");

  const context = await loadContext(leadId);
  await notify(context, text);

  logEvent({ level: "info", scope: "admin", message: "Mensaje manual enviado", leadId, phone: context.lead.phone, detail: text });
  return { sent: true };
}

async function loadContext(leadId) {
  const leadRef = db.collection(COLLECTIONS.leads).doc(leadId);
  const leadSnap = await leadRef.get();
  if (!leadSnap.exists) throw new Error("Lead no encontrado.");

  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("leadId", "==", leadId)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (conversationSnap.empty) throw new Error("Este lead no tiene una conversacion activa.");

  const conversationRef = conversationSnap.docs[0].ref;
  const conversation = conversationSnap.docs[0].data();
  const orderRef = db.collection(COLLECTIONS.songOrders).doc(conversation.songOrderId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new Error("El pedido de este lead no existe.");

  return {
    leadRef,
    lead: { id: leadId, ...leadSnap.data() },
    conversationRef,
    conversation,
    orderRef,
    order: orderSnap.data()
  };
}

async function notify(context, message) {
  const delivery = await sendText({
    phone: context.lead.waJid || context.lead.phone,
    message,
    idempotencyKey: `manual-${context.conversationRef.id}-${Date.now()}`
  });

  await db.collection(COLLECTIONS.conversations).doc(context.conversationRef.id).collection("messages").add({
    direction: "out",
    text: message,
    manual: true,
    createdAt: FieldValue.serverTimestamp()
  });

  await context.conversationRef.update({
    lastBotReply: message,
    lastBotReplyAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return delivery;
}
