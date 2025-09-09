// server.js
import express from "express";
import bodyParser from "body-parser";
import { exec } from "child_process";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";

const app = express();
app.use(bodyParser.json());

// ====== Cloudinary config (from Render ENV vars) ======
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ====== /compose endpoint ======
app.post("/compose", async (req, res) => {
  try {
    const {
      ugcUrl,
      show1Url,
      show2Url,
      interval = 7,
      insertLen = 3,
      fadeSec = 0.5,
      width = 720,
      height = 1280,
      fps = 30,
      folder = "ugc-pipeline",
      publicIdPrefix = "task",
    } = req.body;

    const tmpOut = `/tmp/final_${Date.now()}.mp4`;

    // fixed start times (every N sec + force last at end)
    const total = 24; // <- or detect dynamically with ffprobe if you want
    let times = [];
    for (let t = interval; t < total; t += interval) {
      times.push(+t.toFixed(3));
    }
    const lastStart = +(total - insertLen).toFixed(3);
    if (!times.includes(lastStart)) times.push(lastStart);

    // ==== Build filter ====
    let parts = [];
    parts.push(
      `[0:v]scale=${width}:${height},fps=${fps},format=yuv420p[base]`
    );
    const fadeOutStart = +(insertLen - fadeSec).toFixed(3);

    // prepare showcase clips
    parts.push(
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
        `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc1]`
    );

    const sc2Input = show2Url ? "[2:v]" : "[1:v]";
    parts.push(
      `${sc2Input}scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
        `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc2]`
    );

    // overlay chain
    let cur = "base";
    times.forEach((st, i) => {
      const en = +(st + insertLen - 0.01).toFixed(3);
      const ov = i % 2 === 0 ? "sc1" : "sc2";
      const next = i === times.length - 1 ? "v" : `tmp${i + 1}`;
      parts.push(
        `[${cur}][${ov}]overlay=eof_action=pass:enable='between(t,${st},${en})'[${next}]`
      );
      cur = next;
    });

    const filter = parts.join(";");

    // ==== ffmpeg command ====
    const inputs = [`-i "${ugcUrl}"`, `-i "${show1Url}"`];
    if (show2Url) inputs.push(`-i "${show2Url}"`);

    const cmd = `ffmpeg -y ${inputs.join(" ")} -filter_complex "${filter}" -map "[v]" -map 0:a -c:v libx264 -r ${fps} -pix_fmt yuv420p -c:a aac -b:a 128k "${tmpOut}"`;

    console.log("Running:\n", cmd);

    exec(cmd, async (err) => {
      if (err) {
        console.error("ffmpeg failed:", err);
        return res.status(500).json({ error: "compose_failed", details: err.message });
      }

      try {
        const upload = await cloudinary.uploader.upload(tmpOut, {
          resource_type: "video",
          folder,
          public_id: `${publicIdPrefix}_${Date.now()}`,
          overwrite: true,
        });
        fs.unlinkSync(tmpOut);
        res.json({ video_url: upload.secure_url });
      } catch (e) {
        console.error("Cloudinary upload failed:", e);
        res.status(500).json({ error: "upload_failed", details: e.message });
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server_failed", details: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("FFmpeg API running on port", PORT));
