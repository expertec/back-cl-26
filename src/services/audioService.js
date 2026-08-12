import fs from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

async function createJobTmpDir(prefix) {
  const baseTmpDir = config.tmpDir || os.tmpdir();
  fs.mkdirSync(baseTmpDir, { recursive: true });
  return mkdtemp(path.join(baseTmpDir, `${prefix}-`));
}

function cleanupFiles(filePaths) {
  filePaths.forEach((filePath) => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // ignore cleanup errors
    }
  });
}

function logAudioUrlContext(label, audioUrl) {
  try {
    const parsed = new URL(audioUrl);
    console.log(label, { host: parsed.host, pathname: parsed.pathname });
  } catch {
    console.log(label, { host: null, pathname: null });
  }
}

export async function createWatermarkedClip({ musicId, fullUrl, version = 1 }) {
  configureFfmpeg();

  const tmpDir = await createJobTmpDir(`clip-${musicId}-v${version}`);

  const tmpFull = path.join(tmpDir, `${musicId}-v${version}-full.mp3`);
  const tmpClip = path.join(tmpDir, `${musicId}-v${version}-clip.m4a`);
  const tmpWatermark = path.join(tmpDir, `${musicId}-v${version}-watermark.mp3`);
  const tmpFinal = path.join(tmpDir, `${musicId}-v${version}-watermarked.m4a`);

  try {
    console.log("[audio] creating clip", { musicId, version, tmpDir });
    logAudioUrlContext("[audio] full url for clip", fullUrl);
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

    return await uploadAudioAndGetUrl(tmpFinal, `musica/clip/${musicId}-v${version}-clip.m4a`, "audio/mp4");
  } finally {
    cleanupFiles([tmpFull, tmpClip, tmpWatermark, tmpFinal]);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function persistFullAudio({ musicId, taskId, audioUrl, version = 1 }) {
  const tmpDir = await createJobTmpDir(`full-${musicId}-v${version}`);

  const tmpFull = path.join(tmpDir, `${taskId}-v${version}-${randomUUID()}-full.mp3`);

  try {
    console.log("[audio] persisting full audio", { musicId, taskId, version, tmpFull });
    logAudioUrlContext("[audio] source full audio", audioUrl);
    await downloadToFile(audioUrl, tmpFull);
    const stats = fs.statSync(tmpFull);
    console.log("[audio] full audio downloaded", { musicId, taskId, bytes: stats.size });
    return await uploadAudioAndGetUrl(tmpFull, `musica/full/${musicId}-${taskId}-v${version}.mp3`, "audio/mpeg");
  } finally {
    cleanupFiles([tmpFull, `${tmpFull}.part`]);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}
