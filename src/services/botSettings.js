import { db, FieldValue } from "../firebase.js";

const COLLECTION = "config";
const DOC_ID = "bot";
const CACHE_MS = 30000;
const MAX_PASOS = 5;

/**
 * Secuencia de recordatorios para quien ya escucho su muestra y no ha comprado.
 * Los tiempos se cuentan desde que se entregaron las muestras, no desde el
 * recordatorio anterior, para que reordenar los pasos no descoloque la serie.
 */
export const DEFAULT_FOLLOWUPS = [
  {
    enabled: true,
    delayMinutes: 10,
    message: [
      "¿Que tal quedo tu cancion, {{nombre}}?",
      "",
      "Lo que escuchaste es una muestra de un minuto con marca de agua. La version completa te llega sin marca, en alta calidad y lista para compartir o regalar.",
      "",
      "¿Te la preparo?"
    ].join("\n")
  },
  {
    enabled: true,
    delayMinutes: 1440,
    message: [
      "Hola {{nombre}}, te dejo por aqui tu cancion por si quieres escucharla otra vez.",
      "",
      "¿Te preparo la version completa, sin marca de agua?"
    ].join("\n")
  },
  {
    enabled: true,
    delayMinutes: 4320,
    message: [
      "{{nombre}}, tu cancion sigue guardada aqui.",
      "",
      "Si quieres la version completa dime y te paso los datos, es rapido."
    ].join("\n")
  },
  {
    enabled: false,
    delayMinutes: 10080,
    message: [
      "Hola {{nombre}}, ultima por aqui para no molestarte mas.",
      "",
      "Si en algun momento quieres tu cancion completa, aqui sigo."
    ].join("\n")
  },
  { enabled: false, delayMinutes: 20160, message: "" }
];

export const DEFAULT_SETTINGS = {
  followUps: DEFAULT_FOLLOWUPS,
  // Cuanto se espera antes de que el bot retome a alguien que quedo con una
  // persona: no se le escribe encima a un asesor que esta negociando, pero
  // tampoco se abandona a quien nadie atendio.
  humanTakeoverGraceHours: 6,
  priceMessageEnabled: true,
  priceMessage: [
    "La version completa de tu cancion cuesta $___.",
    "",
    "Te llega sin marca de agua, en alta calidad y lista para compartir o regalar.",
    "",
    "Para apartarla:",
    "Banco: ___",
    "CLABE: ___",
    "A nombre de: ___",
    "",
    "Cuando hagas la transferencia mandame el comprobante por aqui y te la envio enseguida."
  ].join("\n")
};

let cache = null;
let cachedAt = 0;

export async function getBotSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  try {
    const snap = await db.collection(COLLECTION).doc(DOC_ID).get();
    cache = normalize(snap.exists ? snap.data() : {});
  } catch (error) {
    console.error("[settings] no se pudieron leer, se usan los valores por defecto", { error: error.message });
    cache = { ...DEFAULT_SETTINGS };
  }

  cachedAt = Date.now();
  return cache;
}

export async function updateBotSettings(patch = {}) {
  const clean = {};

  if (typeof patch.priceMessageEnabled === "boolean") clean.priceMessageEnabled = patch.priceMessageEnabled;
  if (typeof patch.priceMessage === "string") clean.priceMessage = patch.priceMessage.trim().slice(0, 2000);

  const gracia = Number(patch.humanTakeoverGraceHours);
  if (Number.isFinite(gracia)) clean.humanTakeoverGraceHours = Math.min(Math.max(Math.round(gracia), 0), 720);

  if (Array.isArray(patch.followUps)) {
    clean.followUps = patch.followUps.slice(0, MAX_PASOS).map((paso) => ({
      enabled: Boolean(paso?.enabled),
      delayMinutes: Math.min(Math.max(Math.round(Number(paso?.delayMinutes) || 10), 1), 43200),
      message: String(paso?.message || "").trim().slice(0, 2000)
    }));
  }

  if (!Object.keys(clean).length) throw new Error("No hay nada que guardar.");

  await db
    .collection(COLLECTION)
    .doc(DOC_ID)
    .set({ ...clean, updatedAt: FieldValue.serverTimestamp() }, { merge: true });

  cache = null;
  return getBotSettings({ fresh: true });
}

/**
 * Convierte la configuracion vieja de dos mensajes sueltos a la secuencia, para
 * no perder lo que ya estuviera escrito al desplegar.
 */
function normalize(data = {}) {
  if (Array.isArray(data.followUps) && data.followUps.length) {
    return { ...DEFAULT_SETTINGS, ...data, followUps: data.followUps.slice(0, MAX_PASOS) };
  }

  const migrados = [...DEFAULT_FOLLOWUPS];

  if (typeof data.followUpMessage === "string" && data.followUpMessage.trim()) {
    migrados[0] = {
      enabled: data.followUpEnabled !== false,
      delayMinutes: Number(data.followUpDelayMinutes) || 10,
      message: data.followUpMessage
    };
  }

  if (typeof data.secondFollowUpMessage === "string" && data.secondFollowUpMessage.trim()) {
    migrados[1] = {
      enabled: Boolean(data.secondFollowUpEnabled),
      delayMinutes: Number(data.secondFollowUpDelayMinutes) || 1440,
      message: data.secondFollowUpMessage
    };
  }

  return { ...DEFAULT_SETTINGS, ...data, followUps: migrados };
}

/**
 * Las variables se reemplazan siempre, aunque el dato falte, para que nunca
 * llegue un "{{nombre}}" literal al cliente.
 */
export function renderTemplate(template, values = {}) {
  return String(template || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key) => {
    const value = values[key];
    return value === undefined || value === null || value === "" ? "" : String(value);
  });
}
