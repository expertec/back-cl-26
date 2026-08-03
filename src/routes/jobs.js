import { Router } from "express";
import { assertJobAccess } from "../utils/jobAuth.js";
import { processReadyAudio, resetStuckMusic, runMusicPipeline, sendReadySongs } from "../jobs/musicPipeline.js";

export const jobsRouter = Router();

jobsRouter.post("/pipeline", assertJobAccess, async (_req, res) => {
  const result = await runMusicPipeline();
  res.json({ ok: true, result });
});

jobsRouter.post("/clips", assertJobAccess, async (_req, res) => {
  const processed = await processReadyAudio();
  res.json({ ok: true, processed });
});

jobsRouter.post("/send-ready", assertJobAccess, async (_req, res) => {
  const processed = await sendReadySongs();
  res.json({ ok: true, processed });
});

jobsRouter.post("/reset-stuck", assertJobAccess, async (req, res) => {
  const threshold = Number(req.body?.thresholdMinutes || 30);
  const reset = await resetStuckMusic(threshold);
  res.json({ ok: true, reset });
});
