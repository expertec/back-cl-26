import { Router } from "express";
import { z } from "zod";
import { deleteLeadAndData, listKanbanLeads, updateLeadKanbanStage } from "../services/songConversation/index.js";
import { cancelMusic, getMusicOverview, retryMusic } from "../services/adminMonitor.js";
import { listEvents } from "../services/eventLog.js";
import { getConversationsHealth } from "../services/conversationMonitor.js";
import {
  forceApproveAndProduce,
  forceGenerateLyrics,
  forceProduce,
  releaseConversationLocks,
  sendManualMessage
} from "../services/adminActions.js";
import { runMusicPipeline } from "../jobs/musicPipeline.js";

export const adminRouter = Router();

const updateLeadSchema = z.object({
  kanbanStage: z.enum([
    "new",
    "discovery",
    "lyrics_review",
    "generating_song",
    "samples_sent",
    "opportunity",
    "won",
    "lost"
  ]),
  mode: z.enum(["ai", "human"]).optional()
});

adminRouter.get("/leads", async (_req, res) => {
  try {
    const leads = await listKanbanLeads();
    return res.json({ ok: true, leads });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudieron cargar leads."
    });
  }
});

adminRouter.patch("/leads/:leadId", async (req, res) => {
  const parsed = updateLeadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      ok: false,
      error: "Datos invalidos.",
      issues: parsed.error.flatten().fieldErrors
    });
  }

  try {
    await updateLeadKanbanStage({ leadId: req.params.leadId, ...parsed.data });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "No se pudo actualizar el lead."
    });
  }
});

adminRouter.delete("/leads/:leadId", async (req, res) => {
  const force = req.query.force === "true";

  try {
    const deleted = await deleteLeadAndData(req.params.leadId, { force });
    return res.json({ ok: true, deleted });
  } catch (error) {
    const notFound = /no encontrado/i.test(error.message);
    const blocked = /no lo creo el bot/i.test(error.message);

    return res.status(notFound ? 404 : blocked ? 409 : 500).json({
      ok: false,
      error: error.message || "No se pudo borrar el lead.",
      ...(blocked ? { needsForce: true } : {})
    });
  }
});

adminRouter.get("/songs", async (req, res) => {
  try {
    const overview = await getMusicOverview({
      limit: Number(req.query.limit || 60),
      status: req.query.status || undefined
    });
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, ...overview });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "No se pudieron cargar las canciones." });
  }
});

adminRouter.get("/events", async (req, res) => {
  try {
    const events = await listEvents({
      limit: Number(req.query.limit || 100),
      level: req.query.level || undefined,
      musicId: req.query.musicId || undefined
    });
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, events });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "No se pudieron cargar los eventos." });
  }
});

adminRouter.post("/songs/:musicId/retry", async (req, res) => {
  try {
    const result = await retryMusic(req.params.musicId);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "No se pudo reintentar." });
  }
});

adminRouter.post("/songs/:musicId/cancel", async (req, res) => {
  try {
    const result = await cancelMusic(req.params.musicId);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "No se pudo cancelar." });
  }
});

adminRouter.post("/pipeline/run", async (_req, res) => {
  try {
    const result = await runMusicPipeline();
    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "No se pudo correr el pipeline." });
  }
});

adminRouter.get("/conversations", async (req, res) => {
  try {
    const health = await getConversationsHealth({ limit: Number(req.query.limit || 120) });
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, ...health });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || "No se pudo cargar el estado." });
  }
});

const CONVERSATION_ACTIONS = {
  generar_letra: forceGenerateLyrics,
  aprobar_y_producir: forceApproveAndProduce,
  producir: forceProduce,
  liberar_locks: releaseConversationLocks
};

adminRouter.post("/conversations/:leadId/:action", async (req, res) => {
  const { leadId, action } = req.params;

  try {
    if (action === "mensaje") {
      const result = await sendManualMessage(leadId, req.body?.message);
      return res.json({ ok: true, ...result });
    }

    const handler = CONVERSATION_ACTIONS[action];
    if (!handler) return res.status(400).json({ ok: false, error: `Accion desconocida: ${action}` });

    const result = await handler(leadId);
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message || "No se pudo completar la accion." });
  }
});
