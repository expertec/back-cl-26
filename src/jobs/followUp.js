import { db, FieldValue } from "../firebase.js";
import { getBotSettings, renderTemplate } from "../services/botSettings.js";
import { logEvent } from "../services/eventLog.js";
import { COLLECTIONS, CONVERSATION_STAGES } from "../services/songConversation/constants.js";
import { sendText } from "../services/whatsapp/index.js";

/**
 * El momento de mayor intencion de compra es justo despues de escuchar la
 * muestra, y hasta ahora nadie decia nada: la conversacion terminaba con los
 * audios y ahi moria la venta.
 */
export async function sendPendingFollowUps(limit = 20) {
  const settings = await getBotSettings();
  if (!settings.followUpEnabled && !settings.secondFollowUpEnabled) return 0;

  const snap = await db
    .collection(COLLECTIONS.conversations)
    .where("active", "==", true)
    .where("stage", "==", CONVERSATION_STAGES.SAMPLES_SENT)
    .limit(limit)
    .get();

  if (snap.empty) return 0;

  let sent = 0;

  for (const doc of snap.docs) {
    const conversation = doc.data();
    const step = pickStep(conversation, settings);
    if (!step) continue;

    try {
      const lead = await getLead(conversation.leadId);
      if (!lead) continue;
      // A quien ya esta atendiendo una persona no le escribe el bot encima.
      if ((conversation.mode || lead.mode) === "human") continue;

      const message = renderTemplate(step.message, {
        nombre: firstName(lead.name),
        telefono: lead.phone || ""
      }).trim();

      if (!message) continue;

      await sendText({
        phone: lead.waJid || lead.phone,
        message,
        idempotencyKey: `${doc.id}-${step.field}`
      });

      await doc.ref.update({
        [step.field]: FieldValue.serverTimestamp(),
        lastBotReply: message,
        lastBotReplyAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      await doc.ref.collection("messages").add({
        direction: "out",
        text: message,
        followUp: step.field,
        createdAt: FieldValue.serverTimestamp()
      });

      logEvent({
        level: "info",
        scope: "seguimiento",
        message: `Seguimiento enviado (${step.field})`,
        leadId: conversation.leadId,
        phone: lead.phone
      });

      sent += 1;
    } catch (error) {
      console.error("[seguimiento] fallo el envio", { conversationId: doc.id, error: error.message });
      logEvent({
        level: "error",
        scope: "seguimiento",
        message: "No se pudo enviar el seguimiento",
        leadId: conversation.leadId,
        detail: error.message
      });
    }
  }

  return sent;
}

function pickStep(conversation, settings) {
  const samplesAt = toMillis(conversation.stageUpdatedAt);
  if (!samplesAt) return null;

  const minutes = (Date.now() - samplesAt) / 60000;

  if (settings.followUpEnabled && !conversation.followUpSentAt && minutes >= settings.followUpDelayMinutes) {
    return { field: "followUpSentAt", message: settings.followUpMessage };
  }

  if (
    settings.secondFollowUpEnabled &&
    conversation.followUpSentAt &&
    !conversation.secondFollowUpSentAt &&
    minutes >= settings.secondFollowUpDelayMinutes
  ) {
    return { field: "secondFollowUpSentAt", message: settings.secondFollowUpMessage };
  }

  return null;
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
