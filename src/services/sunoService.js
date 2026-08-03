import { config } from "../config.js";

export async function submitSunoSong(song) {
  if (!config.sunoApiKey) throw new Error("Falta SUNO_API_KEY.");
  if (!config.publicBackendUrl) throw new Error("Falta PUBLIC_BACKEND_URL.");

  const response = await fetch(`${config.sunoBaseUrl}/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.sunoApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: song.sunoModel || config.sunoModel,
      customMode: true,
      instrumental: false,
      title: song.title,
      style: song.stylePrompt,
      prompt: song.lyrics,
      negativeTags: song.negativeTags || undefined,
      callBackUrl: `${config.publicBackendUrl}/api/suno/callback`
    })
  });

  const payload = await response.json();
  if (!response.ok || payload.code !== 200 || !payload.data?.taskId) {
    throw new Error(payload.msg || `Suno no devolvio taskId. HTTP ${response.status}`);
  }

  return payload.data.taskId;
}

export function extractAudioUrlFromCallback(payload) {
  const item = Array.isArray(payload?.data?.data)
    ? payload.data.data.find((track) => track.audio_url || track.source_audio_url)
    : null;

  return item?.audio_url || item?.source_audio_url || "";
}

export function extractTaskIdFromCallback(payload) {
  return payload?.taskId || payload?.data?.taskId || payload?.data?.task_id || "";
}
