import { db, FieldValue } from "../firebase.js";
import { createLyrics, createMusicPrompt } from "../services/openaiService.js";
import { extractAudioUrlsFromRecordInfo, getSunoGenerationDetails, submitSunoSong } from "../services/sunoService.js";
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

function getStartedAtForStatus(data) {
  const startedAtByStatus = {
    "Generando letra": data.lyricsProcessingStartedAt,
    "Generando prompt": data.promptProcessingStartedAt,
    "Procesando musica": data.musicProcessingStartedAt,
    "Guardando audio": data.audioPersistStartedAt,
    "Generando clip": data.clipProcessingStartedAt,
    "Enviando musica": data.sendingStartedAt
  };

  return startedAtByStatus[data.status]?.toDate?.()?.getTime?.() || 0;
}

function normalizeFullVersions(song) {
  if (Array.isArray(song.fullVersions) && song.fullVersions.length) {
    return song.fullVersions
      .filter((item) => item?.fullUrl)
      .map((item, index) => ({
        version: Number(item.version || index + 1),
        fullUrl: item.fullUrl
      }))
      .slice(0, 2);
  }

  if (Array.isArray(song.fullUrls) && song.fullUrls.length) {
    return song.fullUrls
      .filter(Boolean)
      .map((fullUrl, index) => ({ version: index + 1, fullUrl }))
      .slice(0, 2);
  }

  return song.fullUrl ? [{ version: 1, fullUrl: song.fullUrl }] : [];
}

function getClipUrls(song) {
  if (Array.isArray(song.clipVersions) && song.clipVersions.length) {
    return song.clipVersions.map((item) => item?.clipUrl).filter(Boolean).slice(0, 2);
  }

  if (Array.isArray(song.clipUrls) && song.clipUrls.length) {
    return song.clipUrls.filter(Boolean).slice(0, 2);
  }

  return song.clipUrl ? [song.clipUrl] : [];
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
      const audioUrls = extractAudioUrlsFromRecordInfo(details);

      console.log("[suno] poll", {
        musicId: doc.id,
        taskId: song.taskId,
        sunoStatus,
        audioCount: audioUrls.length
      });

      await doc.ref.update({
        sunoStatus,
        sunoLastPolledAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      });

      if ((sunoStatus === "SUCCESS" && audioUrls.length > 0) || (sunoStatus === "FIRST_SUCCESS" && audioUrls.length >= 2)) {
        await persistSunoAudioResult(doc, {
          taskId: song.taskId,
          audioUrls,
          source: "poll",
          recordInfo: details
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

export async function persistSunoAudioResult(doc, { taskId, audioUrl, audioUrls, source, recordInfo, rawCallback }) {
  const sourceAudioUrls = Array.isArray(audioUrls) && audioUrls.length ? audioUrls.slice(0, 2) : [audioUrl].filter(Boolean);

  const lock = await db.runTransaction(async (transaction) => {
    const fresh = await transaction.get(doc.ref);
    if (!fresh.exists) {
      return { locked: false, reason: "missing-doc" };
    }

    const data = fresh.data();
    if (data.fullUrl || data.fullUrls?.length || ["Audio listo", "Generando clip", "Enviar musica", "Enviando musica", "Enviada"].includes(data.status)) {
      return { locked: false, reason: `already-${data.status}` };
    }

    if (data.status !== "Procesando musica") {
      return { locked: false, reason: `status-${data.status}` };
    }

    transaction.update(doc.ref, {
      status: "Guardando audio",
      audioPersistSource: source,
      audioPersistStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });

    return { locked: true };
  });

  if (!lock.locked) {
    console.log("[audio] persist skipped", {
      musicId: doc.id,
      taskId,
      source,
      reason: lock.reason
    });
    return false;
  }

  try {
    if (!sourceAudioUrls.length) throw new Error("Suno no devolvio audio final.");

    const fullVersions = [];

    for (const [index, sourceAudioUrl] of sourceAudioUrls.entries()) {
      const version = index + 1;
      const fullUrl = await persistFullAudio({
        musicId: doc.id,
        taskId,
        audioUrl: sourceAudioUrl,
        version
      });

      fullVersions.push({ version, fullUrl });
    }

    const fullUrls = fullVersions.map((item) => item.fullUrl);

    await moveStatus(doc.ref, "Audio listo", {
      fullUrl: fullUrls[0],
      fullUrls,
      fullVersions,
      audioVersionCount: fullVersions.length,
      audioPersistCompletedAt: FieldValue.serverTimestamp(),
      audioPersistError: FieldValue.delete(),
      sunoPollError: FieldValue.delete(),
      ...(recordInfo ? { sunoRecordInfo: recordInfo, sunoPolledReadyAt: FieldValue.serverTimestamp() } : {}),
      ...(rawCallback ? { sunoRawCallback: rawCallback, sunoCallbackReceivedAt: FieldValue.serverTimestamp() } : {})
    });

    return true;
  } catch (error) {
    await moveStatus(doc.ref, "Procesando musica", {
      audioPersistError: error.message,
      audioPersistErrorAt: FieldValue.serverTimestamp()
    });
    throw error;
  }
}

export async function processReadyAudio(limit = 3) {
  const snap = await getFirstByStatus("Audio listo", limit);
  if (snap.empty) return 0;

  let processed = 0;

  for (const doc of snap.docs) {
    const song = { id: doc.id, ...doc.data() };
    const fullVersions = normalizeFullVersions(song);

    if (!fullVersions.length) {
      await moveStatus(doc.ref, "Error sin fullUrl", {
        errorMsg: "fullUrl/fullUrls no disponible."
      });
      processed += 1;
      continue;
    }

    await moveStatus(doc.ref, "Generando clip", {
      clipProcessingStartedAt: FieldValue.serverTimestamp()
    });

    try {
      const clipVersions = [];

      for (const versionInfo of fullVersions) {
        const clipUrl = await createWatermarkedClip({
          musicId: doc.id,
          fullUrl: versionInfo.fullUrl,
          version: versionInfo.version
        });
        clipVersions.push({ version: versionInfo.version, clipUrl });
      }

      const clipUrls = clipVersions.map((item) => item.clipUrl);

      await moveStatus(doc.ref, "Enviar musica", {
        clipUrl: clipUrls[0],
        clipUrls,
        clipVersions,
        clipGeneratedAt: FieldValue.serverTimestamp(),
        errorMsg: FieldValue.delete()
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
    const clipUrls = getClipUrls(song);

    if (!song.leadPhone || !song.lyrics || !clipUrls.length) {
      await moveStatus(doc.ref, "Error envio", {
        errorMsg: "Faltan leadPhone, lyrics o clipUrl/clipUrls."
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
  const stuckStatuses = [
    "Generando letra",
    "Generando prompt",
    "Procesando musica",
    "Guardando audio",
    "Generando clip",
    "Enviando musica"
  ];
  const snap = await db.collection(MUSIC_COLLECTION).where("status", "in", stuckStatuses).limit(20).get();
  const cutoff = Date.now() - thresholdMinutes * 60 * 1000;
  let reset = 0;

  for (const doc of snap.docs) {
    const data = doc.data();
    const startedAt = getStartedAtForStatus(data);

    if (!startedAt || startedAt >= cutoff) continue;

    const previousStatus =
      data.status === "Generando letra"
        ? "Sin letra"
        : data.status === "Generando prompt"
          ? "Sin prompt"
          : data.status === "Procesando musica"
            ? "Sin musica"
            : data.status === "Guardando audio"
              ? "Procesando musica"
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
