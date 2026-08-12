import crypto from "node:crypto";
import { db, FieldValue } from "../../firebase.js";
import { normalizePhone } from "../../schemas.js";
import { createLyrics, reviseLyrics } from "../openaiService.js";
import { sendText } from "../whatsapp/index.js";
import { COLLECTIONS, CONVERSATION_STAGES, INTENTS } from "./constants.js";
import { setConversationStage } from "./conversationState.js";
import { updateConversationSummary } from "./conversationSummary.js";
import { extractFields } from "./extractFields.js";
import { generateNextQuestion, selectNextField } from "./generateNextQuestion.js";
import { getMissingFields } from "./getMissingFields.js";

export async function processIncomingWhatsappMessage(incoming) {
  if (!incoming.phone || !incoming.text) {
    return { ok: false, skipped: true, reason: "missing-phone-or-text" };
  }

  const idempotency = await reserveIncomingMessage(incoming);
  if (!idempotency.reserved) {
    return { ok: true, duplicate: true, messageId: incoming.messageId };
  }

  try {
    const context = await getOrCreateConversationContext(incoming);
    await saveConversationMessage({
      conversationId: context.conversationRef.id,
      direction: "in",
      text: incoming.text,
      providerMessageId: incoming.messageId,
      raw: incoming.raw
    });

    await touchInboundContext(context, incoming);

    if (context.conversation.mode === "human") {
      await markIncomingProcessed(idempotency.ref, { context, autoReplied: false });
      return {
        ok: true,
        mode: "human",
        autoReplied: false,
        conversationId: context.conversationRef.id
      };
    }

    const result = await handleAiConversation({ context, incoming });
    await markIncomingProcessed(idempotency.ref, { context, autoReplied: Boolean(result.reply) });
    return result;
  } catch (error) {
    await idempotency.ref.update({
      status: "error",
      errorMsg: error.message,
      errorAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    throw error;
  }
}

export async function listKanbanLeads() {
  const snap = await db.collection(COLLECTIONS.leads).orderBy("lastMessageAt", "desc").limit(100).get();
  const leads = [];

  for (const leadDoc of snap.docs) {
    const lead = { id: leadDoc.id, ...leadDoc.data() };
    const conversationSnap = await db
      .collection(COLLECTIONS.conversations)
      .where("leadId", "==", leadDoc.id)
      .where("active", "==", true)
      .limit(1)
      .get();
    const conversationDoc = conversationSnap.docs[0];
    const conversation = conversationDoc ? { id: conversationDoc.id, ...conversationDoc.data() } : null;
    let order = null;

    if (conversation?.songOrderId) {
      const orderSnap = await db.collection(COLLECTIONS.songOrders).doc(conversation.songOrderId).get();
      if (orderSnap.exists) order = { id: orderSnap.id, ...orderSnap.data() };
    }

    leads.push({ lead, conversation, order });
  }

  return leads;
}

export async function updateLeadKanbanStage({ leadId, kanbanStage, mode }) {
  const updates = {
    kanbanStage,
    updatedAt: FieldValue.serverTimestamp()
  };

  if (mode) updates.mode = mode;

  await db.collection(COLLECTIONS.leads).doc(leadId).update(updates);

  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("leadId", "==", leadId)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (!conversationSnap.empty && mode) {
    await conversationSnap.docs[0].ref.update({
      mode,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
}

async function handleAiConversation({ context, incoming }) {
  const recentMessages = await getRecentMessages(context.conversationRef.id);
  const extraction = await extractFields({
    messageText: incoming.text,
    order: context.order,
    conversation: context.conversation,
    recentMessages
  });
  const orderUpdates = buildOrderUpdates(context.order, extraction.extractedFields);

  if (Object.keys(orderUpdates).length) {
    await context.orderRef.update({
      ...orderUpdates,
      updatedAt: FieldValue.serverTimestamp()
    });
    context.order = { ...context.order, ...orderUpdates };
  }

  const summary = await updateConversationSummary({
    previousSummary: context.conversation.summary || "",
    recentMessages,
    order: context.order
  });
  await context.conversationRef.update({
    summary,
    lastIntent: extraction.intent,
    lastExtractionConfidence: extraction.confidence,
    updatedAt: FieldValue.serverTimestamp()
  });
  context.conversation = {
    ...context.conversation,
    summary,
    lastIntent: extraction.intent
  };

  if (context.conversation.stage === CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL) {
    return handleLyricsApprovalIntent({ context, incoming, extraction });
  }

  if (extraction.intent === INTENTS.BUYING_SIGNAL) {
    await setConversationStage({
      conversationRef: context.conversationRef,
      leadRef: context.leadRef,
      stage: CONVERSATION_STAGES.READY_FOR_SALES
    });
    const reply = "Te paso con el equipo para ayudarte con la version completa.";
    await sendAndSaveReply({ context, incoming, reply, suffix: "sales-ready" });
    return buildResult(context, reply, CONVERSATION_STAGES.READY_FOR_SALES);
  }

  const missingFields = getMissingFields(context.order);
  if (missingFields.length) {
    return continueDiscovery({ context, incoming, missingFields });
  }

  return completeBriefAndGenerateLyrics({ context, incoming });
}

async function continueDiscovery({ context, incoming, missingFields }) {
  const nextField = selectNextField(missingFields, context.conversation.lastAskedFields || []);
  const reply = await generateNextQuestion({
    missingFields,
    order: context.order,
    conversation: context.conversation
  });

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY,
    extra: {
      missingFields,
      lastAskedFields: nextField ? FieldValue.arrayUnion(nextField) : FieldValue.delete()
    }
  });

  await sendAndSaveReply({ context, incoming, reply, suffix: `ask-${nextField || "missing"}` });
  return buildResult(context, reply, CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY, { missingFields });
}

async function completeBriefAndGenerateLyrics({ context, incoming }) {
  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.BRIEF_COMPLETE
  });

  const lock = await lockOrderForLyrics(context.orderRef);
  if (!lock.locked) {
    return buildResult(context, "", context.conversation.stage, { skipped: lock.reason });
  }

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.GENERATING_LYRICS
  });

  try {
    const song = buildSongForLyrics(context.order, context.lead);
    const lyrics = await createLyrics(song);
    const version = Number(context.order.lyricsVersion || 0) + 1;

    await context.orderRef.update({
      lyrics,
      lyricsApproved: false,
      lyricsVersion: version,
      lyricVersions: FieldValue.arrayUnion({
        version,
        lyrics,
        createdAt: new Date().toISOString(),
        source: "initial"
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

    const reply = buildLyricsApprovalMessage(lyrics);
    await sendAndSaveReply({ context, incoming, reply, suffix: `lyrics-v${version}` });
    return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
  } catch (error) {
    await context.orderRef.update({
      lyricsGenerationLock: FieldValue.delete(),
      musicStatus: "lyrics_error",
      lyricsError: error.message,
      updatedAt: FieldValue.serverTimestamp()
    });
    await context.conversationRef.update({
      lastError: error.message,
      updatedAt: FieldValue.serverTimestamp()
    });
    throw error;
  }
}

async function handleLyricsApprovalIntent({ context, incoming, extraction }) {
  if (extraction.intent === INTENTS.APPROVE_LYRICS) {
    await context.orderRef.update({
      lyricsApproved: true,
      lyricsApprovedAt: FieldValue.serverTimestamp(),
      musicStatus: "lyrics_approved",
      updatedAt: FieldValue.serverTimestamp()
    });
    await setConversationStage({
      conversationRef: context.conversationRef,
      leadRef: context.leadRef,
      stage: CONVERSATION_STAGES.LYRICS_APPROVED
    });
    const reply = "Perfecto, dejo la letra aprobada. El siguiente paso es producir la musica.";
    await sendAndSaveReply({ context, incoming, reply, suffix: "lyrics-approved" });
    return buildResult(context, reply, CONVERSATION_STAGES.LYRICS_APPROVED);
  }

  if (extraction.intent === INTENTS.REQUEST_LYRICS_CHANGE) {
    return reviseLyricsFromConversation({ context, incoming, extraction });
  }

  const reply = "¿La letra te gusta asi o quieres que cambie alguna parte?";
  await sendAndSaveReply({ context, incoming, reply, suffix: "lyrics-followup" });
  return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
}

async function reviseLyricsFromConversation({ context, incoming, extraction }) {
  const revisionInstruction = extraction.revisionInstruction || incoming.text;
  const lock = await lockOrderForRevision(context.orderRef);
  if (!lock.locked) {
    return buildResult(context, "", context.conversation.stage, { skipped: lock.reason });
  }

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.LYRICS_REVISION
  });

  try {
    const song = buildSongForLyrics(context.order, context.lead);
    const currentLyrics = context.order.lyrics || "";
    const lyrics = await reviseLyrics({ song, currentLyrics, revisionInstruction });
    const version = Number(context.order.lyricsVersion || 1) + 1;

    await context.orderRef.update({
      lyrics,
      lyricsApproved: false,
      lyricsVersion: version,
      lyricVersions: FieldValue.arrayUnion({
        version,
        lyrics,
        instruction: revisionInstruction,
        createdAt: new Date().toISOString(),
        source: "revision"
      }),
      lyricsRevisionLock: FieldValue.delete(),
      musicStatus: "lyrics_ready",
      updatedAt: FieldValue.serverTimestamp()
    });

    await setConversationStage({
      conversationRef: context.conversationRef,
      leadRef: context.leadRef,
      stage: CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL
    });

    const reply = buildLyricsApprovalMessage(lyrics, "Listo, ajuste la letra:");
    await sendAndSaveReply({ context, incoming, reply, suffix: `lyrics-revision-v${version}` });
    return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
  } catch (error) {
    await context.orderRef.update({
      lyricsRevisionLock: FieldValue.delete(),
      lyricsError: error.message,
      updatedAt: FieldValue.serverTimestamp()
    });
    throw error;
  }
}

async function getOrCreateConversationContext(incoming) {
  const phone = normalizePhone(incoming.phone);
  let leadRef;
  let lead;
  const leadSnap = await db.collection(COLLECTIONS.leads).where("phone", "==", phone).limit(1).get();

  if (leadSnap.empty) {
    leadRef = db.collection(COLLECTIONS.leads).doc();
    lead = {
      phone,
      name: incoming.contactName || "",
      source: "meta_ads",
      status: CONVERSATION_STAGES.NEW_LEAD,
      kanbanStage: "new",
      score: 0,
      assignedAgent: null,
      mode: "ai",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastMessageAt: FieldValue.serverTimestamp()
    };
    await leadRef.set(lead);
  } else {
    leadRef = leadSnap.docs[0].ref;
    lead = leadSnap.docs[0].data();
  }

  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("leadId", "==", leadRef.id)
    .where("active", "==", true)
    .limit(1)
    .get();

  let conversationRef;
  let conversation;
  let orderRef;
  let order;

  if (conversationSnap.empty) {
    orderRef = db.collection(COLLECTIONS.songOrders).doc();
    conversationRef = db.collection(COLLECTIONS.conversations).doc();
    order = buildEmptyOrder({ leadId: leadRef.id, phone });
    conversation = {
      leadId: leadRef.id,
      songOrderId: orderRef.id,
      mode: lead.mode || "ai",
      stage: CONVERSATION_STAGES.NEW_LEAD,
      summary: "",
      lastIntent: "",
      active: true,
      lastMessageAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };

    await orderRef.set(order);
    await conversationRef.set(conversation);
  } else {
    conversationRef = conversationSnap.docs[0].ref;
    conversation = conversationSnap.docs[0].data();
    orderRef = db.collection(COLLECTIONS.songOrders).doc(conversation.songOrderId);
    const orderSnap = await orderRef.get();
    order = orderSnap.exists ? orderSnap.data() : buildEmptyOrder({ leadId: leadRef.id, phone });
    if (!orderSnap.exists) await orderRef.set(order);
  }

  return { leadRef, lead: materializeLead(lead), conversationRef, conversation, orderRef, order };
}

function buildEmptyOrder({ leadId, phone }) {
  return {
    leadId,
    phone,
    purpose: "",
    recipient: "",
    relationship: "",
    genre: "",
    referenceArtist: "",
    voiceType: "",
    nickname: "",
    story: "",
    specialDetails: "",
    clientName: "",
    lyrics: "",
    lyricsApproved: false,
    lyricsVersion: 0,
    fullUrls: [],
    clipUrls: [],
    musicStatus: "brief_open",
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };
}

async function reserveIncomingMessage(incoming) {
  const id = safeDocumentId(`${incoming.provider}_${incoming.messageId}`);
  const ref = db.collection(COLLECTIONS.processedMessages).doc(id);

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (snap.exists) return { reserved: false, ref };

    transaction.set(ref, {
      provider: incoming.provider,
      messageId: incoming.messageId,
      phone: incoming.phone,
      status: "processing",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { reserved: true, ref };
  });
}

async function markIncomingProcessed(ref, { context, autoReplied }) {
  await ref.update({
    status: "processed",
    leadId: context.leadRef.id,
    conversationId: context.conversationRef.id,
    songOrderId: context.orderRef.id,
    autoReplied,
    processedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });
}

async function touchInboundContext(context, incoming) {
  const updates = {
    lastMessage: incoming.text,
    lastMessageAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  };

  await Promise.all([
    context.leadRef.update({
      ...updates,
      ...(incoming.contactName && !context.lead.name ? { name: incoming.contactName } : {})
    }),
    context.conversationRef.update(updates)
  ]);
}

async function getRecentMessages(conversationId) {
  const snap = await db
    .collection(COLLECTIONS.conversations)
    .doc(conversationId)
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(10)
    .get();

  return snap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        direction: data.direction,
        text: data.text,
        createdAt: data.createdAt?.toDate?.()?.toISOString?.() || null
      };
    })
    .reverse();
}

async function saveConversationMessage({ conversationId, direction, text, providerMessageId, raw }) {
  await db.collection(COLLECTIONS.conversations).doc(conversationId).collection("messages").add({
    direction,
    text,
    providerMessageId: providerMessageId || null,
    raw: raw || null,
    createdAt: FieldValue.serverTimestamp()
  });
}

async function sendAndSaveReply({ context, incoming, reply, suffix }) {
  if (!reply) return null;

  const delivery = await sendText({
    phone: context.lead.phone,
    message: reply,
    idempotencyKey: `${context.conversationRef.id}-${incoming.messageId}-${suffix}`
  });

  await saveConversationMessage({
    conversationId: context.conversationRef.id,
    direction: "out",
    text: reply,
    providerMessageId: extractProviderMessageId(delivery),
    raw: delivery
  });

  await context.conversationRef.update({
    lastBotReply: reply,
    lastBotReplyAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  return delivery;
}

function buildOrderUpdates(currentOrder, extractedFields) {
  const updates = {};

  for (const [field, value] of Object.entries(extractedFields || {})) {
    if (!value) continue;
    const currentValue = currentOrder[field];
    const shouldUpdate =
      !currentValue ||
      (field === "story" && String(value).length > String(currentValue).length) ||
      (field === "genre" && !currentOrder.genre);
    if (shouldUpdate) updates[field] = value;
  }

  return updates;
}

async function lockOrderForLyrics(orderRef) {
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    const data = snap.data();
    if (data.lyrics) return { locked: false, reason: "lyrics-exist" };
    if (data.lyricsGenerationLock) return { locked: false, reason: "lyrics-locked" };

    transaction.update(orderRef, {
      lyricsGenerationLock: true,
      lyricsGenerationStartedAt: FieldValue.serverTimestamp(),
      musicStatus: "generating_lyrics",
      updatedAt: FieldValue.serverTimestamp()
    });

    return { locked: true };
  });
}

async function lockOrderForRevision(orderRef) {
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(orderRef);
    const data = snap.data();
    if (data.lyricsRevisionLock) return { locked: false, reason: "revision-locked" };

    transaction.update(orderRef, {
      lyricsRevisionLock: true,
      lyricsRevisionStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { locked: true };
  });
}

function buildSongForLyrics(order, lead) {
  const recipientName = order.nickname || order.recipient || "destinatario";
  const storyParts = [
    order.story,
    order.relationship ? `Relacion: ${order.relationship}` : "",
    order.specialDetails ? `Detalles especiales: ${order.specialDetails}` : ""
  ].filter(Boolean);

  return {
    title: buildTitle(order),
    occasion: order.purpose || "cancion personalizada",
    recipientName,
    customerName: order.clientName || lead.name || "cliente",
    language: "Espanol",
    story: storyParts.join("\n"),
    genre: order.genre || (order.referenceArtist ? `estilo inspirado en ${order.referenceArtist}` : "balada pop"),
    referenceArtist: order.referenceArtist || "",
    voiceType: order.voiceType || "Cualquiera",
    mood: "Emotiva, clara y cercana",
    negativeTags: "Heavy metal, gritos, audio distorsionado"
  };
}

function buildTitle(order) {
  const recipient = order.nickname || order.recipient;
  if (recipient) return `Cancion para ${recipient}`;
  if (order.purpose) return `Cancion de ${order.purpose}`;
  return "Cancion personalizada";
}

function buildLyricsApprovalMessage(lyrics, intro = "Ya tengo una primera letra:") {
  return [
    intro,
    "",
    lyrics,
    "",
    "¿Te gusta asi o quieres que cambie algo antes de producir la musica?"
  ].join("\n");
}

function buildResult(context, reply, stage, extra = {}) {
  return {
    ok: true,
    leadId: context.leadRef.id,
    conversationId: context.conversationRef.id,
    songOrderId: context.orderRef.id,
    stage,
    reply,
    ...extra
  };
}

function extractProviderMessageId(delivery) {
  return delivery?.messageId || delivery?.id || delivery?.data?.messageId || delivery?.datos?.mensajeId || null;
}

function materializeLead(lead) {
  return {
    ...lead,
    phone: normalizePhone(lead.phone)
  };
}

function safeDocumentId(value) {
  const normalized = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  if (normalized) return normalized;
  return crypto.randomUUID();
}
