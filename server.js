import express from "express";
import fetch from "node-fetch";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import tmp from "tmp";
import ffmpegPath from "ffmpeg-static";
import ffmpeg from "fluent-ffmpeg";
ffmpeg.setFfmpegPath(ffmpegPath);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" }));

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed: ${url} -> ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await fs.writeFile(dest, buf);
}

function runFFmpeg(cmd) {
  return new Promise((resolve, reject) => {
    cmd.on("start", c => console.log("FFmpeg:", c))
       .on("error", reject)
       .on("end", resolve)
       .run();
  });
}

app.post("/compose", async (req, res) => {
  try {
    const {
      ugcUrl, show1Url, show2Url,
      width = 720, height = 1280,
      firstAt = 7, secondAt = 14,
      lengthSec = 3, fadeSec = 0.5, fps = 30
    } = req.body;

    if (!ugcUrl || !show1Url || !show2Url) {
      return res.status(400).json({ error: "Missing ugcUrl/show1Url/show2Url" });
    }

    const dir = tmp.dirSync({ unsafeCleanup: true }).name;
    const ugc = path.join(dir, "ugc.mp4");
    const sc1 = path.join(dir, "sc1.mp4");
    const sc2 = path.join(dir, "sc2.mp4");
    const out = path.join(dir, "final.mp4");

    await Promise.all([download(ugcUrl, ugc), download(show1Url, sc1), download(show2Url, sc2)]);

    const duration = await new Promise((resolve, reject) => {
      ffmpeg(ugc).ffprobe((err, data) => {
        if (err) return reject(err);
        resolve(parseFloat(data.format.duration || "0"));
      });
    });

    const lastStart = Math.max(0, duration - lengthSec);
    const fadeOutStart = +(lengthSec - fadeSec).toFixed(3);

    const filter = [
      `[0:v]scale=${width}:${height},format=yuv420p[base]`,
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,setpts=PTS+${firstAt}/TB[s1]`,
      `[2:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,setpts=PTS+${secondAt}/TB[s2]`,
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1,setpts=PTS+${lastStart.toFixed(3)}/TB[s3]`,
      `[base][s1]overlay=eof_action=pass[o1]`,
      `[o1][s2]overlay=eof_action=pass[o2]`,
      `[o2][s3]overlay=eof_action=pass[v]`
    ].join(";");

    const cmd = ffmpeg()
      .input(ugc)
      .input(sc1)
      .input(sc2)
      .complexFilter(filter)
      .outputOptions([
        "-map [v]",
        "-map 0:a",
        `-r ${fps}`,
        "-c:v libx264",
        "-pix_fmt yuv420p",
        "-c:a aac",
        "-b:a 128k"
      ])
      .output(out);

    await runFFmpeg(cmd);

    // שלח את הווידאו חזרה ישירות (לבדיקות מהירות). לפרודקשן עדיף להעלות ל-S3/Cloudinary ולהחזיר URL.
    res.setHeader("Content-Type", "video/mp4");
    res.send(await fs.readFile(out));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/healthz", (_, res) => res.json({ ok: true }));
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`FFmpeg compositor on :${port}`));
