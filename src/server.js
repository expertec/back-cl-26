import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { musicRouter } from "./routes/music.js";
import { sunoRouter } from "./routes/suno.js";
import { jobsRouter } from "./routes/jobs.js";
import { bootstrapWhatsappProvider, whatsappRouter } from "./routes/whatsapp.js";
import { adminRouter } from "./routes/admin.js";
import { startCron } from "./jobs/cron.js";
import { ensureBootstrapUser } from "./services/authService.js";

const app = express();

// Los previews de Vercel cambian de subdominio en cada despliegue, asi que se
// reconocen por patron en vez de tener que listarlos uno por uno.
const VERCEL_PREVIEW = /^https:\/\/cantalab2026(-[a-z0-9-]+)?\.vercel\.app$/;
// Cualquier subdominio propio: crm.cantalab.app, panel.cantalab.app, etc.
const DOMINIO_PROPIO = /^https:\/\/([a-z0-9-]+\.)*cantalab\.app$/;

function isAllowedOrigin(origin) {
  // Sin origen son llamadas server a server (Suno, curl, crons): no son CORS.
  if (!origin) return true;
  if (config.frontendOrigins.includes("*")) return true;
  if (config.frontendOrigins.includes(origin.replace(/\/$/, ""))) return true;
  return VERCEL_PREVIEW.test(origin) || DOMINIO_PROPIO.test(origin);
}

app.use(
  cors({
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    credentials: false
  })
);
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log("[http]", {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - start
    });
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "cantalab-music-backend" });
});

app.use("/api/music", musicRouter);
app.use("/api/suno", sunoRouter);
app.use("/api/jobs", jobsRouter);
app.use("/api/whatsapp", whatsappRouter);
app.use("/api/admin", adminRouter);

app.listen(config.port, () => {
  console.log(`Cantalab backend listening on ${config.port}`);
  console.log("[config]", {
    publicBackendUrl: config.publicBackendUrl,
    frontendOrigins: config.frontendOrigins,
    tmpDir: config.tmpDir,
    sunoBaseUrl: config.sunoBaseUrl,
    hasFirebaseBucket: Boolean(config.firebaseStorageBucket),
    hasOpenaiKey: Boolean(config.openaiApiKey),
    hasSunoKey: Boolean(config.sunoApiKey),
    whatsappProvider: config.whatsappProvider,
    whatsappAuthStore: "firestore"
  });
  ensureBootstrapUser().catch((error) => {
    console.error("[auth] no se pudo crear el usuario inicial", { error: error.message });
  });

  if (config.enableCron) startCron();
  bootstrapWhatsappProvider().catch((error) => {
    console.error("[whatsapp/bootstrap] failed:", error);
  });
});
