import { Router } from "express";
import { z } from "zod";
import { deleteLeadAndData, listKanbanLeads, updateLeadKanbanStage } from "../services/songConversation/index.js";

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
