import { db, FieldValue } from "../firebase.js";
import { logEvent } from "./eventLog.js";
import { createLyrics } from "./openaiService.js";
import { startSongProduction } from "./songProduction.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "./songConversation/constants.js";
import { setConversationStage } from "./songConversation/conversationState.js";
import { buildSongForLyrics } from "./songConversation/songBrief.js";
import { getMissingFields } from "./songConversation/getMissingFields.js";
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

export async function sendManualMessage(leadId, message, replyToId) {
  const text = String(message || "").trim();
  if (!text) throw new Error("El mensaje viene vacio.");

  const context = await loadContext(leadId);
  const replyTo = replyToId ? await loadQuoted(context.conversationRef, replyToId) : null;

  await notify(context, text, replyTo);

  logEvent({ level: "info", scope: "admin", message: "Mensaje manual enviado", leadId, phone: context.lead.phone, detail: text });
  return { sent: true };
}

/**
 * Para citar, Baileys necesita el mensaje original tal como llego. Se guarda en
 * `raw` de cada mensaje, asi que se recupera de ahi junto con su texto, que es
 * lo que se muestra en la cita dentro del panel.
 */
async function loadQuoted(conversationRef, messageId) {
  const snap = await conversationRef.collection("messages").doc(messageId).get();
  if (!snap.exists) return null;

  const data = snap.data();
  const raw = data.raw;
  const quoted = raw?.key && raw?.message ? { key: raw.key, message: raw.message } : null;

  return { id: snap.id, text: data.text || "", direction: data.direction, quoted };
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

async function notify(context, message, replyTo = null) {
  const delivery = await sendText({
    phone: context.lead.waJid || context.lead.phone,
    message,
    idempotencyKey: `manual-${context.conversationRef.id}-${Date.now()}`,
    quoted: replyTo?.quoted || undefined
  });

  await db.collection(COLLECTIONS.conversations).doc(context.conversationRef.id).collection("messages").add({
    direction: "out",
    text: message,
    manual: true,
    ...(replyTo
      ? {
          replyToId: replyTo.id,
          replyToText: replyTo.text.slice(0, 180),
          replyToDirection: replyTo.direction
        }
      : {}),
    createdAt: FieldValue.serverTimestamp()
  });

  await context.conversationRef.update({
    lastBotReply: message,
    lastBotReplyAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return delivery;
}

/**
 * Devuelve al bot una conversacion que se paso al equipo. Sirve sobre todo para
 * las que quedaron atrapadas por errores ya corregidos: preguntar el precio o
 * pedir un segundo cambio de letra las mandaba con un asesor y ahi se quedaban.
 * El stage se recalcula desde lo que realmente hay, no desde donde quedo.
 */
export async function reactivateBot(leadId) {
  const context = await loadContext(leadId);
  const { order, orderRef, lead } = context;

  const tieneMuestras = Boolean(order.clipUrls?.length);
  const faltantes = getMissingFields(order);

  let stage;
  let reply;

  if (tieneMuestras) {
    stage = CONVERSATION_STAGES.SAMPLES_SENT;
    reply = "Perdona la demora. Aqui sigo por si quieres la version completa de tu cancion.";
  } else if (order.lyrics && !order.lyricsApproved) {
    stage = CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL;
    reply = [
      "Perdona la demora, retomo tu cancion.",
      "",
      "¿Quieres que ajuste algo mas de la letra, o la produzco asi y te la mando cantada?"
    ].join("\n");
  } else if (order.lyricsApproved) {
    stage = CONVERSATION_STAGES.PRODUCING_SONG;
    reply = "Perdona la demora. Retomo tu cancion y te la mando en cuanto este.";
  } else {
    stage = CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY;
    reply = [
      "Perdona la demora. Te hago tu muestra sin costo, solo me faltan unos datos.",
      "",
      faltantes.includes("recipient") ? "¿Para quien es la cancion?" : "¿Seguimos con tu cancion?"
    ].join("\n");
  }

  await Promise.all([
    context.leadRef.update({
      mode: "ai",
      reactivatedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }),
    context.conversationRef.update({ mode: "ai", updatedAt: FieldValue.serverTimestamp() }),
    // Sin limpiar esto, el primer cambio que pida vuelve a toparse con el tope.
    orderRef.update({
      revisionLimitNotifiedAt: FieldValue.delete(),
      lyricsRevisionLock: FieldValue.delete(),
      lyricsGenerationLock: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    })
  ]);

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage
  });

  await notify(context, reply);

  logEvent({
    level: "warn",
    scope: "admin",
    message: `Conversacion devuelta al bot en ${stage}`,
    leadId,
    phone: lead.phone
  });

  return { stage, faltantes };
}

/**
 * Segunda cancion en adelante. Un lead tenia un solo pedido de por vida, asi que
 * quien ya habia comprado y queria otra no tenia donde aterrizar: su historia
 * nueva caia sobre un pedido cerrado.
 *
 * Se mantiene la misma conversacion, porque en WhatsApp es el mismo hilo, y se
 * le cuelga un pedido nuevo. Lo que ya sabemos del cliente (su nombre, el genero
 * y la voz que eligio) se hereda: solo hay que preguntar para quien es y por que.
 */
export async function startNewSongOrder(leadId, { seedText = "" } = {}) {
  const context = await loadContext(leadId);
  const { order, lead, conversationRef } = context;

  if (!order.lyrics) throw new Error("Su pedido actual todavia no tiene letra; no hay nada que cerrar.");

  const previous = context.conversation.orderHistory || [];
  const nuevoRef = db.collection(COLLECTIONS.songOrders).doc();

  await nuevoRef.set({
    leadId,
    phone: lead.phone || "",
    // Se heredan las preferencias, no el pedido: la cancion es para otra persona.
    clientName: order.clientName || lead.name || "",
    genre: order.genre || "",
    referenceArtist: order.referenceArtist || "",
    voiceType: order.voiceType || "",
    purpose: "",
    recipient: "",
    relationship: "",
    nickname: "",
    story: "",
    specialDetails: "",
    lyrics: "",
    lyricsApproved: false,
    lyricsVersion: 0,
    lyricsRevisionCount: 0,
    fullUrls: [],
    clipUrls: [],
    musicStatus: "brief_open",
    orderNumber: previous.length + 2,
    previousOrderId: conversationRef.id ? context.conversation.songOrderId : null,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  await conversationRef.update({
    songOrderId: nuevoRef.id,
    orderHistory: FieldValue.arrayUnion(context.conversation.songOrderId),
    postponedAt: FieldValue.delete(),
    followUpSentAt: FieldValue.delete(),
    secondFollowUpSentAt: FieldValue.delete(),
    mode: "ai",
    updatedAt: FieldValue.serverTimestamp()
  });

  await context.leadRef.update({
    mode: "ai",
    // Ya es cliente, no un lead nuevo: el kanban no debe tratarlo como frio.
    esCliente: true,
    cancionesCompradas: FieldValue.increment(0),
    updatedAt: FieldValue.serverTimestamp()
  });

  await setConversationStage({
    conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY
  });

  const nombre = String(order.clientName || lead.name || "").trim().split(/\s+/)[0];
  const reply = [
    nombre ? `Con gusto, ${nombre}.` : "Con gusto.",
    "",
    "Vamos con tu siguiente cancion. ¿Para quien es y que ocasion celebramos?"
  ].join("\n");

  await notify(context, reply);

  logEvent({
    level: "warn",
    scope: "venta",
    message: `Nuevo pedido abierto (#${previous.length + 2})`,
    leadId,
    phone: lead.phone
  });

  return { songOrderId: nuevoRef.id, orderNumber: previous.length + 2, seedText: Boolean(seedText) };
}
