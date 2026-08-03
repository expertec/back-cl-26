import { Router } from "express";
import { db, FieldValue } from "../firebase.js";
import { persistFullAudio } from "../services/audioService.js";
import { extractAudioUrlFromCallback, extractTaskIdFromCallback } from "../services/sunoService.js";
import { processReadyAudio } from "../jobs/musicPipeline.js";

export const sunoRouter = Router();

sunoRouter.post("/callback", async (req, res) => {
  const taskId = extractTaskIdFromCallback(req.body);
  if (!taskId) return res.status(400).json({ ok: false, error: "Callback sin taskId." });

  try {
    console.log("[suno/callback] received", {
      taskId,
      code: req.body?.code,
      callbackType: req.body?.data?.callbackType
    });

    const snap = await db.collection("musica").where("taskId", "==", taskId).limit(1).get();
    if (snap.empty) {
      return res.status(404).json({ ok: false, error: "No hay pedido para este taskId." });
    }

    const doc = snap.docs[0];
    const audioUrl = extractAudioUrlFromCallback(req.body);

    if (!audioUrl) {
      await doc.ref.update({
        status: "Procesando musica",
        sunoCallbackReceivedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
      return res.json({ ok: true, message: "Callback recibido sin audio final." });
    }

    const fullUrl = await persistFullAudio({
      musicId: doc.id,
      taskId,
      audioUrl
    });

    await doc.ref.update({
      fullUrl,
      status: "Audio listo",
      sunoRawCallback: req.body,
      sunoCallbackReceivedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    processReadyAudio(1).catch((error) => {
      console.error("[suno/callback] clip trigger failed:", error);
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("[suno/callback]", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Error procesando callback de Suno."
    });
  }
});
