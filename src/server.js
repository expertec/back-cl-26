import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { musicRouter } from "./routes/music.js";
import { sunoRouter } from "./routes/suno.js";
import { jobsRouter } from "./routes/jobs.js";
import { startCron } from "./jobs/cron.js";

const app = express();

app.use(
  cors({
    origin: config.frontendOrigin === "*" ? true : config.frontendOrigin,
    credentials: false
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "cantalab-music-backend" });
});

app.use("/api/music", musicRouter);
app.use("/api/suno", sunoRouter);
app.use("/api/jobs", jobsRouter);

app.listen(config.port, () => {
  console.log(`Cantalab backend listening on ${config.port}`);
  if (config.enableCron) startCron();
});
