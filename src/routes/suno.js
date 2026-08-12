import { Router } from "express";
import { db, FieldValue } from "../firebase.js";
import { extractAudioUrlsFromCallback, extractTaskIdFromCallback } from "../services/sunoService.js";
import { persistSunoAudioResult, processReadyAudio } from "../jobs/musicPipeline.js";

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
    const audioUrls = extractAudioUrlsFromCallback(req.body);
    const callbackType = String(req.body?.data?.callbackType || "");
    const normalizedCallbackType = callbackType.toUpperCase();
    const isPartialCallback = normalizedCallbackType.includes("FIRST");
    const isCompleteCallback =
      (normalizedCallbackType.includes("COMPLETE") || normalizedCallbackType.includes("SUCCESS")) && !isPartialCallback;

    if (!audioUrls.length || (audioUrls.length < 2 && !isCompleteCallback)) {
      await doc.ref.update({
        sunoCallbackReceivedAt: FieldValue.serverTimestamp(),
        sunoCallbackType: callbackType || null,
        sunoCallbackAudioCount: audioUrls.length,
        updatedAt: FieldValue.serverTimestamp()
      });
      return res.json({ ok: true, message: "Callback recibido sin todas las versiones finales." });
    }

    const persisted = await persistSunoAudioResult(doc, {
      taskId,
      audioUrls,
      source: "callback",
      rawCallback: req.body
    });

    if (persisted) {
      processReadyAudio(1).catch((error) => {
        console.error("[suno/callback] clip trigger failed:", error);
      });
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("[suno/callback]", error);
    return res.status(500).json({
      ok: false,
      error: error.message || "Error procesando callback de Suno."
    });
  }
});
