import { db, FieldValue } from "../firebase.js";
import { getBotSettings, renderTemplate } from "../services/botSettings.js";
import { logEvent } from "../services/eventLog.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "../services/songConversation/constants.js";
import { sendText } from "../services/whatsapp/index.js";

/**
 * Recordatorios a quien ya escucho su muestra y no ha comprado. El momento de
 * mayor intencion es justo despues de escucharla, y despues se enfria: sin esto
 * la conversacion terminaba con los audios y ahi moria la venta.
 */
export async function sendPendingFollowUps(limit = 30) {
  const settings = await getBotSettings();
  const pasos = (settings.followUps || []).filter((paso) => paso.enabled && paso.message);
  if (!pasos.length) return 0;

  const snap = await db
    .collection(COLLECTIONS.conversations)
    .where("active", "==", true)
    .where("stage", "==", CONVERSATION_STAGES.SAMPLES_SENT)
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  let enviados = 0;

  for (const doc of snap.docs) {
    const conversation = doc.data();

    try {
      const lead = await getLead(conversation.leadId);
      if (!lead) continue;
      if (await yaCompro(conversation.leadId)) continue;

      const paso = elegirPaso({ conversation, lead, pasos, settings });
      if (!paso) continue;

      const message = renderTemplate(paso.message, {
        nombre: firstName(lead.name),
        telefono: lead.phone || ""
      }).trim();

      if (!message) continue;

      await sendText({
        phone: lead.waJid || lead.phone,
        message,
        idempotencyKey: `${doc.id}-followup-${paso.indice}`
      });

      await doc.ref.update({
        followUpStep: paso.indice + 1,
        lastFollowUpAt: FieldValue.serverTimestamp(),
        lastBotReply: message,
        lastBotReplyAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      await doc.ref.collection("messages").add({
        direction: "out",
        text: message,
        followUp: `paso-${paso.indice + 1}`,
        createdAt: FieldValue.serverTimestamp()
      });

      logEvent({
        level: "info",
        scope: "seguimiento",
        message: `Recordatorio ${paso.indice + 1} enviado`,
        leadId: conversation.leadId,
        phone: lead.phone
      });

      enviados += 1;
    } catch (error) {
      console.error("[seguimiento] fallo el envio", { conversationId: doc.id, error: error.message });
      logEvent({
        level: "error",
        scope: "seguimiento",
        message: "No se pudo enviar el recordatorio",
        leadId: conversation.leadId,
        detail: error.message
      });
    }
  }

  return enviados;
}

function elegirPaso({ conversation, lead, pasos, settings }) {
  const desde = toMillis(conversation.stageUpdatedAt);
  if (!desde) return null;

  const enviados = Number(conversation.followUpStep || 0);
  if (enviados >= pasos.length) return null;

  // Al cliente que acaba de escribir se le contesta, no se le manda una
  // plantilla: recibir "¿que tal quedo tu cancion?" cuando llevas dos mensajes
  // sin respuesta es peor que no recibir nada.
  const ultimoDelCliente = toMillis(lead.lastMessageAt);
  const ultimaRespuesta = toMillis(conversation.lastBotReplyAt);
  if (ultimoDelCliente && ultimoDelCliente > ultimaRespuesta) return null;

  // Con una persona atendiendo, el bot espera: no le escribe encima a un asesor
  // que esta negociando, pero tampoco abandona al que nadie atendio.
  const enManosHumanas = (conversation.mode || lead.mode) === "human";
  if (enManosHumanas) {
    const gracia = Number(settings.humanTakeoverGraceHours || 6) * 60 * 60 * 1000;
    const desdeUltimaActividad = Date.now() - Math.max(ultimaRespuesta, ultimoDelCliente);
    if (desdeUltimaActividad < gracia) return null;
  }

  const minutos = (Date.now() - desde) / 60000;
  const paso = pasos[enviados];

  return minutos >= paso.delayMinutes ? { ...paso, indice: enviados } : null;
}

/**
 * Quien ya pago no recibe recordatorios de venta: es la forma mas rapida de
 * arruinar una compra que ya salio bien.
 */
async function yaCompro(leadId) {
  const snap = await db
    .collection("musica")
    .where("leadId", "==", leadId)
    .where("paid", "==", true)
    .limit(1)
    .get();

  return !snap.empty;
}

async function getLead(leadId) {
  if (!leadId) return null;
  const snap = await db.collection(COLLECTIONS.leads).doc(leadId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

function toMillis(value) {
  return value?.toDate?.()?.getTime?.() || 0;
}
