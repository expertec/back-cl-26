import dotenv from "dotenv";

dotenv.config();

// Baileys es el proveedor por defecto: la sesion propia del backend.
// KanWap y Vev quedan como alternativas explicitas via WHATSAPP_PROVIDER.
const whatsappProvider = (process.env.WHATSAPP_PROVIDER || "baileys").toLowerCase();

export const config = {
  port: Number(process.env.PORT || 3001),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  openaiTranscribeModel: process.env.OPENAI_TRANSCRIBE_MODEL || "whisper-1",
  sunoApiKey: process.env.SUNO_API_KEY || "",
  sunoBaseUrl: process.env.SUNO_BASE_URL || "https://api.sunoapi.org/api/v1",
  sunoModel: process.env.SUNO_MODEL || "V4_5ALL",
  sunoMaxAttempts: Number(process.env.SUNO_MAX_ATTEMPTS || 2),
  publicBackendUrl: (process.env.PUBLIC_BACKEND_URL || "").replace(/\/$/, ""),
  tmpDir: process.env.TMP_DIR || "/tmp/cantalab",
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "/etc/secrets/serviceAccountKey.json",
  firebaseServiceAccountJson: process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "",
  firebaseServiceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "",
  watermarkUrl:
    process.env.WATERMARK_URL ||
    "https://cantalab.com/wp-content/uploads/2025/05/marca-de-agua-1-minuto.mp3",
  clipDurationSeconds: Number(process.env.CLIP_DURATION_SECONDS || 60),
  deliveryApiUrl: process.env.DELIVERY_API_URL || "",
  deliveryApiToken: process.env.DELIVERY_API_TOKEN || "",
  whatsappProvider,
  baileysSessionId: process.env.BAILEYS_SESSION_ID || process.env.WA_SESSION_ID || "cantalab",
  enableBaileys: process.env.ENABLE_BAILEYS !== "false" && (process.env.ENABLE_BAILEYS === "true" || whatsappProvider === "baileys"),
  vevWhatsappApiUrl: (process.env.VEV_WHATSAPP_API_URL || "https://vev-crm-viy5.onrender.com").replace(/\/$/, ""),
  vevWhatsappToken: process.env.VEV_WHATSAPP_TOKEN || "",
  vevNegocioId: process.env.VEV_NEGOCIO_ID || "",
  kanwapApiUrl: (process.env.KANWAP_API_URL || "https://kanwap.udelonline.com").replace(/\/$/, ""),
  kanwapApiKey: process.env.KANWAP_API_KEY || "",
  kanwapSessionId: process.env.KANWAP_SESION_ID || "",
  // Correcciones de letra permitidas por chat antes de pasar a un asesor.
  maxLyricsRevisions: Number(process.env.MAX_LYRICS_REVISIONS || 1),
  // Cuanto se espera a que el contacto termine de escribir antes de responder.
  inboundDebounceMs: Number(process.env.INBOUND_DEBOUNCE_MS || 8000),
  inboundBufferMaxWaitMs: Number(process.env.INBOUND_BUFFER_MAX_WAIT_MS || 45000),
  inboundBufferMaxMessages: Number(process.env.INBOUND_BUFFER_MAX_MESSAGES || 8),
  enableCron: process.env.ENABLE_CRON !== "false",
  jobSecret: process.env.JOB_SECRET || ""
};

export function requireRuntimeConfig(keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}
