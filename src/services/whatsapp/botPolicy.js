import { config } from "../../config.js";
import { db } from "../../firebase.js";
import { normalizePhone } from "../../schemas.js";
import { COLLECTIONS } from "../songConversation/constants.js";
import { isSavedContact } from "./contactsRegistry.js";

/**
 * Decide si el bot debe contestarle a quien escribe. Sirve para que no se
 * active con los contactos personales de la cuenta, que escriben al mismo
 * numero que los leads de campaña.
 */
export async function shouldEngage(incoming) {
  const phone = normalizePhone(incoming.phone);

  if (config.botIgnoreNumbers.includes(phone)) {
    return { engage: false, reason: "numero-en-lista-de-exclusion" };
  }

  if (config.botActivationMode === "all") {
    return { engage: true, reason: "modo-all" };
  }

  // A quien ya venia conversando con el bot no se le corta a media cancion,
  // aunque despues lo guarden en la libreta o cambie la politica.
  if (await hasActiveConversation(phone)) {
    return { engage: true, reason: "conversacion-en-curso" };
  }

  if (incoming.ad?.ctwaClid || incoming.ad?.sourceId) {
    return { engage: true, reason: "viene-de-campaña" };
  }

  if (config.botActivationMode === "ads_only") {
    return { engage: false, reason: "no-viene-de-campaña" };
  }

  if (config.botActivationMode === "skip_contacts") {
    if (isSavedContact(incoming.sessionId || config.baileysSessionId, phone)) {
      return { engage: false, reason: "contacto-guardado" };
    }
    return { engage: true, reason: "no-es-contacto" };
  }

  return { engage: true, reason: "modo-desconocido" };
}

async function hasActiveConversation(phone) {
  try {
    const leadSnap = await db.collection(COLLECTIONS.leads).where("phone", "==", phone).limit(1).get();
    if (leadSnap.empty) return false;

    const lead = leadSnap.docs[0];
    // Un lead heredado del CRM anterior no cuenta como conversacion del bot.
    if (!lead.data().waJid && !lead.data().mode) return false;

    const conversationSnap = await db
      .collection(COLLECTIONS.conversations)
      .where("leadId", "==", lead.id)
      .where("active", "==", true)
      .limit(1)
      .get();

    return !conversationSnap.empty;
  } catch (error) {
    // Ante la duda, atender: es peor dejar sin respuesta a un cliente real.
    console.error("[politica] no se pudo verificar la conversacion", { phone, error: error.message });
    return true;
  }
}
