import { config } from "../config.js";

export async function submitSunoSong(song) {
  if (!config.sunoApiKey) throw new Error("Falta SUNO_API_KEY.");
  if (!config.publicBackendUrl) throw new Error("Falta PUBLIC_BACKEND_URL.");

  const payload = {
    model: song.sunoModel || config.sunoModel,
    customMode: true,
    instrumental: false,
    title: song.title,
    style: song.stylePrompt,
    prompt: song.lyrics,
    negativeTags: song.negativeTags || undefined,
    callBackUrl: `${config.publicBackendUrl}/api/suno/callback`
  };

  console.log("[suno] submit", {
    musicId: song.id,
    model: payload.model,
    title: payload.title,
    callback: payload.callBackUrl,
    styleChars: payload.style?.length || 0,
    lyricsChars: payload.prompt?.length || 0
  });

  const response = await fetch(`${config.sunoBaseUrl}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sunoApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const result = await response.json();
  if (!response.ok || result.code !== 200 || !result.data?.taskId) {
    throw new Error(result.msg || `Suno no devolvio taskId. HTTP ${response.status}`);
  }

  console.log("[suno] task created", { musicId: song.id, taskId: result.data.taskId });
  return result.data.taskId;
}

export async function getSunoGenerationDetails(taskId) {
  if (!config.sunoApiKey) throw new Error("Falta SUNO_API_KEY.");

  const response = await fetch(
    `${config.sunoBaseUrl}/generate/record-info?taskId=${encodeURIComponent(taskId)}`,
    {
      headers: {
        Authorization: `Bearer ${config.sunoApiKey}`
      }
    }
  );

  const payload = await response.json();
  if (!response.ok || payload.code !== 200) {
    throw new Error(payload.msg || `No se pudo consultar Suno. HTTP ${response.status}`);
  }

  return payload.data;
}

export function extractAudioUrlFromCallback(payload) {
  const item = Array.isArray(payload?.data?.data)
    ? payload.data.data.find((track) => track.audio_url || track.source_audio_url)
    : null;

  return item?.audio_url || item?.source_audio_url || "";
}

export function extractAudioUrlFromRecordInfo(data) {
  const candidates = [
    ...(Array.isArray(data?.response?.data) ? data.response.data : []),
    ...(Array.isArray(data?.response?.sunoData) ? data.response.sunoData : [])
  ];

  const item = candidates.find(
    (track) => track.audio_url || track.source_audio_url || track.audioUrl || track.sourceAudioUrl
  );

  return item?.audio_url || item?.source_audio_url || item?.audioUrl || item?.sourceAudioUrl || "";
}

export function extractTaskIdFromCallback(payload) {
  return payload?.taskId || payload?.data?.taskId || payload?.data?.task_id || "";
}
