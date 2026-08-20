import { db, FieldValue } from "../firebase.js";
import { logEvent } from "./eventLog.js";

const MUSIC_COLLECTION = "musica";

export const MUSIC_STATUSES = [
  "Sin letra",
  "Generando letra",
  "Sin prompt",
  "Generando prompt",
  "Sin musica",
  "Procesando musica",
  "Guardando audio",
  "Audio listo",
  "Generando clip",
  "Enviar musica",
  "Enviando musica",
  "Enviada",
  "Error letra",
  "Error prompt",
  "Error musica",
  "Error clip",
  "Error envio",
  "Error sin fullUrl"
];

// A donde se devuelve cada estado para reintentarlo desde el ultimo punto sano.
const RETRY_TARGET = {
  "Generando letra": "Sin letra",
  "Error letra": "Sin letra",
  "Generando prompt": "Sin prompt",
  "Error prompt": "Sin prompt",
  "Procesando musica": "Sin musica",
  "Error musica": "Sin musica",
  "Guardando audio": "Procesando musica",
  "Generando clip": "Audio listo",
  "Error clip": "Audio listo",
  "Error sin fullUrl": "Procesando musica",
  "Enviando musica": "Enviar musica",
  "Error envio": "Enviar musica",
  Enviada: "Enviar musica",
  // Estados de versiones anteriores del pipeline, que se escribian con acento.
  "Error música": "Sin musica",
  "Enviada completa": "Enviar musica"
};

// Cuanto puede tardar como mucho cada paso antes de considerarse atorado.
const STAGE_TIMEOUT_MINUTES = {
  "Generando letra": 5,
  "Generando prompt": 5,
  "Procesando musica": 20,
  "Guardando audio": 10,
  "Generando clip": 10,
  "Enviando musica": 10,
  "Sin letra": 10,
  "Sin prompt": 10,
  "Sin musica": 10,
  "Audio listo": 10,
  "Enviar musica": 10
};

// Solo los campos que se muestran o se buscan: los documentos guardan tambien
// la respuesta cruda de Suno, que pesa mucho mas que todo lo demas junto.
const SUMMARY_FIELDS = [
  "status", "title", "leadPhone", "phone", "customerName", "recipientName", "source",
  "errorMsg", "audioPersistError", "sunoPollError", "sunoStatus", "taskId", "clipUrls",
  "sendAttemptCount", "leadId", "songOrderId", "lyrics", "createdAt", "updatedAt",
  "fullUrls", "fullVersions", "fullDeliveredAt", "fullDeliveredVersion", "paid", "conversationId"
];

const SEARCH_SCAN_LIMIT = 500;

export async function getMusicOverview({ limit = 60, status, q } = {}) {
  const search = normalizeSearch(q);
  // Buscar exige recorrer mas documentos: Firestore no hace texto completo.
  const scanLimit = search ? SEARCH_SCAN_LIMIT : Math.min(limit, 200);

  let query = db.collection(MUSIC_COLLECTION).select(...SUMMARY_FIELDS).orderBy("updatedAt", "desc");
  if (status) query = query.where("status", "==", status);

  const snap = await query.limit(scanLimit).get();
  let songs = snap.docs.map((doc) => toSongSummary(doc));

  const scanned = songs.length;
  if (search) songs = songs.filter((song) => matchesSearch(song, search)).slice(0, Math.min(limit, 200));

  const counts = {};
  for (const song of songs) {
    counts[song.status] = (counts[song.status] || 0) + 1;
  }

  const stuck = songs.filter((song) => song.stuck).length;
  // La letra completa solo sirve para buscar del lado del servidor; mandarla
  // entera por cada resultado multiplicaria el peso de la respuesta.
  const payload = songs.map(({ lyricsText, ...song }) => song);

  return {
    songs: payload,
    counts,
    stuck,
    ...(search ? { search: q, scanned, found: payload.length } : {})
  };
}

function normalizeSearch(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchesSearch(song, search) {
  // Un numero se busca solo contra telefonos, para que "2025" no traiga letras.
  const onlyDigits = /^[\d\s+()-]+$/.test(search);
  if (onlyDigits) {
    const digits = search.replace(/\D/g, "");
    return digits.length >= 3 && String(song.leadPhone || "").includes(digits);
  }

  return [song.title, song.customerName, song.recipientName, song.lyricsText].some((field) =>
    normalizeSearch(field).includes(search)
  );
}

export async function retryMusic(musicId) {
  const ref = db.collection(MUSIC_COLLECTION).doc(musicId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Pedido no encontrado.");

  const data = snap.data();
  const target = RETRY_TARGET[data.status];
  if (!target) throw new Error(`El estado "${data.status}" no se puede reintentar.`);

  await ref.update({
    status: target,
    errorMsg: FieldValue.delete(),
    sunoPollError: FieldValue.delete(),
    audioPersistError: FieldValue.delete(),
    // Sin esto un pedido que ya agoto los reintentos vuelve a quedarse fuera.
    ...(target === "Enviar musica" ? { sendAttemptCount: 0 } : {}),
    ...(target === "Sin musica" ? { sunoAttemptCount: 0, taskId: FieldValue.delete() } : {}),
    retriedAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  logEvent({
    level: "warn",
    scope: "admin",
    message: `Reintento manual: ${data.status} -> ${target}`,
    musicId,
    phone: data.leadPhone
  });

  const { runMusicPipeline } = await import("../jobs/musicPipeline.js");
  runMusicPipeline().catch((error) => {
    console.error("[admin] pipeline tras reintento fallo", { musicId, error: error.message });
  });

  return { from: data.status, to: target };
}

export async function cancelMusic(musicId) {
  const ref = db.collection(MUSIC_COLLECTION).doc(musicId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Pedido no encontrado.");

  const data = snap.data();
  await ref.update({
    status: "Cancelada",
    canceledAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp()
  });

  logEvent({
    level: "warn",
    scope: "admin",
    message: `Cancelada manualmente desde ${data.status}`,
    musicId,
    phone: data.leadPhone
  });

  return { from: data.status, to: "Cancelada" };
}

function toSongSummary(doc) {
  const data = doc.data();
  const updatedAtMs = toMillis(data.updatedAt);
  const minutesInStage = updatedAtMs ? Math.floor((Date.now() - updatedAtMs) / 60000) : null;
  const timeout = STAGE_TIMEOUT_MINUTES[data.status];

  const lyricsText = data.lyrics || "";

  return {
    id: doc.id,
    status: data.status || "sin estado",
    lyricsText,
    lyricsExcerpt: lyricsText.slice(0, 160),
    title: data.title || "",
    leadPhone: data.leadPhone || data.phone || "",
    customerName: data.customerName || "",
    source: data.source || "",
    errorMsg: data.errorMsg || data.audioPersistError || data.sunoPollError || "",
    sunoStatus: data.sunoStatus || "",
    taskId: data.taskId || "",
    clips: (data.clipUrls || []).length,
    fullVersions: (data.fullVersions || data.fullUrls || []).length,
    fullDelivered: Boolean(data.fullDeliveredAt),
    fullDeliveredVersion: data.fullDeliveredVersion || null,
    sendAttemptCount: Number(data.sendAttemptCount || 0),
    leadId: data.leadId || null,
    songOrderId: data.songOrderId || null,
    createdAt: toMillis(data.createdAt),
    updatedAt: updatedAtMs,
    minutesInStage,
    // Atorado: lleva mas tiempo del razonable en un paso que deberia avanzar solo.
    stuck: Boolean(timeout && minutesInStage !== null && minutesInStage > timeout),
    retriable: Boolean(RETRY_TARGET[data.status])
  };
}

function toMillis(value) {
  return value?.toDate?.()?.getTime?.() || null;
}
