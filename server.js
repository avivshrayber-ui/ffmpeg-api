import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";

const sh = promisify(exec);
const app = express();
app.use(express.json({ limit: "20mb" }));

// --- Cloudinary config (מ־Environment Variables ב-Render) ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- Health & env checks ---
app.get("/healthz", (_, res) => res.json({ ok: true }));
app.get("/env", (_, res) =>
  res.json({
    cloud_name: !!process.env.CLOUDINARY_CLOUD_NAME,
    api_key: !!process.env.CLOUDINARY_API_KEY,
    api_secret: !!process.env.CLOUDINARY_API_SECRET,
  })
);

/**
 * POST /compose
 * body JSON:
 * {
 *   ugcUrl, show1Url, show2Url,      // חובה: ugcUrl, show1Url; show2Url אופציונלי
 *   firstAt=7, secondAt=14,          // שניות
 *   lengthSec=3, fadeSec=0.5,        // משך כל overlay + זמן fade
 *   width=720, height=1280, fps=30,
 *   folder="ugc-pipeline", publicIdPrefix=""   // לאחסון בענן
 * }
 */
app.post("/compose", async (req, res) => {
  try {
    const {
      ugcUrl,
      show1Url,
      show2Url,                 // אם לא קיים – נשתמש ב-show1 פעמיים
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

    if (!ugcUrl || !show1Url) {
      return res.status(400).json({ error: "Missing ugcUrl/show1Url" });
    }

    // 1) משך ה-UGC (ישירות מה-URL)
    const { stdout: durStr } = await sh(
      `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${ugcUrl}"`
    );
    const duration = Math.max(0, parseFloat((durStr || "").trim()) || 0);
    if (!duration || !isFinite(duration)) {
      return res.status(400).json({ error: "Could not read UGC duration" });
    }

    // overlay נסגר יפה על סוף הוידאו
    const lastStart = Math.max(0, duration - lengthSec);
    const fadeOutStart = +(lengthSec - fadeSec).toFixed(3);

    // 2) בניית filter_complex
    // בסיס: ה-UGC בסקייל מלא; שלוש שכבות: s1 @firstAt, s2 @secondAt (או s1 אם אין show2), s3 @end ( תמיד show1 ).
    const filterParts = [
      `[0:v]scale=${width}:${height},format=yuv420p[base]`,

      `[1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,` +
        `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,` +
        `setpts=PTS+${firstAt}/TB[s1]`,

      `${show2Url ? `[2:v]` : `[1:v]`}scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,` +
        `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,` +
        `setpts=PTS+${secondAt}/TB[s2]`,

      `[1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,` +
        `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,` +
        `setpts=PTS+${lastStart.toFixed(3)}/TB[s3]`,

      `[base][s1]overlay=eof_action=pass[o1]`,
      `[o1][s2]overlay=eof_action=pass[o2]`,
      `[o2][s3]overlay=eof_action=pass[v]`,
    ];
    const filter = filterParts.join(";");

    // 3) הרצת ffmpeg (קלטים = URLs; פלט לקובץ זמני ב-/tmp)
    const id = randomUUID().slice(0, 8);
    const outFile = `/tmp/final_${id}.mp4`;

    const inputs = show2Url
      ? `-i "${ugcUrl}" -i "${show1Url}" -i "${show2Url}"`
      : `-i "${ugcUrl}" -i "${show1Url}" -i "${show1Url}"`;

    const ffmpegCmd = `
      ffmpeg -y ${inputs}
        -filter_complex "${filter}"
        -map "[v]" -map 0:a
        -c:v libx264 -r ${fps} -pix_fmt yuv420p
        -c:a aac -b:a 128k
        "${outFile}"
    `.replace(/\s+/g, " ").trim();

    console.log("FFmpeg CMD:", ffmpegCmd);
    const { stderr } = await sh(ffmpegCmd, { maxBuffer: 1024 * 1024 * 80 });
    console.log("FFmpeg done. tail logs:\n", (stderr || "").slice(-1500));

    // 4) העלאה ל-Cloudinary כ-VIDEO
    const publicId = `${publicIdPrefix ? publicIdPrefix + "_" : ""}${id}`;
    const up = await cloudinary.uploader.upload(outFile, {
      resource_type: "video",
      folder: `${folder}/${new Date().toISOString().slice(0, 10)}`,
      public_id: publicId,
      overwrite: true,
    });

    // 5) ניקוי קובץ זמני
    try { await fs.unlink(outFile); } catch {}

    // 6) תשובה
    return res.json({
      ok: true,
      video_url: up.secure_url,
      public_id: up.public_id,
      duration
    });
  } catch (err) {
    console.error("compose_failed:", err);
    return res.status(500).json({ error: "compose_failed", details: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
