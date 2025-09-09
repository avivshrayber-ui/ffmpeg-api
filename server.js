// server.js
import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";

const sh = promisify(exec);
const app = express();

// גוף בקשות JSON
app.use(express.json({ limit: "20mb" }));

// ---------- Cloudinary (ENV ב-Render) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------- Health ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Helpers ----------
async function probeDuration(url) {
  // מחזיר משך וידאו אמיתי בשניות כ-float
  const { stdout } = await sh(
    `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${url}"`
  );
  const d = parseFloat((stdout || "").trim());
  if (!isFinite(d) || d <= 0) throw new Error("bad_duration");
  return d;
}

function uniqSorted(arr) {
  const set = new Set(arr.map(x => +(+x).toFixed(3)));
  return Array.from(set).sort((a, b) => a - b);
}

// ---------- Main ----------
/**
 * POST /compose
 * body:
 * {
 *   ugcUrl (required),
 *   show1Url (required),
 *   show2Url (optional, fallback to show1),
 *   interval=7,
 *   insertLen=3,
 *   fadeSec=0.5,
 *   width=720, height=1280, fps=30,
 *   folder="ugc-pipeline",
 *   publicIdPrefix=""
 * }
 */
app.post("/compose", async (req, res) => {
  const startedAt = Date.now();
  try {
    const {
      ugcUrl,
      show1Url,
      show2Url,                // אם לא קיים – נשתמש שוב ב-show1Url
      interval = 7,
      insertLen = 3,
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

    // 1) משך אמיתי של ה-UGC
    const duration = await probeDuration(ugcUrl);

    // 2) נקודות הזרקה: כל interval שניות + עוד אחת צמוד לסוף
    const points = [];
    for (let t = interval; t < duration - insertLen; t += interval) {
      points.push(+t.toFixed(3));
    }
    points.push(+(Math.max(0, duration - insertLen)).toFixed(3));
    const starts = uniqSorted(points);

    // 3) בונים filter_complex
    const fadeOutStart = +(insertLen - fadeSec).toFixed(3);
    const parts = [];

    // בסיס (וידאו) – האודיו ימופה מהקלט 0
    parts.push(`[0:v]scale=${width}:${height},fps=${fps},format=yuv420p[base]`);

    // הכנת שני ה-showcases עם alpha fade
    parts.push(
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc1out]`
    );

    const sc2Input = show2Url ? "[2:v]" : "[1:v]";
    parts.push(
      `${sc2Input}scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc2out]`
    );

    // כמה פעמים כל showcase נדרש (לשימוש חוזר – split)
    const totalOverlays = starts.length;
    const needSc1 = Math.ceil(totalOverlays / 2);  // אינדקסים 0,2,4...
    const needSc2 = Math.floor(totalOverlays / 2); // אינדקסים 1,3,5...

    if (needSc1 > 1) {
      const labels = Array.from({ length: needSc1 }, (_, i) => `[sc1_${i+1}]`).join("");
      parts.push(`[sc1out]split=${needSc1}${labels}`);
    }
    if (needSc2 > 1) {
      const labels = Array.from({ length: needSc2 }, (_, i) => `[sc2_${i+1}]`).join("");
      parts.push(`[sc2out]split=${needSc2}${labels}`);
    }

    const getSc1 = (k) => (needSc1 > 1 ? `sc1_${k}` : `sc1out`);
    const getSc2 = (k) => (needSc2 > 1 ? `sc2_${k}` : `sc2out`);

    // overlay chain: base -> tmp1 -> tmp2 -> ... -> v
    let cur = "base";
    let used1 = 0;
    let used2 = 0;
    starts.forEach((st, i) => {
      const en = +(st + insertLen - 0.01).toFixed(3);
      const next = (i === starts.length - 1) ? "v" : `tmp${i + 1}`;
      if (i % 2 === 0) {
        used1 += 1;
        parts.push(
          `[${cur}][${getSc1(used1)}]overlay=eof_action=pass:enable='between(t,${st},${en})'[${next}]`
        );
      } else {
        used2 += 1;
        parts.push(
          `[${cur}][${getSc2(used2)}]overlay=eof_action=pass:enable='between(t,${st},${en})'[${next}]`
        );
      }
      cur = next;
    });

    const filter = parts.join(";");

    // 4) הרצת ffmpeg (URLs כקלט; פלט ל-/tmp)
    const id = randomUUID().slice(0, 8);
    const outFile = `/tmp/final_${id}.mp4`;

    // אם אין show2Url, נטען את show1 פעמיים כדי לשמור על מבנה קבוע של פילטרים
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

    console.log("==== FFmpeg filter_complex ====\n" + filter + "\n===============================");
    console.log("FFmpeg CMD:", cmd);

    // הגדלת buffer ללוגים
    let ffmpegStdout = "";
    let ffmpegStderr = "";
    try {
      const { stdout, stderr } = await sh(cmd, { maxBuffer: 1024 * 1024 * 200 });
      ffmpegStdout = stdout || "";
      ffmpegStderr = stderr || "";
    } catch (e) {
      // במקרה של כשל – נחזיר את הלוגים במלואם כדי שתראה ב-N8N
      return res.status(500).json({
        error: "ffmpeg_failed",
        details: (e && e.message) || "unknown",
        filter_complex: filter,
        cmd,
        stderr: e?.stderr ? String(e.stderr).slice(-4000) : "",
        stdout: e?.stdout ? String(e.stdout).slice(-1000) : ""
      });
    }

    // 5) העלאה ל-Cloudinary
    const publicId = `${publicIdPrefix ? publicIdPrefix + "_" : ""}${id}`;
    let up;
    try {
      up = await cloudinary.uploader.upload(outFile, {
        resource_type: "video",
        folder: `${folder}/${new Date().toISOString().slice(0, 10)}`,
        public_id: publicId,
        overwrite: true,
      });
    } catch (e) {
      // החזר שגיאת העלאה + tail לוגים
      return res.status(500).json({
        error: "cloudinary_upload_failed",
        details: e?.message || String(e),
        duration,
        filter_complex: filter,
        cmd,
        ffmpeg_stderr_tail: String(ffmpegStderr).slice(-1500)
      });
    } finally {
      try { await fs.unlink(outFile); } catch {}
    }

    // 6) תשובה
    return res.json({
      ok: true,
      video_url: up.secure_url,
      public_id: up.public_id,
      duration,
      starts,
      elapsed_ms: Date.now() - startedAt
    });

  } catch (err) {
    console.error("compose_failed:", err);
    return res.status(500).json({
      error: "compose_failed",
      details: String(err?.message || err)
    });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000; // חשוב ל-Render
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
