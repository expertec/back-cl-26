import crypto from "node:crypto";
import { config } from "../../config.js";
import { db, FieldValue } from "../../firebase.js";
import { normalizePhone } from "../../schemas.js";
import { createLyrics, reviseLyrics } from "../openaiService.js";
import { getBotSettings, renderTemplate } from "../botSettings.js";
import { logEvent } from "../eventLog.js";
import { startSongProduction } from "../songProduction.js";
import { sendText } from "../whatsapp/index.js";
import { COLLECTIONS, CONVERSATION_STAGES, INTENTS, WELCOME_MESSAGE } from "./constants.js";
import { setConversationStage } from "./conversationState.js";
import { updateConversationSummary } from "./conversationSummary.js";
import { extractFields } from "./extractFields.js";
import { generateNextQuestion, selectNextField } from "./generateNextQuestion.js";
import { getMissingFields } from "./getMissingFields.js";
import { buildSongForLyrics } from "./songBrief.js";

// Si el proceso muere entre tomar el lock y liberarlo (un deploy a media
// llamada a OpenAI), el pedido quedaba bloqueado para siempre: el cliente pedia
// otro cambio y el bot no respondia nada nunca mas.
const LOCK_MAX_AGE_MS = 5 * 60 * 1000;
const REPEAT_WINDOW_MS = 30 * 60 * 1000;

const POST_APPROVAL_STAGES = new Set([
  CONVERSATION_STAGES.LYRICS_APPROVED,
  CONVERSATION_STAGES.PRODUCING_SONG,
  CONVERSATION_STAGES.SAMPLES_SENT
]);

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

    logEvent({
      level: "error",
      scope: "conversacion",
      message: "Fallo procesando un mensaje entrante",
      phone: incoming.phone,
      detail: error.message
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

  // Si hay letra sin aprobar, la conversacion esta en revision aunque el stage
  // diga otra cosa. Sin esto, un stage que quedo en BRIEF_COMPLETE hacia que
  // cada mensaje del cliente recibiera la misma respuesta para siempre, y sus
  // peticiones de cambio no se atendian nunca.
  if (context.order.lyrics && !context.order.lyricsApproved && !isLyricsStage(context.conversation.stage)) {
    console.warn("[conversation] stage inconsistente, se corrige a revision de letra", {
      conversationId: context.conversationRef.id,
      stageAnterior: context.conversation.stage
    });

    await setConversationStage({
      conversationRef: context.conversationRef,
      leadRef: context.leadRef,
      stage: CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL
    });
    context.conversation = { ...context.conversation, stage: CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL };
  }

  if (context.conversation.stage === CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL) {
    return handleLyricsApprovalIntent({ context, incoming, extraction });
  }

  if (extraction.intent === INTENTS.OWN_LYRICS && !yaTieneCancion(context)) {
    return handleOwnLyrics({ context, incoming });
  }

  if (extraction.intent === INTENTS.NEW_SONG && yaTieneCancion(context)) {
    return handleNewSongRequest({ context, incoming });
  }

  if (extraction.intent === INTENTS.POSTPONE) {
    return handlePostpone({ context, incoming });
  }

  if (extraction.intent === INTENTS.BUYING_SIGNAL) {
    return handleBuyingSignal({ context, incoming });
  }

  if (POST_APPROVAL_STAGES.has(context.conversation.stage)) {
    return handlePostApprovalMessage({ context, incoming });
  }

  const missingFields = getMissingFields(context.order);
  if (missingFields.length) {
    return continueDiscovery({ context, incoming, missingFields });
  }

  return completeBriefAndGenerateLyrics({ context, incoming });
}

/**
 * Con la letra ya aprobada no hay que volver a generar nada: sin esta rama el
 * flujo caia en completeBriefAndGenerateLyrics, el lock devolvia "lyrics-exist"
 * y el bot se quedaba mudo ademas de regresar el lead a "Revisando letra".
 */
/**
 * El equipo solo cierra ventas despues de que el cliente escucho su muestra.
 * Antes de eso, preguntar el precio no es motivo para pasarlo con nadie: se le
 * explica que la muestra es gratis y se sigue con el brief, que es lo que lleva
 * a la venta. Mandarlo al equipo con el pedido vacio lo dejaba muerto ahi.
 */
/**
 * El cliente pide dejarlo para despues. No se toca el pedido ni la letra: solo
 * se acusa recibo y se anota para no perderlo. Se queda en la misma etapa, asi
 * que retoma justo donde iba cuando vuelva a escribir.
 */
/**
 * El cliente manda su propia letra. Se guarda tal cual, sin reescribirla ni
 * corregirle nada, y solo se le pregunta como quiere que suene.
 */
async function handleOwnLyrics({ context, incoming }) {
  const letra = incoming.text.trim();

  await context.orderRef.update({
    lyrics: letra,
    lyricsFromClient: true,
    lyricsApproved: false,
    lyricsVersion: Number(context.order.lyricsVersion || 0) + 1,
    musicStatus: "lyrics_ready",
    updatedAt: FieldValue.serverTimestamp()
  });

  context.order = {
    ...context.order,
    lyrics: letra,
    lyricsFromClient: true
  };

  const faltantes = getMissingFields(context.order);

  if (!faltantes.length) {
    await setConversationStage({
      conversationRef: context.conversationRef,
      leadRef: context.leadRef,
      stage: CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL
    });

    const reply = "Perfecto, me quedo con tu letra tal cual. ¿La produzco asi y te la mando cantada?";
    await sendAndSaveReply({ context, incoming, reply, suffix: "letra-propia" });
    return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
  }

  const nextField = selectNextField(faltantes, context.conversation.lastAskedFields || []);
  const pregunta = await generateNextQuestion({
    missingFields: faltantes,
    order: context.order,
    conversation: context.conversation
  });

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY,
    extra: {
      missingFields: faltantes,
      lastQuestionField: nextField || FieldValue.delete(),
      lastAskedFields: nextField ? FieldValue.arrayUnion(nextField) : FieldValue.delete()
    }
  });

  const reply = ["Recibi tu letra, la usamos tal cual.", "", pregunta].join("\n");
  await sendAndSaveReply({ context, incoming, reply, suffix: "letra-propia-falta" });
  return buildResult(context, reply, CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY, { missingFields: faltantes });
}

function yaTieneCancion(context) {
  return Boolean(context.order.clipUrls?.length) || context.conversation.stage === CONVERSATION_STAGES.SAMPLES_SENT;
}

/**
 * Ya escucho su cancion y quiere otra. Se le abre un pedido nuevo sin volver a
 * preguntar lo que ya sabemos de el.
 */
async function handleNewSongRequest({ context, incoming }) {
  const { startNewSongOrder } = await import("../adminActions.js");

  try {
    await startNewSongOrder(context.leadRef.id, { seedText: incoming.text });
    return buildResult(context, "", CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY, { nuevoPedido: true });
  } catch (error) {
    console.error("[conversation] no se pudo abrir el pedido nuevo", {
      leadId: context.leadRef.id,
      error: error.message
    });

    const reply = "Claro que si, con gusto te hago otra. ¿Para quien seria y que ocasion celebramos?";
    await sendAndSaveReply({ context, incoming, reply, suffix: "nueva-cancion" });
    return buildResult(context, reply, context.conversation.stage);
  }
}

async function handlePostpone({ context, incoming }) {
  const reply = "Claro, cuando gustes seguimos. Aqui te espero y tu cancion queda guardada.";

  await context.conversationRef.update({
    postponedAt: FieldValue.serverTimestamp(),
    postponedMessage: incoming.text.slice(0, 200),
    updatedAt: FieldValue.serverTimestamp()
  });

  await sendAndSaveReply({ context, incoming, reply, suffix: "postpone" });
  return buildResult(context, reply, context.conversation.stage, { postponed: true });
}

async function handleBuyingSignal({ context, incoming }) {
  const yaTieneMuestras =
    context.conversation.stage === CONVERSATION_STAGES.SAMPLES_SENT || Boolean(context.order.clipUrls?.length);

  if (yaTieneMuestras) return handOverToSales({ context, incoming });

  const missingFields = getMissingFields(context.order);

  if (!missingFields.length) {
    return completeBriefAndGenerateLyrics({ context, incoming });
  }

  const question = await generateNextQuestion({
    missingFields,
    order: context.order,
    conversation: context.conversation
  });

  const reply = [
    "Primero te hago una muestra sin costo para que la escuches, y ya despues vemos precios de la version completa.",
    "",
    question
  ].join("\n");

  const nextField = selectNextField(missingFields, context.conversation.lastAskedFields || []);
  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY,
    extra: {
      missingFields,
      lastAskedFields: nextField ? FieldValue.arrayUnion(nextField) : FieldValue.delete()
    }
  });

  await sendAndSaveReply({ context, incoming, reply, suffix: "muestra-gratis" });
  return buildResult(context, reply, CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY, { missingFields });
}

/**
 * Al pasar a ventas el bot se calla y la conversacion queda en modo humano: si
 * sigue contestando, el cliente recibe "te paso con el equipo" en bucle cada vez
 * que escribe, que es justo cuando mas atencion necesita.
 */
async function handOverToSales({ context, incoming }) {
  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.READY_FOR_SALES
  });

  await Promise.all([
    context.leadRef.update({
      mode: "human",
      kanbanStage: "opportunity",
      opportunityAt: FieldValue.serverTimestamp(),
      opportunitySignal: incoming.text.slice(0, 200),
      updatedAt: FieldValue.serverTimestamp()
    }),
    context.conversationRef.update({ mode: "human", updatedAt: FieldValue.serverTimestamp() })
  ]);

  // Quien pregunta el precio quiere el precio, no que le prometan que alguien
  // se lo dira: se responde con la informacion configurada y ademas pasa a una
  // persona para cerrar.
  const settings = await getBotSettings();
  const reply =
    settings.priceMessageEnabled && settings.priceMessage
      ? renderTemplate(settings.priceMessage, {
          nombre: String(context.lead.name || "").trim().split(/\s+/)[0],
          telefono: context.lead.phone || ""
        }).trim()
      : "Con gusto. Te paso con una persona del equipo para darte precios y la version completa.";

  await sendAndSaveReply({ context, incoming, reply, suffix: "sales-ready" });

  logEvent({
    level: "warn",
    scope: "ventas",
    message: "Lead con intencion de compra esperando atencion",
    leadId: context.leadRef.id,
    phone: context.lead.phone,
    detail: incoming.text
  });

  return buildResult(context, reply, CONVERSATION_STAGES.READY_FOR_SALES);
}

async function handlePostApprovalMessage({ context, incoming }) {
  const stage = context.conversation.stage;

  // Ya escucho su cancion: preguntas de precio, quejas del genero o cualquier
  // comentario con contenido son trabajo de una persona. Antes se contestaba
  // "te paso con el equipo" sin pasar a nadie, y el lead se quedaba en el bot.
  if (stage === CONVERSATION_STAGES.SAMPLES_SENT && isActionableFeedback(incoming.text)) {
    return handOverToSales({ context, incoming });
  }

  const reply =
    stage === CONVERSATION_STAGES.SAMPLES_SENT
      ? "Ya te envie las versiones con marca de agua. Si quieres la cancion completa en alta calidad, te paso con el equipo."
      : "Tu cancion ya se esta produciendo. En cuanto este te mando las versiones por aqui.";

  await sendAndSaveReply({ context, incoming, reply, suffix: `post-approval-${stage}` });

  // Si la produccion nunca arranco (error previo o deploy a medias), reintentamos.
  if (stage !== CONVERSATION_STAGES.SAMPLES_SENT && !context.order.musicId) {
    await triggerSongProduction(context);
  }

  return buildResult(context, reply, stage);
}

async function continueDiscovery({ context, incoming, missingFields }) {
  const nextField = selectNextField(missingFields, context.conversation.lastAskedFields || []);
  const question = await generateNextQuestion({
    missingFields,
    order: context.order,
    conversation: context.conversation
  });

  // El lead llega de una campana con un mensaje predefinido: hay que presentarse
  // antes de empezar a preguntar.
  const isFirstContact = context.conversation.stage === CONVERSATION_STAGES.NEW_LEAD;
  const reply = isFirstContact ? [WELCOME_MESSAGE, "", question].join("\n") : question;

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.WAITING_DISCOVERY_REPLY,
    extra: {
      missingFields,
      lastQuestionField: nextField || FieldValue.delete(),
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
    const reply =
      lock.reason === "lyrics-exist"
        ? "Ya tienes la letra arriba. ¿La dejamos asi o quieres que cambie algo?"
        : "Estoy escribiendo tu letra, dame un momento.";
    await sendAndSaveReply({ context, incoming, reply, suffix: `lyrics-${lock.reason}` });
    return buildResult(context, reply, context.conversation.stage, { skipped: lock.reason });
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

    const revisionsLeft = Math.max(0, config.maxLyricsRevisions - getRevisionsUsed(context.order));
    const reply = buildLyricsApprovalMessage(lyrics, undefined, revisionsLeft);
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
      stage: CONVERSATION_STAGES.PRODUCING_SONG
    });

    const reply = [
      "Perfecto, letra aprobada.",
      "",
      "Ya estoy produciendo la musica. En unos minutos te mando dos versiones por aqui para que elijas."
    ].join("\n");
    await sendAndSaveReply({ context, incoming, reply, suffix: "lyrics-approved" });

    await triggerSongProduction(context);

    return buildResult(context, reply, CONVERSATION_STAGES.PRODUCING_SONG);
  }

  if (extraction.intent === INTENTS.POSTPONE) {
    return handlePostpone({ context, incoming });
  }

  if (extraction.intent === INTENTS.BUYING_SIGNAL) {
    return handleBuyingSignal({ context, incoming });
  }

  // Con la letra en pantalla, casi todo lo que escribe el cliente es feedback
  // sobre ella. Exigir un verbo concreto ("cambia", "ponle") hacia que el
  // segundo ajuste, pedido con otras palabras, cayera en la respuesta generica
  // y no cambiara nada: parecia que solo se podia corregir una vez.
  // "¿No hay una prueba cantada?" no es una correccion: tratarla como tal
  // reescribia la letra igual que estaba y le gastaba su unico cambio.
  if (isPlainQuestion(incoming.text)) {
    const reply = [
      "La muestra cantada te llega en cuanto apruebes la letra.",
      "",
      "¿La dejamos asi y la produzco?"
    ].join("\n");
    await sendAndSaveReply({ context, incoming, reply, suffix: "pregunta-letra" });
    return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
  }

  // Su letra es suya: si pide un cambio, lo hace el mismo mandandola de nuevo.
  if (context.order.lyricsFromClient && isActionableFeedback(incoming.text)) {
    const reply = [
      "Como la letra es tuya, prefiero no cambiarte nada.",
      "",
      "Mandame la letra corregida y la produzco con esa, o dime si la dejamos como esta."
    ].join("\n");
    await sendAndSaveReply({ context, incoming, reply, suffix: "letra-propia-cambio" });
    return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
  }

  if (isActionableFeedback(incoming.text)) {
    if (getRevisionsUsed(context.order) >= config.maxLyricsRevisions) {
      return handleRevisionLimitReached({ context, incoming });
    }
    return reviseLyricsFromConversation({ context, incoming, extraction });
  }

  const reply = "¿La letra te gusta asi o quieres que cambie alguna parte?";
  await sendAndSaveReply({ context, incoming, reply, suffix: "lyrics-followup" });
  return buildResult(context, reply, CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL);
}

function isLyricsStage(stage) {
  return [
    CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL,
    CONVERSATION_STAGES.LYRICS_REVISION,
    CONVERSATION_STAGES.GENERATING_LYRICS
  ].includes(stage);
}

function getRevisionsUsed(order = {}) {
  if (typeof order.lyricsRevisionCount === "number") return order.lyricsRevisionCount;
  // Pedidos anteriores al contador: la version 1 es la letra inicial.
  return Math.max(0, Number(order.lyricsVersion || 1) - 1);
}

/**
 * Agotadas las correcciones por chat no dejamos al cliente en un bucle: primero
 * se le ofrece aprobar, y si insiste pasa a un asesor y el bot deja de contestar.
 */
async function handleRevisionLimitReached({ context, incoming }) {
  // Pedir un cambio mas no puede dejar la conversacion parada: se explica la
  // regla y se produce la muestra con la letra que hay. Un cliente pidio cinco
  // versiones distintas de una muestra gratuita antes de esto.
  const reply = [
    "Para la muestra hacemos un solo cambio y ya lo aplicamos.",
    "",
    "Voy a producirla asi para que la escuches cantada. Cuando tengas tu cancion completa ajustamos la letra las veces que haga falta."
  ].join("\n");

  await context.orderRef.update({
    lyricsApproved: true,
    lyricsApprovedAt: FieldValue.serverTimestamp(),
    musicStatus: "lyrics_approved",
    revisionLimitNotifiedAt: FieldValue.serverTimestamp(),
    lyricsRevisionLock: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp()
  });
  context.order = { ...context.order, lyricsApproved: true };

  await setConversationStage({
    conversationRef: context.conversationRef,
    leadRef: context.leadRef,
    stage: CONVERSATION_STAGES.PRODUCING_SONG
  });

  await sendAndSaveReply({ context, incoming, reply, suffix: "revision-limit" });
  await triggerSongProduction(context);

  return buildResult(context, reply, CONVERSATION_STAGES.PRODUCING_SONG);
}

const GREETING_ONLY = /^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|que tal|holi|ola)[\s!.,¡]*$/i;

// Raices, no palabras exactas: "cambiar", "cambies" y "cambiale" son lo mismo
// que "cambia" y antes se colaban como si fueran preguntas.
const CAMBIO_EXPLICITO =
  /\b(cambi\w*|corrig\w*|modific\w*|quit\w*|agreg\w*|ponle|poner|incluy\w*|mencion\w*|donde dice|en vez de|que diga)\b/i;

/**
 * Pregunta sin instruccion de cambio: se responde, no se reescribe la letra.
 */
function isPlainQuestion(text = "") {
  const raw = String(text).trim();
  if (!raw || raw.length > 160) return false;
  if (CAMBIO_EXPLICITO.test(raw)) return false;

  const normalized = raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const tieneSigno = /[?¿]/.test(raw);
  // La duda no siempre va al principio: "Pero no hay una prueba cantada..."
  const formulaDeDuda =
    /\b(no hay|hay forma|se puede|habra|por que|porque no|me lees|sigues ahi|cuanto cuesta|que precio)\b/i.test(
      normalized
    );
  const arrancaPregunta =
    /^(hay|puedo|puedes|como|cuando|cuanto|donde|que tal|y si|quien)\b/i.test(normalized);

  return tieneSigno || formulaDeDuda || arrancaPregunta;
}

function isActionableFeedback(text = "") {
  const raw = String(text).trim();
  if (raw.length < 4) return false;

  const normalized = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

  if (GREETING_ONLY.test(normalized)) return false;
  if (/^[?¿\s]+$/.test(normalized)) return false;

  return true;
}

async function reviseLyricsFromConversation({ context, incoming, extraction }) {
  const revisionInstruction = extraction.revisionInstruction || incoming.text;
  const lock = await lockOrderForRevision(context.orderRef);
  if (!lock.locked) {
    const reply = "Ya estoy ajustando la letra, dame un momento y te la mando.";
    await sendAndSaveReply({ context, incoming, reply, suffix: "revision-en-curso" });
    return buildResult(context, reply, context.conversation.stage, { skipped: lock.reason });
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
      lyricsRevisionCount: FieldValue.increment(1),
      musicStatus: "lyrics_ready",
      updatedAt: FieldValue.serverTimestamp()
    });

    await setConversationStage({
      conversationRef: context.conversationRef,
      leadRef: context.leadRef,
      stage: CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL
    });

    const revisionsLeft = Math.max(0, config.maxLyricsRevisions - (getRevisionsUsed(context.order) + 1));
    const reply = buildLyricsApprovalMessage(lyrics, "Listo, ajuste la letra:", revisionsLeft);
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
      waJid: incoming.jid || "",
      name: incoming.contactName || "",
      source: incoming.ad ? "meta_ads" : "whatsapp_directo",
      // Atribucion de campaña: que anuncio trajo a este lead.
      ...(incoming.ad
        ? {
            adCtwaClid: incoming.ad.ctwaClid || "",
            adSourceId: incoming.ad.sourceId || "",
            adSourceUrl: incoming.ad.sourceUrl || "",
            adTitle: incoming.ad.title || ""
          }
        : {}),
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
    order = buildEmptyOrder({
      leadId: leadRef.id,
      phone,
      clientName: nombreDePerfil(incoming.contactName || lead.name)
    });
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

/**
 * El nombre del perfil de WhatsApp sirve como nombre del cliente. Sin esto el
 * bot preguntaba "¿cual es tu nombre?" y el cliente, que venia hablando de su
 * hija, respondia el nombre de ella: el pedido quedaba a nombre de la niña.
 */
function nombreDePerfil(nombre) {
  const limpio = String(nombre || "").trim();
  if (limpio.length < 3 || limpio.length > 60) return "";
  // Un usuario tipo "qfbcastro" o un telefono no son un nombre utilizable.
  if (/^\d+$/.test(limpio) || !/[a-záéíóúñ]/i.test(limpio)) return "";
  return limpio;
}

function buildEmptyOrder({ leadId, phone, clientName = "" }) {
  return {
    leadId,
    phone,
    clientName,
    purpose: "",
    recipient: "",
    relationship: "",
    genre: "",
    referenceArtist: "",
    voiceType: "",
    nickname: "",
    story: "",
    specialDetails: "",
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
      ...(incoming.contactName && !context.lead.name ? { name: incoming.contactName } : {}),
      // El JID es la direccion real de respuesta; con LIDs el telefono no basta.
      ...(incoming.jid && incoming.jid !== context.lead.waJid ? { waJid: incoming.jid } : {})
    }),
    context.conversationRef.update({
      ...updates,
      // Sin leer hasta que alguien del equipo abra la conversacion.
      unreadCount: FieldValue.increment(1)
    })
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
    raw: toPlainJson(raw),
    createdAt: FieldValue.serverTimestamp()
  });
}

/**
 * Baileys entrega instancias de protobuf (WebMessageInfo) y Firestore solo
 * acepta objetos planos: guardarlas directo tumbaba la conversacion entera
 * despues de haber enviado el mensaje.
 */
function toPlainJson(value, maxChars = 20000) {
  if (!value) return null;

  try {
    const json = JSON.stringify(value);
    if (!json) return null;
    if (json.length > maxChars) return { truncated: true, preview: json.slice(0, 1000) };
    return JSON.parse(json);
  } catch (error) {
    return { serializationError: error.message };
  }
}

async function sendAndSaveReply({ context, incoming, reply, suffix }) {
  if (!reply) return null;

  // Repetir palabra por palabra lo ultimo que dijimos hace que el bot parezca
  // roto y no aporta nada: si el cliente insiste, el problema es otro.
  const lastReplyAt = context.conversation.lastBotReplyAt?.toDate?.()?.getTime?.() || 0;
  if (reply === context.conversation.lastBotReply && Date.now() - lastReplyAt < REPEAT_WINDOW_MS) {
    console.warn("[conversation] respuesta repetida omitida", {
      conversationId: context.conversationRef.id,
      suffix
    });
    return null;
  }

  const delivery = await sendText({
    phone: context.lead.waJid || context.lead.phone,
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
    if (data.lyricsGenerationLock && !isLockExpired(data.lyricsGenerationStartedAt, orderRef.id, "lyrics")) {
      return { locked: false, reason: "lyrics-locked" };
    }

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
    if (data.lyricsRevisionLock && !isLockExpired(data.lyricsRevisionStartedAt, orderRef.id, "revision")) {
      return { locked: false, reason: "revision-locked" };
    }

    transaction.update(orderRef, {
      lyricsRevisionLock: true,
      lyricsRevisionStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { locked: true };
  });
}

function isLockExpired(startedAt, orderId, kind) {
  const startedMs = startedAt?.toDate?.()?.getTime?.() || 0;
  const expired = !startedMs || Date.now() - startedMs > LOCK_MAX_AGE_MS;

  if (expired) {
    console.warn("[conversation] lock vencido, se retoma el pedido", {
      songOrderId: orderId,
      lock: kind,
      startedAt: startedMs ? new Date(startedMs).toISOString() : null
    });
  }

  return expired;
}

async function triggerSongProduction(context) {
  try {
    const result = await startSongProduction({
      order: context.order,
      orderRef: context.orderRef,
      lead: context.lead,
      leadId: context.leadRef.id,
      conversationId: context.conversationRef.id
    });

    if (result.musicId) {
      context.order = { ...context.order, musicId: result.musicId };
    }

    return result;
  } catch (error) {
    // El lead ya recibio su confirmacion; un fallo aqui no debe tumbar la conversacion.
    console.error("[conversation] no se pudo iniciar la produccion", {
      songOrderId: context.orderRef.id,
      error: error.message
    });
    return { started: false, reason: error.message };
  }
}

function buildLyricsApprovalMessage(lyrics, intro = "Ya tengo una primera letra:", revisionsLeft = 0) {
  return [intro, "", toWhatsappFormat(lyrics), "", buildApprovalClosing(revisionsLeft)].join("\n");
}

// WhatsApp usa un solo asterisco para negritas: con los dos de Markdown, el
// cliente ve "**Coro final**" tal cual en su pantalla.
function toWhatsappFormat(text) {
  return String(text || "")
    .replace(/\*\*\*(.+?)\*\*\*/g, "*$1*")
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s*(.+)$/gm, "*$1*");
}

// La regla se dice al entregar la letra, que es cuando el cliente decide si
// gasta su ajuste o aprueba.
function buildApprovalClosing(revisionsLeft) {
  if (revisionsLeft <= 0) {
    return [
      "Esta es la version de la muestra: los cambios extra los hacemos ya con tu cancion completa.",
      "¿La apruebo y produzco la musica?"
    ].join(" ");
  }

  if (revisionsLeft === 1) {
    return [
      "Para la muestra puedo hacerle un cambio.",
      "¿La dejamos asi o prefieres usar ese cambio antes de producir la musica?"
    ].join(" ");
  }


  return `Para la muestra puedo hacerle hasta ${revisionsLeft} cambios. ¿La dejamos asi o quieres ajustar algo?`;
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
    waJid: lead.waJid || "",
    phone: normalizePhone(lead.phone)
  };
}

function safeDocumentId(value) {
  const normalized = String(value || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  if (normalized) return normalized;
  return crypto.randomUUID();
}

/**
 * Borra un lead y todo lo que colgaba de el, para poder repetir el flujo de
 * prueba con el mismo numero. Incluye los pedidos de `musica`: si quedaran
 * huerfanos, el pipeline seguiria mandando audios a un lead ya borrado.
 */
export async function deleteLeadAndData(leadId, { force = false } = {}) {
  const leadRef = db.collection(COLLECTIONS.leads).doc(leadId);
  const leadSnap = await leadRef.get();
  if (!leadSnap.exists) throw new Error("Lead no encontrado.");

  const lead = leadSnap.data();
  const conversationSnap = await db.collection(COLLECTIONS.conversations).where("leadId", "==", leadId).get();
  const createdByBot = Boolean(lead.waJid || lead.mode || conversationSnap.size);

  // Los leads del CRM anterior viven en la misma coleccion y no se tocan sin querer.
  if (!createdByBot && !force) {
    throw new Error("Este lead no lo creo el bot. Repite con force=true si de verdad quieres borrarlo.");
  }

  const deleted = { conversations: 0, messages: 0, songOrders: 0, music: 0, processedMessages: 0 };
  const songOrderIds = new Set();

  for (const conversationDoc of conversationSnap.docs) {
    const songOrderId = conversationDoc.data().songOrderId;
    if (songOrderId) songOrderIds.add(songOrderId);

    deleted.messages += await deleteCollection(conversationDoc.ref.collection("messages"));
    await conversationDoc.ref.delete();
    deleted.conversations += 1;
  }

  const orderSnap = await db.collection(COLLECTIONS.songOrders).where("leadId", "==", leadId).get();
  orderSnap.docs.forEach((doc) => songOrderIds.add(doc.id));

  for (const songOrderId of songOrderIds) {
    await db.collection(COLLECTIONS.songOrders).doc(songOrderId).delete();
    deleted.songOrders += 1;
  }

  deleted.music = await deleteQuery(db.collection("musica").where("leadId", "==", leadId));

  if (lead.phone) {
    deleted.processedMessages = await deleteQuery(
      db.collection(COLLECTIONS.processedMessages).where("phone", "==", lead.phone)
    );
  }

  await leadRef.delete();

  console.log("[admin] lead borrado", { leadId, phone: lead.phone, ...deleted });
  return deleted;
}

async function deleteCollection(collectionRef) {
  let total = 0;

  while (true) {
    const snap = await collectionRef.limit(300).get();
    if (snap.empty) return total;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    total += snap.size;
  }
}

async function deleteQuery(query) {
  let total = 0;

  while (true) {
    const snap = await query.limit(300).get();
    if (snap.empty) return total;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    total += snap.size;
  }
}
