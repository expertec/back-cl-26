import { db, FieldValue } from "../firebase.js";
import { createLyrics, createMusicPrompt } from "../services/openaiService.js";
import { extractAudioUrlFromRecordInfo, getSunoGenerationDetails, submitSunoSong } from "../services/sunoService.js";
import { createWatermarkedClip, persistFullAudio } from "../services/audioService.js";
import { sendSongWithKanwap } from "../services/kanwapService.js";

const MUSIC_COLLECTION = "musica";

async function getFirstByStatus(status, limit = 1) {
  return db.collection(MUSIC_COLLECTION).where("status", "==", status).limit(limit).get();
}

async function moveStatus(ref, status, extra = {}) {
  await ref.update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
    ...extra
  });
  console.log("[music] status", { id: ref.id, status });
}

async function processLyrics() {
  const snap = await getFirstByStatus("Sin letra");
  if (snap.empty) return 0;

  const doc = snap.docs[0];
  console.log("[pipeline] generating lyrics", { id: doc.id });
  await moveStatus(doc.ref, "Generando letra", {
    lyricsProcessingStartedAt: FieldValue.serverTimestamp()
  });

  try {
    const song = { id: doc.id, ...doc.data() };
    const lyrics = await createLyrics(song);
    console.log("[pipeline] lyrics generated", { id: doc.id, chars: lyrics.length });

    await moveStatus(doc.ref, "Sin prompt", {
      lyrics,
      lyricsGeneratedAt: FieldValue.serverTimestamp()
    });
    return 1;
  } catch (error) {
    await moveStatus(doc.ref, "Error letra", {
      errorMsg: error.message,
      errorAt: FieldValue.serverTimestamp()
    });
    return 1;
  }
}

async function processPrompt() {
  const snap = await getFirstByStatus("Sin prompt");
  if (snap.empty) return 0;

  const doc = snap.docs[0];
  console.log("[pipeline] generating prompt", { id: doc.id });
  await moveStatus(doc.ref, "Generando prompt", {
    promptProcessingStartedAt: FieldValue.serverTimestamp()
  });

  try {
    const song = { id: doc.id, ...doc.data() };
    const stylePrompt = await createMusicPrompt(song);
    console.log("[pipeline] prompt generated", { id: doc.id, stylePrompt });

    await moveStatus(doc.ref, "Sin musica", {
      stylePrompt,
      promptGeneratedAt: FieldValue.serverTimestamp()
    });
    return 1;
  } catch (error) {
    await moveStatus(doc.ref, "Error prompt", {
      errorMsg: error.message,
      errorAt: FieldValue.serverTimestamp()
    });
    return 1;
  }
}

async function processSunoSubmission() {
  const snap = await getFirstByStatus("Sin musica");
  if (snap.empty) return 0;

  const doc = snap.docs[0];
  console.log("[pipeline] submitting to suno", { id: doc.id });
  await moveStatus(doc.ref, "Procesando musica", {
    musicProcessingStartedAt: FieldValue.serverTimestamp()
  });

  try {
    const song = { id: doc.id, ...doc.data() };
    const taskId = await submitSunoSong(song);

    await moveStatus(doc.ref, "Procesando musica", {
      taskId,
      taskSubmittedAt: FieldValue.serverTimestamp()
    });
    return 1;
  } catch (error) {
    await moveStatus(doc.ref, "Error musica", {
      errorMsg: error.message,
      errorAt: FieldValue.serverTimestamp()
    });
    return 1;
  }
}

export async function pollSunoResults(limit = 5) {
  const snap = await getFirstByStatus("Procesando musica", limit);
  if (snap.empty) return 0;

  let processed = 0;

  for (const doc of snap.docs) {
    const song = { id: doc.id, ...doc.data() };
    if (!song.taskId) continue;

    try {
      const details = await getSunoGenerationDetails(song.taskId);
      const sunoStatus = details?.status || "UNKNOWN";
      const audioUrl = extractAudioUrlFromRecordInfo(details);

      console.log("[suno] poll", {
        musicId: doc.id,
        taskId: song.taskId,
        sunoStatus,
        hasAudio: Boolean(audioUrl)
      });

      await doc.ref.update({
        sunoStatus,
        sunoLastPolledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      if (["FIRST_SUCCESS", "SUCCESS"].includes(sunoStatus) && audioUrl) {
        const fullUrl = await persistFullAudio({
          musicId: doc.id,
          taskId: song.taskId,
          audioUrl
        });

        await moveStatus(doc.ref, "Audio listo", {
          fullUrl,
          sunoRecordInfo: details,
          sunoPolledReadyAt: FieldValue.serverTimestamp()
        });
      } else if (
        ["CREATE_TASK_FAILED", "GENERATE_AUDIO_FAILED", "CALLBACK_EXCEPTION", "SENSITIVE_WORD_ERROR", "FAILED"].includes(
          sunoStatus
        )
      ) {
        await moveStatus(doc.ref, "Error musica", {
          errorMsg: details?.errorMessage || `Suno status: ${sunoStatus}`,
          errorAt: FieldValue.serverTimestamp(),
          sunoRecordInfo: details
        });
      }

      processed += 1;
    } catch (error) {
      console.error("[suno] poll error", {
        musicId: doc.id,
        taskId: song.taskId,
        error: error.message
      });
      await doc.ref.update({
        sunoPollError: error.message,
        sunoLastPolledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });
    }
  }

  return processed;
}

export async function processReadyAudio(limit = 3) {
  const snap = await getFirstByStatus("Audio listo", limit);
  if (snap.empty) return 0;

  let processed = 0;

  for (const doc of snap.docs) {
    const song = { id: doc.id, ...doc.data() };

    if (!song.fullUrl) {
      await moveStatus(doc.ref, "Error sin fullUrl", {
        errorMsg: "fullUrl no disponible."
      });
      processed += 1;
      continue;
    }

    await moveStatus(doc.ref, "Generando clip", {
      clipProcessingStartedAt: FieldValue.serverTimestamp()
    });

    try {
      const clipUrl = await createWatermarkedClip({
        musicId: doc.id,
        fullUrl: song.fullUrl
      });

      await moveStatus(doc.ref, "Enviar musica", {
        clipUrl,
        clipGeneratedAt: FieldValue.serverTimestamp()
      });
    } catch (error) {
      await moveStatus(doc.ref, "Error clip", {
        errorMsg: error.message,
        errorAt: FieldValue.serverTimestamp()
      });
    }

    processed += 1;
  }

  return processed;
}

export async function sendReadySongs(limit = 3) {
  const snap = await getFirstByStatus("Enviar musica", limit);
  if (snap.empty) return 0;

  let processed = 0;

  for (const doc of snap.docs) {
    const song = { id: doc.id, ...doc.data() };

    if (!song.leadPhone || !song.lyrics || !song.clipUrl) {
      await moveStatus(doc.ref, "Error envio", {
        errorMsg: "Faltan leadPhone, lyrics o clipUrl."
      });
      processed += 1;
      continue;
    }

    await moveStatus(doc.ref, "Enviando musica", {
      sendingStartedAt: FieldValue.serverTimestamp()
    });

    try {
      const delivery = await sendSongWithKanwap(song);

      await moveStatus(doc.ref, "Enviada", {
        sentAt: FieldValue.serverTimestamp(),
        delivery
      });
    } catch (error) {
      await moveStatus(doc.ref, "Error envio", {
        errorMsg: error.message,
        errorAt: FieldValue.serverTimestamp()
      });
    }

    processed += 1;
  }

  return processed;
}

export async function runMusicPipeline() {
  const results = {
    lyrics: await processLyrics(),
    prompts: await processPrompt(),
    suno: await processSunoSubmission(),
    sunoPoll: await pollSunoResults(),
    clips: await processReadyAudio(),
    sent: await sendReadySongs()
  };

  return results;
}

export async function resetStuckMusic(thresholdMinutes = 30) {
  const stuckStatuses = ["Generando letra", "Generando prompt", "Procesando musica", "Generando clip", "Enviando musica"];
  const snap = await db.collection(MUSIC_COLLECTION).where("status", "in", stuckStatuses).limit(20).get();
  const cutoff = Date.now() - thresholdMinutes * 60 * 1000;
  let reset = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const startedAt =
      data.lyricsProcessingStartedAt?.toDate?.()?.getTime?.() ||
      data.promptProcessingStartedAt?.toDate?.()?.getTime?.() ||
      data.musicProcessingStartedAt?.toDate?.()?.getTime?.() ||
      data.clipProcessingStartedAt?.toDate?.()?.getTime?.() ||
      data.sendingStartedAt?.toDate?.()?.getTime?.() ||
      0;

    if (!startedAt || startedAt >= cutoff) continue;

    const previousStatus =
      data.status === "Generando letra"
        ? "Sin letra"
        : data.status === "Generando prompt"
          ? "Sin prompt"
          : data.status === "Procesando musica"
            ? "Sin musica"
            : data.status === "Generando clip"
              ? "Audio listo"
              : "Enviar musica";

    await moveStatus(doc.ref, previousStatus, {
      errorMsg: "Reiniciado por timeout"
    });
    reset += 1;
  }

  return reset;
}
