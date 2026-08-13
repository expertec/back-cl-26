import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { musicRouter } from "./routes/music.js";
import { sunoRouter } from "./routes/suno.js";
import { jobsRouter } from "./routes/jobs.js";
import { bootstrapWhatsappProvider, whatsappRouter } from "./routes/whatsapp.js";
import { adminRouter } from "./routes/admin.js";
import { startCron } from "./jobs/cron.js";

const app = express();

app.use(
  cors({
    origin: config.frontendOrigin === "*" ? true : config.frontendOrigin,
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
    frontendOrigin: config.frontendOrigin,
    tmpDir: config.tmpDir,
    sunoBaseUrl: config.sunoBaseUrl,
    hasFirebaseBucket: Boolean(config.firebaseStorageBucket),
    hasKanwapSession: Boolean(config.kanwapSessionId)
  });
  if (config.enableCron) startCron();
  bootstrapWhatsappProvider().catch((error) => {
    console.error("[whatsapp/bootstrap] failed:", error);
  });
});
