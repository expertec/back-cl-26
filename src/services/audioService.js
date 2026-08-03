import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
import { config } from "../config.js";
import { downloadToFile } from "../utils/download.js";
import { uploadAudioAndGetUrl } from "../utils/storage.js";

let ffmpegConfigured = false;

function configureFfmpeg() {
  if (ffmpegConfigured) return;

  const candidates = [
    process.env.FFMPEG_PATH,
    ffmpegInstaller?.path,
    ffmpegStatic
  ].filter(Boolean);

  try {
    const which = spawnSync("which", ["ffmpeg"], { encoding: "utf8" });
    if (which.status === 0 && which.stdout.trim()) candidates.push(which.stdout.trim());
  } catch {
    // ignore
  }

  const resolved = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  if (!resolved) throw new Error("No se encontro ffmpeg. Configura FFMPEG_PATH o instala ffmpeg.");

  ffmpeg.setFfmpegPath(resolved);
  ffmpegConfigured = true;
}

function runFfmpeg(command) {
  return new Promise((resolve, reject) => {
    command.on("end", resolve).on("error", reject).run();
  });
}

export async function createWatermarkedClip({ musicId, fullUrl }) {
  configureFfmpeg();

  const tmpFull = path.join(os.tmpdir(), `${musicId}-full.mp3`);
  const tmpClip = path.join(os.tmpdir(), `${musicId}-clip.m4a`);
  const tmpWatermark = path.join(os.tmpdir(), `${musicId}-watermark.mp3`);
  const tmpFinal = path.join(os.tmpdir(), `${musicId}-watermarked.m4a`);

  try {
    await downloadToFile(fullUrl, tmpFull);
    await runFfmpeg(
      ffmpeg(tmpFull)
        .setStartTime(0)
        .setDuration(config.clipDurationSeconds)
        .audioCodec("aac")
        .format("ipod")
        .output(tmpClip)
    );

    await downloadToFile(config.watermarkUrl, tmpWatermark);
    await runFfmpeg(
      ffmpeg()
        .input(tmpClip)
        .input(tmpWatermark)
        .complexFilter(["[1]adelay=1000|1000,volume=0.3[wm];[0][wm]amix=inputs=2:duration=first"])
        .audioCodec("aac")
        .format("ipod")
        .output(tmpFinal)
    );

    return uploadAudioAndGetUrl(tmpFinal, `musica/clip/${musicId}-clip.m4a`, "audio/mp4");
  } finally {
    [tmpFull, tmpClip, tmpWatermark, tmpFinal].forEach((filePath) => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {
        // ignore cleanup errors
      }
    });
  }
}

export async function persistFullAudio({ musicId, taskId, audioUrl }) {
  const tmpFull = path.join(os.tmpdir(), `${taskId}-full.mp3`);

  try {
    await downloadToFile(audioUrl, tmpFull);
    return uploadAudioAndGetUrl(tmpFull, `musica/full/${musicId}-${taskId}.mp3`, "audio/mpeg");
  } finally {
    try {
      if (fs.existsSync(tmpFull)) fs.unlinkSync(tmpFull);
    } catch {
      // ignore cleanup errors
    }
  }
}
