import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";

const sh = promisify(exec);
const app = express();
app.use(express.json({ limit: "20mb" }));

// ---------- Cloudinary ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------- Health ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Helpers ----------
async function probeDuration(url) {
  const { stdout } = await sh(
    `ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 "${url}"`
  );
  const d = parseFloat((stdout || "").trim());
  if (!isFinite(d) || d <= 0) throw new Error("bad_duration");
  return d;
}

function uniqSorted(arr) {
  const out = [...new Set(arr.map(x => +(+x).toFixed(3)))];
  out.sort((a, b) => a - b);
  return out;
}

// ---------- Main ----------
/**
 * POST /compose
 * body:
 * {
 *   ugcUrl (required),
 *   show1Url (required),
 *   show2Url (optional),
 *   interval=7,
 *   insertLen=3,
 *   fadeSec=0.5,
 *   width=720, height=1280, fps=30,
 *   folder="ugc-pipeline",
 *   publicIdPrefix=""
 * }
 */
app.post("/compose", async (req, res) => {
  try {
    const {
      ugcUrl,
      show1Url,
      show2Url,                // optional; if missing -> reuse show1Url
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

    // 1) actual duration
    const duration = await probeDuration(ugcUrl);

    // 2) start times: every N sec + a final one flush to end
    const starts = [];
    let t = interval;
    while (t < duration - insertLen) {
      starts.push(+t.toFixed(3));
      t += interval;
    }
    const lastStart = Math.max(0, duration - insertLen);
    starts.push(+lastStart.toFixed(3));

    const startTimes = uniqSorted(starts);

    // 3) build filter_complex
    // base video
    const parts = [];
    parts.push(`[0:v]scale=${width}:${height},fps=${fps},format=yuv420p[base]`);

    // prepare sc1out & sc2out (with alpha fades)
    const fadeOutStart = +(insertLen - fadeSec).toFixed(3);

    parts.push(
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,` +
      `fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc1out]`
    );

    const sc2Input = show2Url ? "[2:v]" : "[1:v]";
    parts.push(
      `${sc2Input}scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,` +
      `fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc2out]`
    );

    // how many times each overlay is used (alternate sc1, sc2, sc1, ...)
    const totalOverlays = startTimes.length;
    const countSc1 = Math.ceil(totalOverlays / 2); // indices 0,2,4,...
    const countSc2 = Math.floor(totalOverlays / 2); // indices 1,3,5,...

    // split sc1out/sc2out if needed (to reuse the same prepared clip multiple times)
    // labels: sc1_1..sc1_n ; sc2_1..sc2_n
    if (countSc1 > 1) {
      const labels = Array.from({ length: countSc1 }, (_, i) => `[sc1_${i + 1}]`).join("");
      parts.push(`[sc1out]split=${countSc1}${labels}`);
    }
    if (countSc2 > 1) {
      const labels = Array.from({ length: countSc2 }, (_, i) => `[sc2_${i + 1}]`).join("");
      parts.push(`[sc2out]split=${countSc2}${labels}`);
    }

    // helper to get label by index
    const getSc1Label = (k) => (countSc1 > 1 ? `sc1_${k}` : `sc1out`);
    const getSc2Label = (k) => (countSc2 > 1 ? `sc2_${k}` : `sc2out`);

    // overlay chain: [base] -> [tmp1] -> ... -> [v]
    let cur = "base";
    let used1 = 0;
    let used2 = 0;

    startTimes.forEach((st, i) => {
      const en = +(st + insertLen - 0.01).toFixed(3);
      const next = (i === startTimes.length - 1) ? "v" : `tmp${i + 1}`;

      if (i % 2 === 0) {
        // sc1
        used1 += 1;
        const ov = getSc1Label(used1);
        parts.push(
          `[${cur}][${ov}]overlay=eof_action=pass:enable='between(t,${st},${en})'[${next}]`
        );
      } else {
        // sc2
        used2 += 1;
        const ov = getSc2Label(used2);
        parts.push(
          `[${cur}][${ov}]overlay=eof_action=pass:enable='between(t,${st},${en})'[${next}]`
        );
      }
      cur = next;
    });

    const filter = parts.join(";");

    // 4) run ffmpeg (inputs via URLs; output to /tmp)
    const id = randomUUID().slice(0, 8);
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

    console.log("==== FFmpeg filter_complex ====\n" + filter + "\n===============================");
    console.log("FFmpeg CMD:", cmd);

    const { stderr } = await sh(cmd, { maxBuffer: 1024 * 1024 * 200 });
    console.log("FFmpeg done. tail logs:\n", (stderr || "").slice(-1500));

    // 5) upload to Cloudinary
    const publicId = `${publicIdPrefix ? publicIdPrefix + "_" : ""}${id}`;
    const up = await cloudinary.uploader.upload(outFile, {
      resource_type: "video",
      folder: `${folder}/${new Date().toISOString().slice(0, 10)}`,
      public_id: publicId,
      overwrite: true,
    });

    // 6) cleanup
    try { await fs.unlink(outFile); } catch {}

    // 7) response
    return res.json({
      ok: true,
      video_url: up.secure_url,
      public_id: up.public_id,
      duration,
      starts: startTimes
    });

  } catch (err) {
    console.error("compose_failed:", err);
    return res.status(500).json({
      error: "compose_failed",
      details: String(err?.message || err)
    });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
