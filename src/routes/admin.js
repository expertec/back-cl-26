import { Router } from "express";
import { z } from "zod";
import { listKanbanLeads, updateLeadKanbanStage } from "../services/songConversation/index.js";

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
