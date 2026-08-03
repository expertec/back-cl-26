import cron from "node-cron";
import { resetStuckMusic, runMusicPipeline, sendReadySongs } from "./musicPipeline.js";

let running = false;

async function runSafely(name, job) {
  if (running) return;
  running = true;

  try {
    const result = await job();
    console.log(`[cron:${name}]`, result);
  } catch (error) {
    console.error(`[cron:${name}]`, error);
  } finally {
    running = false;
  }
}

export function startCron() {
  cron.schedule("* * * * *", () => runSafely("pipeline", runMusicPipeline));
  cron.schedule("*/2 * * * *", () => runSafely("send-ready", sendReadySongs));
  cron.schedule("*/10 * * * *", () => runSafely("reset-stuck", () => resetStuckMusic(30)));
  console.log("Cron jobs enabled.");
}
