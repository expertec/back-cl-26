import { Router } from "express";
import { config } from "../config.js";
import { normalizeIncomingMessage } from "../services/whatsapp/index.js";
import { processIncomingWhatsappMessage } from "../services/songConversation/index.js";
import {
  connectBaileysSession,
  getBaileysSessionState,
  logoutBaileysSession,
  restoreBaileysSessions,
  setBaileysInboundHandler
} from "../services/whatsapp/baileysSessionService.js";

export const whatsappRouter = Router();

export async function bootstrapWhatsappProvider() {
  if (!config.enableBaileys) return;

  setBaileysInboundHandler(async (payload) => {
    const incoming = normalizeIncomingMessage(payload);
    await processIncomingWhatsappMessage(incoming);
  });

  await restoreBaileysSessions();
  if (config.whatsappProvider === "baileys") {
    await connectBaileysSession(config.baileysSessionId);
  }
}

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

whatsappRouter.post("/session/connect", async (req, res) => {
  try {
    const session = await connectBaileysSession(req.body?.sessionId || config.baileysSessionId);
    return res.json({ ok: true, session });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo conectar Baileys."
    });
  }
});

whatsappRouter.get("/session", (req, res) => {
  try {
    const session = getBaileysSessionState(req.query.sessionId || config.baileysSessionId);
    return res.json({ ok: true, session });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error.message || "No se pudo consultar la sesion."
    });
  }
});

whatsappRouter.post("/session/logout", async (req, res) => {
  try {
    const session = await logoutBaileysSession(req.body?.sessionId || config.baileysSessionId);
    return res.json({ ok: true, session });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo cerrar la sesion."
    });
  }
});
