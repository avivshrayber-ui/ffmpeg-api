import express from "express";
import { exec } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";

const app = express();
app.use(express.json());

// Health check
app.get("/healthz", (req, res) => res.json({ ok: true }));

// Compose videos
app.post("/compose", async (req, res) => {
  const { ugcUrl, show1Url, show2Url } = req.body;

  if (!ugcUrl || !show1Url) {
    return res.status(400).json({
      error: "You must provide ugcUrl and show1Url (show2Url optional).",
    });
  }

  const id = randomUUID();
  const outFile = `/tmp/out_${id}.mp4`; // Render allows /tmp storage

  // === FFmpeg filter ===
  // - UGC full video + alternating overlays (show1, show2, show1, …) every 7s, 2s long each
  const filter = `
[0:v]scale=720:1280,fps=30,format=yuv420p[base];
[1:v]scale=720:1280,format=rgba,trim=0:2,setpts=PTS-STARTPTS,
fade=t=in:st=0:d=0.5:alpha=1,
fade=t=out:st=1.5:d=0.5:alpha=1[p1];
${show2Url ? "[2:v]scale=720:1280,format=rgba,trim=0:2,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.5:alpha=1,fade=t=out:st=1.5:d=0.5:alpha=1[p2];" : ""}
[base][p1]overlay=eof_action=pass:enable='between(t,7,8.99)'[tmp1]
${show2Url ? ";[tmp1][p2]overlay=eof_action=pass:enable='between(t,14,15.99)'[v]" : ""}
  `.replace(/\s+/g, " "); // compact

  // === FFmpeg command ===
  const inputs = [
    `-i "${ugcUrl}"`,
    `-i "${show1Url}"`,
    show2Url ? `-i "${show2Url}"` : "",
  ].join(" ");

  const cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[v]" -map 0:a -c:v libx264 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k ${outFile}`;

  console.log("Running:", cmd);

  exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
    if (err) {
      console.error("FFmpeg error:", stderr);
      return res.status(500).json({ error: "FFmpeg failed", details: stderr });
    }

    // For test: just return a static file path
    // On Render, you could later serve it via S3 / Cloudinary upload
    res.json({
      message: "Video composed successfully",
      file: outFile,
    });
  });
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
