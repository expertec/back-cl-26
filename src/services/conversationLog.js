import { db, FieldValue } from "../firebase.js";
import { COLLECTIONS } from "./songConversation/constants.js";

/**
 * Deja constancia en la conversacion de lo que se envio por fuera del flujo de
 * chat: los clips y la cancion completa. Sin esto, el panel no mostraba los
 * audios y no habia forma de saber si le llegaron al cliente.
 */
export async function logOutboundMedia({ conversationId, text, mediaUrl, mediaType = "audio", meta = {} }) {
  if (!conversationId) return null;

  try {
    const conversationRef = db.collection(COLLECTIONS.conversations).doc(conversationId);

    await conversationRef.collection("messages").add({
      direction: "out",
      text: text || "",
      mediaUrl: mediaUrl || null,
      mediaType,
      ...meta,
      createdAt: FieldValue.serverTimestamp()
    });

    await conversationRef.update({
      lastBotReply: text || "Audio enviado",
      lastBotReplyAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return true;
  } catch (error) {
    // El audio ya salio: no registrarlo no puede tumbar la entrega.
    console.error("[conversacion] no se pudo registrar el envio", { conversationId, error: error.message });
    return false;
  }
}
