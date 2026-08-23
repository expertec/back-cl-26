import { db, FieldValue } from "../firebase.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "./songConversation/constants.js";
import { getMissingFields } from "./songConversation/getMissingFields.js";

const MUSIC_ERROR_STATUSES = ["Error letra", "Error prompt", "Error musica", "Error música", "Error clip", "Error envio", "Error sin fullUrl"];
const MUSIC_DONE_STATUSES = ["Enviada", "Enviada completa"];

// Alguien que dice que ya pago no puede quedar mezclado con el resto de la cola.
const PAGO_REGEX = /\b(transferenc|deposit|ya pagu|ya te pagu|hice el pago|pague|comprobante|ya mande el dinero|spei)/i;

// Minutos a partir de los cuales cada situacion deja de ser normal.
const UMBRALES = {
  sinResponder: 10,
  pasoTransitorio: 10,
  aprobacionEstancada: 30,
  produccionSinArrancar: 5,
  produccionLenta: 25,
  seguimientoMuestras: 60 * 12
};

/**
 * Radiografia de las conversaciones vivas: no interesa lo que ya termino, sino
 * quien deberia haber avanzado y no avanzo, y que puede hacer un humano al
 * respecto.
 */
export async function getConversationsHealth({ limit = 120 } = {}) {
  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("active", "==", true)
    .limit(Math.min(limit, 300))
    .get();
  if (conversationSnap.empty) return { items: [], counts: {}, needsAttention: 0 };

  const conversations = conversationSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  const [leads, orders, musicByLead] = await Promise.all([
    getByIds(COLLECTIONS.leads, conversations.map((conversation) => conversation.leadId)),
    getByIds(COLLECTIONS.songOrders, conversations.map((conversation) => conversation.songOrderId)),
    getMusicByLeadIds(conversations.map((conversation) => conversation.leadId))
  ]);

  const items = conversations
    .map((conversation) => {
      const lead = leads.get(conversation.leadId);
      if (!lead) return null;

      const order = orders.get(conversation.songOrderId) || {};
      const music = musicByLead.get(conversation.leadId) || null;

      return buildItem({ conversation, lead, order, music });
    })
    .filter(Boolean)
    .sort((a, b) => b.severity - a.severity || (b.lastMessageAt || 0) - (a.lastMessageAt || 0));

  const counts = {};
  for (const item of items) {
    counts[item.diagnosis] = (counts[item.diagnosis] || 0) + 1;
  }

  return {
    items,
    counts,
    needsAttention: items.filter((item) => item.severity >= 2).length
  };
}

function buildItem({ conversation, lead, order, music }) {
  const now = Date.now();
  const lastMessageAt = toMillis(lead.lastMessageAt) || toMillis(conversation.lastMessageAt);
  const lastBotReplyAt = toMillis(conversation.lastBotReplyAt);
  const stageUpdatedAt = toMillis(conversation.stageUpdatedAt);

  const minutesSinceMessage = minutesFrom(lastMessageAt, now);
  const minutesInStage = minutesFrom(stageUpdatedAt, now);
  const missingFields = getMissingFields(order);
  // El cliente escribio despues de la ultima respuesta del bot.
  const unanswered = Boolean(lastMessageAt && (!lastBotReplyAt || lastMessageAt > lastBotReplyAt));

  const diagnosis = diagnose({
    conversation,
    lead,
    order,
    music,
    missingFields,
    unanswered,
    minutesSinceMessage,
    minutesInStage
  });

  return {
    leadId: conversation.leadId,
    conversationId: conversation.id,
    songOrderId: conversation.songOrderId,
    musicId: order.musicId || music?.id || null,
    phone: lead.phone || "",
    name: lead.name || "",
    mode: conversation.mode || lead.mode || "ai",
    stage: conversation.stage || "",
    kanbanStage: lead.kanbanStage || "",
    lastMessage: (lead.lastMessage || "").slice(0, 140),
    lastBotReply: (conversation.lastBotReply || "").slice(0, 140),
    lastMessageAt,
    lastBotReplyAt,
    // Ultima actividad venga de quien venga: es lo que ordena un chat.
    lastActivityAt: Math.max(lastMessageAt || 0, lastBotReplyAt || 0) || null,
    minutesSinceMessage,
    minutesInStage,
    missingFields,
    hasLyrics: Boolean(order.lyrics),
    lyricsApproved: Boolean(order.lyricsApproved),
    lyricsVersion: Number(order.lyricsVersion || 0),
    musicStatus: music?.status || order.musicStatus || "",
    musicError: music?.errorMsg || "",
    clips: (music?.clipUrls || order.clipUrls || []).length,
    unanswered,
    locks: [
      order.lyricsGenerationLock ? "letra" : null,
      order.lyricsRevisionLock ? "revision" : null,
      order.productionLock ? "produccion" : null
    ].filter(Boolean),
    ...diagnosis
  };
}

/**
 * El orden importa: primero lo que esta roto, luego lo que esta esperando a una
 * persona, y al final lo que simplemente espera al cliente.
 */
function diagnose({ conversation, lead, order, music, missingFields, unanswered, minutesSinceMessage, minutesInStage }) {
  const stage = conversation.stage || "";
  const mode = conversation.mode || lead.mode || "ai";

  if (PAGO_REGEX.test(lead.lastMessage || "")) {
    return d("posible_pago", 5, "Dice que ya pago: atender de inmediato", ["responder"]);
  }

  if (mode === "human" || stage === CONVERSATION_STAGES.HUMAN_TAKEOVER) {
    return d("esperando_humano", 3, "Pasada a un asesor y sin atender", ["responder", "reactivar_bot"]);
  }

  if (unanswered && minutesSinceMessage >= UMBRALES.sinResponder) {
    return d(
      "sin_responder",
      4,
      `El cliente escribio hace ${fmt(minutesSinceMessage)} y el bot no ha contestado`,
      order.lyrics && !order.lyricsApproved ? ["aprobar_y_producir", "liberar_locks"] : ["liberar_locks", "generar_letra"]
    );
  }

  if (order.lyricsApproved && !order.musicId && minutesInStage >= UMBRALES.produccionSinArrancar) {
    return d("aprobada_sin_produccion", 4, "Letra aprobada pero la produccion nunca arranco", ["producir"]);
  }

  if (music && MUSIC_ERROR_STATUSES.includes(music.status)) {
    return d("produccion_fallida", 4, `La cancion fallo: ${music.errorMsg || music.status}`, ["reintentar_musica"]);
  }

  if (!missingFields.length && !order.lyrics) {
    return d("brief_listo_sin_letra", 3, "Ya tiene todos los datos pero no se genero la letra", ["generar_letra"]);
  }

  if (stage === CONVERSATION_STAGES.WAITING_LYRICS_APPROVAL && minutesInStage >= UMBRALES.aprobacionEstancada) {
    return d(
      "aprobacion_estancada",
      3,
      `Lleva ${fmt(minutesInStage)} dando vueltas con la letra sin aprobarla`,
      ["aprobar_y_producir"]
    );
  }

  if (isTransitional(stage) && minutesInStage >= UMBRALES.pasoTransitorio) {
    return d("paso_colgado", 4, `Atorada en ${stage} desde hace ${fmt(minutesInStage)}`, ["liberar_locks", "generar_letra"]);
  }

  if (order.musicId && music && !MUSIC_DONE_STATUSES.includes(music.status) && minutesInStage >= UMBRALES.produccionLenta) {
    return d("produccion_lenta", 3, `La cancion lleva ${fmt(minutesInStage)} en "${music.status}"`, ["reintentar_musica"]);
  }

  if (stage === CONVERSATION_STAGES.SAMPLES_SENT) {
    if (minutesSinceMessage >= UMBRALES.seguimientoMuestras) {
      return d("muestras_sin_seguimiento", 2, "Recibio las muestras y nadie le dio seguimiento", ["responder"]);
    }
    return d("muestras_enviadas", 1, "Muestras entregadas", []);
  }

  if (stage === CONVERSATION_STAGES.READY_FOR_SALES) {
    // Si nunca llego a tener muestra, lo mandamos a ventas por error: lo suyo
    // es devolverlo al bot para que termine el brief y reciba su cancion.
    const sinMuestra = !order.clipUrls?.length && !order.lyrics;
    return d(
      "listo_para_venta",
      3,
      sinMuestra ? "Paso a ventas sin haber recibido su muestra" : "Mostro intencion de compra",
      sinMuestra ? ["reactivar_bot", "responder"] : ["responder"]
    );
  }

  if (minutesSinceMessage >= 60 * 24) {
    return d("cliente_no_responde", 2, `Sin respuesta del cliente hace ${fmt(minutesSinceMessage)}`, ["responder"]);
  }

  return d("en_curso", 1, "Conversacion avanzando con normalidad", []);
}

function isTransitional(stage) {
  return [
    CONVERSATION_STAGES.BRIEF_COMPLETE,
    CONVERSATION_STAGES.GENERATING_LYRICS,
    CONVERSATION_STAGES.LYRICS_REVISION,
    CONVERSATION_STAGES.LYRICS_APPROVED
  ].includes(stage);
}

function d(diagnosis, severity, summary, actions) {
  return { diagnosis, severity, summary, actions };
}

async function getByIds(collection, ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  const result = new Map();
  if (!unique.length) return result;

  // getAll evita una consulta por documento: con 100 conversaciones la
  // diferencia es de minutos a segundos.
  for (let index = 0; index < unique.length; index += 100) {
    const refs = unique.slice(index, index + 100).map((id) => db.collection(collection).doc(id));
    const docs = await db.getAll(...refs);
    docs.forEach((doc) => {
      if (doc.exists) result.set(doc.id, { id: doc.id, ...doc.data() });
    });
  }

  return result;
}

async function getMusicByLeadIds(leadIds) {
  const unique = [...new Set(leadIds.filter(Boolean))];
  const result = new Map();

  for (let index = 0; index < unique.length; index += 30) {
    const chunk = unique.slice(index, index + 30);
    const snap = await db.collection("musica").where("leadId", "in", chunk).get();

    snap.docs.forEach((doc) => {
      const data = { id: doc.id, ...doc.data() };
      const previous = result.get(data.leadId);
      // Un lead puede tener varias canciones: interesa la mas reciente.
      if (!previous || toMillis(data.updatedAt) > toMillis(previous.updatedAt)) {
        result.set(data.leadId, data);
      }
    });
  }

  return result;
}

function minutesFrom(ms, now) {
  return ms ? Math.floor((now - ms) / 60000) : null;
}

function fmt(minutes) {
  if (minutes === null) return "un rato";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

function toMillis(value) {
  return value?.toDate?.()?.getTime?.() || 0;
}

/**
 * Historial de una conversacion para verla desde el panel. Se devuelve en orden
 * cronologico, que es como se lee un chat, aunque en Firestore convenga pedir
 * los ultimos en orden inverso.
 */
export async function getConversationMessages(leadId, { limit = 80 } = {}) {
  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("leadId", "==", leadId)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (conversationSnap.empty) throw new Error("Este lead no tiene una conversacion activa.");

  const conversationDoc = conversationSnap.docs[0];
  const conversation = conversationDoc.data();

  const [leadSnap, messagesSnap] = await Promise.all([
    db.collection(COLLECTIONS.leads).doc(leadId).get(),
    conversationDoc.ref.collection("messages").orderBy("createdAt", "desc").limit(Math.min(limit, 200)).get()
  ]);

  const lead = leadSnap.exists ? leadSnap.data() : {};

  const messages = messagesSnap.docs
    .map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        direction: data.direction,
        text: data.text || "",
        manual: Boolean(data.manual),
        followUp: data.followUp || null,
        replyToId: data.replyToId || null,
        replyToText: data.replyToText || "",
        replyToDirection: data.replyToDirection || null,
        mediaUrl: data.mediaUrl || null,
        mediaType: data.mediaType || null,
        createdAt: data.createdAt?.toDate?.()?.getTime?.() || null
      };
    })
    .reverse();

  return {
    messages,
    lead: {
      id: leadId,
      name: lead.name || "",
      phone: lead.phone || "",
      mode: conversation.mode || lead.mode || "ai",
      stage: conversation.stage || "",
      kanbanStage: lead.kanbanStage || ""
    }
  };
}

export async function setConversationMode(leadId, mode) {
  if (!["ai", "human"].includes(mode)) throw new Error("Modo invalido.");

  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("leadId", "==", leadId)
    .where("active", "==", true)
    .limit(1)
    .get();

  await Promise.all([
    db.collection(COLLECTIONS.leads).doc(leadId).update({ mode, updatedAt: FieldValue.serverTimestamp() }),
    conversationSnap.empty
      ? Promise.resolve()
      : conversationSnap.docs[0].ref.update({ mode, updatedAt: FieldValue.serverTimestamp() })
  ]);

  return { mode };
}

/**
 * Todo lo que un asesor necesita ver junto al chat: el brief que dio el cliente,
 * la letra, y los audios para escucharlos sin salir del panel.
 */
export async function getConversationDetail(leadId) {
  const conversationSnap = await db
    .collection(COLLECTIONS.conversations)
    .where("leadId", "==", leadId)
    .where("active", "==", true)
    .limit(1)
    .get();

  if (conversationSnap.empty) throw new Error("Este lead no tiene una conversacion activa.");

  const conversation = conversationSnap.docs[0].data();
  const [leadSnap, orderSnap] = await Promise.all([
    db.collection(COLLECTIONS.leads).doc(leadId).get(),
    conversation.songOrderId
      ? db.collection(COLLECTIONS.songOrders).doc(conversation.songOrderId).get()
      : Promise.resolve(null)
  ]);

  const lead = leadSnap.exists ? leadSnap.data() : {};
  const order = orderSnap?.exists ? orderSnap.data() : {};

  // Todas las canciones del cliente, no solo la del pedido abierto: al abrir un
  // segundo pedido las anteriores dejaban de verse y no habia forma de
  // entregarlas, ni siquiera a quien ya habia pagado.
  const songs = await getSongsByLead(leadId);

  let music = null;
  if (order.musicId) {
    const musicSnap = await db.collection("musica").doc(order.musicId).get();
    if (musicSnap.exists) {
      const data = musicSnap.data();
      music = {
        id: musicSnap.id,
        status: data.status || "",
        title: data.title || "",
        errorMsg: data.errorMsg || "",
        clipUrls: data.clipUrls || [],
        fullUrls: (data.fullVersions || []).map((item) => item.fullUrl).filter(Boolean).length
          ? data.fullVersions.map((item) => item.fullUrl).filter(Boolean)
          : data.fullUrls || [],
        fullDelivered: Boolean(data.fullDeliveredAt),
        fullDeliveredVersion: data.fullDeliveredVersion || null
      };
    }
  }

  return {
    songs,
    lead: {
      id: leadId,
      name: lead.name || "",
      phone: lead.phone || "",
      mode: conversation.mode || lead.mode || "ai",
      kanbanStage: lead.kanbanStage || "",
      source: lead.source || "",
      adTitle: lead.adTitle || "",
      createdAt: toMillis(lead.createdAt) || null
    },
    conversation: {
      id: conversationSnap.docs[0].id,
      stage: conversation.stage || "",
      summary: conversation.summary || ""
    },
    order: {
      id: conversation.songOrderId || null,
      purpose: order.purpose || "",
      recipient: order.recipient || "",
      nickname: order.nickname || "",
      relationship: order.relationship || "",
      genre: order.genre || "",
      referenceArtist: order.referenceArtist || "",
      voiceType: order.voiceType || "",
      clientName: order.clientName || "",
      story: order.story || "",
      lyrics: order.lyrics || "",
      lyricsApproved: Boolean(order.lyricsApproved),
      lyricsVersion: Number(order.lyricsVersion || 0),
      lyricsRevisionCount: Number(order.lyricsRevisionCount || 0),
      lyricsFromClient: Boolean(order.lyricsFromClient),
      musicId: order.musicId || null,
      musicStatus: order.musicStatus || "",
      missingFields: getMissingFields(order)
    },
    music
  };
}

async function getSongsByLead(leadId) {
  const snap = await db.collection("musica").where("leadId", "==", leadId).get();

  return snap.docs
    .map((doc) => {
      const data = doc.data();
      const fullVersions = (data.fullVersions || []).map((item) => item?.fullUrl).filter(Boolean);

      return {
        id: doc.id,
        title: data.title || "",
        status: data.status || "",
        errorMsg: data.errorMsg || "",
        clipUrls: data.clipUrls || [],
        fullUrls: fullVersions.length ? fullVersions : data.fullUrls || [],
        fullDelivered: Boolean(data.fullDeliveredAt),
        fullDeliveredVersion: data.fullDeliveredVersion || null,
        songOrderId: data.songOrderId || null,
        createdAt: toMillis(data.createdAt) || null
      };
    })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}
