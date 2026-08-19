import { Router } from "express";
import { config } from "../config.js";
import { normalizeIncomingMessage } from "../services/whatsapp/index.js";
import { bufferIncomingMessage } from "../services/whatsapp/inboundBuffer.js";
import { shouldEngage } from "../services/whatsapp/botPolicy.js";
import { processIncomingWhatsappMessage } from "../services/songConversation/index.js";
import {
  connectBaileysSession,
  getBaileysSessionState,
  logoutBaileysSession,
  restoreBaileysSessions,
  setBaileysInboundHandler,
  startBaileysWatchdog
} from "../services/whatsapp/baileysSessionService.js";

export const whatsappRouter = Router();

export async function bootstrapWhatsappProvider() {
  if (!config.enableBaileys) {
    console.warn(
      "[whatsapp/bootstrap] Baileys deshabilitado: los mensajes entrantes NO se van a procesar.",
      {
        whatsappProvider: config.whatsappProvider,
        fix: "Define WHATSAPP_PROVIDER=baileys (o ENABLE_BAILEYS=true) y redespliega."
      }
    );
    return;
  }

  setBaileysInboundHandler(async (payload) => {
    const incoming = normalizeIncomingMessage(payload);
    console.log("[whatsapp/inbound]", {
      provider: incoming.provider,
      phone: incoming.phone,
      messageId: incoming.messageId,
      chars: incoming.text.length,
      ...(payload.transcribed ? { transcrito: true } : {}),
      ...(payload.ad ? { campaña: payload.ad.sourceId || payload.ad.ctwaClid || "si" } : {})
    });

    const policy = await shouldEngage(incoming);
    if (!policy.engage) {
      console.log("[whatsapp/inbound] ignorado", { phone: incoming.phone, motivo: policy.reason });
      return;
    }

    await bufferIncomingMessage(incoming, async (merged) => {
      const result = await processIncomingWhatsappMessage(merged);

      console.log("[whatsapp/inbound] procesado", {
        phone: merged.phone,
        mensajes: merged.bufferedCount || 1,
        stage: result.stage || null,
        replied: Boolean(result.reply),
        skipped: result.skipped || result.duplicate || false
      });
    });
  });

  const restored = await restoreBaileysSessions();
  if (config.whatsappProvider === "baileys" && !restored) {
    await connectBaileysSession(config.baileysSessionId);
  }

  startBaileysWatchdog();

  console.log("[whatsapp/bootstrap] listo", {
    provider: config.whatsappProvider,
    sessionId: config.baileysSessionId,
    authStore: "firestore"
  });
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
    res.set("Cache-Control", "no-store");
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
