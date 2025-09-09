import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";

const sh = promisify(exec);
const app = express();
app.use(express.json({ limit: "20mb" }));

// --- Cloudinary (ENV on Render) ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Health
app.get("/healthz", (_, res) => res.json({ ok: true }));

// Helpers
async function probeDuration(url) {
  const { stdout } = await sh(
    `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${url}"`
  );
  const d = parseFloat((stdout || "").trim());
  if (!isFinite(d) || d <= 0) throw new Error("bad_duration");
  return d;
}
function uniqSort(arr) {
  const out = [...new Set(arr.map(x => +x.toFixed(3)))];
  out.sort((a,b)=>a-b);
  return out;
}

/**
 * POST /compose
 * body JSON:
 * {
 *   ugcUrl, show1Url, show2Url,        // חובה: ugcUrl, show1Url ; show2Url אופציונלי
 *   interval=7, insertLen=3, fadeSec=0.5,
 *   width=720, height=1280, fps=30,
 *   folder="ugc-pipeline", publicIdPrefix=""
 * }
 */
app.post("/compose", async (req, res) => {
  try {
    const {
      ugcUrl,
      show1Url,
      show2Url,                 // אם אין – נשתמש ב-show1 פעמיים
      interval = 7,
      insertLen = 3,
      fadeSec = 0.5,
      width = 720,
      height = 1280,
      fps = 30,
      folder = "ugc-pipeline",
      publicIdPrefix = ""
    } = req.body || {};

    if (!ugcUrl || !show1Url)
      return res.status(400).json({ error: "Missing ugcUrl/show1Url" });

    // 1) משך אמיתי של ה-UGC
    const duration = await probeDuration(ugcUrl);

    // 2) חישוב נקודות הזרקה: כל interval שניות + “סוגר” צמוד לסוף
    const starts = [];
    let t = interval;
    while (t < duration - insertLen) { starts.push(t); t += interval; }
    const lastStart = Math.max(0, duration - insertLen);
    starts.push(lastStart);
    const startTimes = uniqSort(starts);

    // 3) בניית filter_complex
    const fadeOutStart = +(insertLen - fadeSec).toFixed(3);

    const parts = [];
    // בסיס (וידאו) – שמרנו אודיו מהמיפוי
    parts.push(`[0:v]scale=${width}:${height},fps=${fps},format=yuv420p[base]`);

    // הכנת שני מוצרי overlay עם alpha fades
    parts.push(
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[p1]`
    );
    // אם אין show2 – נשתמש שוב ב-show1
    const sc2Input = show2Url ? "[2:v]" : "[1:v]";
    parts.push(
      `${sc2Input}scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[p2]`
    );

    // שרשור overlays לסירוגין p1/p2 על ה-base
    let cur = "base";
    startTimes.forEach((st, i) => {
      const en = +(st + insertLen - 0.01).toFixed(3);
      const ov = (i % 2 === 0) ? "p1" : "p2";
      const next = (i === startTimes.length - 1) ? "v" : `tmp${i+1}`;
      parts.push(
        `[${cur}][${ov}]overlay=eof_action=pass:enable='between(t,${st},${en})'[${next}]`
      );
      cur = next;
    });

    const filter = parts.join(";");

    // 4) הרצת ffmpeg (קלט: URLs; פלט: /tmp)
    const id = randomUUID().slice(0,8);
    const outFile = `/tmp/final_${id}.mp4`;

    const inputs = show2Url
      ? `-i "${ugcUrl}" -i "${show1Url}" -i "${show2Url}"`
      : `-i "${ugcUrl}" -i "${show1Url}" -i "${show1Url}"`;

    const cmd = `
      ffmpeg -y ${inputs}
        -filter_complex "${filter}"
        -map "[v]" -map 0:a
        -c:v libx264 -r ${fps} -pix_fmt yuv420p
        -c:a aac -b:a 128k
        "${outFile}"
    `.replace(/\s+/g, " ").trim();

    const { stderr } = await sh(cmd, { maxBuffer: 1024 * 1024 * 100 });
    console.log("FFmpeg done. tail:\n", (stderr || "").slice(-1200));

    // 5) העלאה ל-Cloudinary (וידאו)
    const publicId = `${publicIdPrefix ? publicIdPrefix + "_" : ""}${id}`;
    const up = await cloudinary.uploader.upload(outFile, {
      resource_type: "video",
      folder: `${folder}/${new Date().toISOString().slice(0,10)}`,
      public_id: publicId,
      overwrite: true,
    });

    // ניקוי
    try { await fs.unlink(outFile); } catch {}

    // 6) תשובה
    return res.json({
      ok: true,
      video_url: up.secure_url,
      public_id: up.public_id,
      duration,
      starts: startTimes
    });

  } catch (err) {
    console.error("compose_failed:", err);
    return res.status(500).json({ error: "compose_failed", details: String(err?.message || err) });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
