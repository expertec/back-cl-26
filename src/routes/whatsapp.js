import { Router } from "express";
import { normalizeIncomingMessage } from "../services/whatsapp/index.js";
import { processIncomingWhatsappMessage } from "../services/songConversation/index.js";

export const whatsappRouter = Router();

whatsappRouter.post("/incoming", async (req, res) => {
  const incoming = normalizeIncomingMessage(req.body);

  try {
    const result = await processIncomingWhatsappMessage(incoming);
    return res.json({ ok: true, result });
  } catch (error) {
    console.error("[whatsapp/incoming]", {
      messageId: incoming.messageId,
      phone: incoming.phone,
      error: error.message
    });
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo procesar el mensaje."
    });
  }
});
