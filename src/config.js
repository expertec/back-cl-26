import dotenv from "dotenv";

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 3001),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:3000",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  sunoApiKey: process.env.SUNO_API_KEY || "",
  sunoBaseUrl: process.env.SUNO_BASE_URL || "https://api.sunoapi.org/api/v1",
  sunoModel: process.env.SUNO_MODEL || "V4_5ALL",
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
  kanwapApiUrl: (process.env.KANWAP_API_URL || "https://kanwap.udelonline.com").replace(/\/$/, ""),
  kanwapApiKey: process.env.KANWAP_API_KEY || "",
  kanwapSessionId: process.env.KANWAP_SESION_ID || "",
  enableCron: process.env.ENABLE_CRON !== "false",
  jobSecret: process.env.JOB_SECRET || ""
};

export function requireRuntimeConfig(keys) {
  const missing = keys.filter((key) => !config[key]);
  if (missing.length) {
    throw new Error(`Faltan variables de entorno: ${missing.join(", ")}`);
  }
}
