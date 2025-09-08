import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";

const sh = promisify(exec);

const app = express();
app.use(express.json({ limit: "20mb" }));

// Cloudinary config from env
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// health
app.get("/healthz", (_, res) => res.json({ ok: true }));

/**
 * POST /compose
 * body: {
 *   ugcUrl, show1Url, show2Url,
 *   firstAt=7, secondAt=14, lengthSec=3, fadeSec=0.5,
 *   width=720, height=1280, fps=30,
 *   folder="ugc-pipeline", publicIdPrefix optional
 * }
 */
app.post("/compose", async (req, res) => {
  try {
    const {
      ugcUrl,
      show1Url,
      show2Url,
      firstAt = 7,
      secondAt = 14,
      lengthSec = 3,
      fadeSec = 0.5,
      width = 720,
      height = 1280,
      fps = 30,
      folder = "ugc-pipeline",
      publicIdPrefix = ""
    } = req.body || {};

    if (!ugcUrl || !show1Url || !show2Url) {
      return res.status(400).json({
        error: "Missing ugcUrl/show1Url/show2Url",
      });
    }

    // 1) probe duration of UGC (directly from URL)
    const { stdout: durStr } = await sh(
      `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${ugcUrl}"`
    );
    const duration = Math.max(0, parseFloat((durStr || "").trim()) || 0);
    if (!duration || !isFinite(duration)) {
      return res.status(400).json({ error: "Could not read UGC duration" });
    }

    // last overlay should sit flush to the end
    const lastStart = Math.max(0, duration - lengthSec);
    const fadeOutStart = +(lengthSec - fadeSec).toFixed(3);

    // 2) build filter_complex
    // full screen overlays, alpha fade in/out, scheduled at t=firstAt, secondAt, lastStart
    const filter = [
      `[0:v]scale=${width}:${height},format=yuv420p[base]`,

      `[1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,` +
      `setpts=PTS+${firstAt}/TB[s1]`,

      `[2:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,` +
      `setpts=PTS+${secondAt}/TB[s2]`,

      // use show1 again as the final closer
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,` +
      `setpts=PTS+${lastStart.toFixed(3)}/TB[s3]`,

      `[base][s1]overlay=eof_action=pass[o1]`,
      `[o1][s2]overlay=eof_action=pass[o2]`,
      `[o2][s3]overlay=eof_action=pass[v]`,
    ].join(";");

    // 3) run ffmpeg (inputs are URLs, output to /tmp)
    const id = randomUUID();
    const outFile = `/tmp/final_${id}.mp4`;

    const ffmpegCmd = `
      ffmpeg -y \
        -i "${ugcUrl}" \
        -i "${show1Url}" \
        -i "${show2Url}" \
        -filter_complex "${filter}" \
        -map "[v]" -map 0:a \
        -c:v libx264 -r ${fps} -pix_fmt yuv420p \
        -c:a aac -b:a 128k \
        "${outFile}"
    `.replace(/\s+/g, " ").trim();

    console.log("FFmpeg CMD:", ffmpegCmd);
    const { stderr } = await sh(ffmpegCmd, { maxBuffer: 1024 * 1024 * 50 });
    console.log("FFmpeg done\n", stderr?.slice(-2000) || "");

    // 4) upload to Cloudinary (video resource)
    const publicId =
      (publicIdPrefix ? `${publicIdPrefix}_` : "") + id.slice(0, 8);
    const up = await cloudinary.uploader.upload(outFile, {
      resource_type: "video",
      folder: `${folder}/${new Date().toISOString().slice(0,10)}`,
      public_id: publicId,
      overwrite: true,
    });

    // 5) cleanup
    try { await fs.unlink(outFile); } catch {}

    // 6) respond with public URL
    return res.json({
      ok: true,
      video_url: up.secure_url,
      public_id: up.public_id,
      duration,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "compose_failed",
      details: String(err?.message || err),
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
