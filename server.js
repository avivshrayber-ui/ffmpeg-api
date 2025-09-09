import express from "express";
import { exec } from "child_process";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";

const app = express();
app.use(express.json());

// Health check
app.get("/healthz", (req, res) => {
  res.send("ok");
});

// Compose route
app.post("/compose", async (req, res) => {
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
    publicIdPrefix = "task",
  } = req.body;

  try {
    // קובץ פלט זמני
    const outFile = "out.mp4";

    // פקודת FFmpeg בסיסית (תתאים למה שעשינו ידנית)
    const cmd = `
      ffmpeg -y \
      -i "${ugcUrl}" \
      -i "${show1Url}" \
      -i "${show2Url}" \
      -filter_complex "
        [0:v]scale=${width}:${height},fps=${fps},format=yuv420p[base];
        [1:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,
             fade=t=in:st=0:d=${fadeSec}:alpha=1,
             fade=t=out:st=${lengthSec - fadeSec}:d=${fadeSec}:alpha=1[p1];
        [2:v]scale=${width}:${height},format=rgba,trim=0:${lengthSec},setpts=PTS-STARTPTS,
             fade=t=in:st=0:d=${fadeSec}:alpha=1,
             fade=t=out:st=${lengthSec - fadeSec}:d=${fadeSec}:alpha=1[p2];
        [base][p1]overlay=eof_action=pass:enable='between(t,${firstAt},${firstAt + lengthSec - 0.01})'[tmp1];
        [tmp1][p2]overlay=eof_action=pass:enable='between(t,${secondAt},${secondAt + lengthSec - 0.01})'[v]
      " \
      -map "[v]" -map 0:a -c:v libx264 -r ${fps} -pix_fmt yuv420p -c:a aac -b:a 128k \
      ${outFile}
    `;

    console.log("Running ffmpeg:", cmd);

    exec(cmd, async (error, stdout, stderr) => {
      if (error) {
        console.error("❌ ffmpeg error:", error);
        return res.status(500).json({ error: stderr });
      }

      console.log("✅ ffmpeg finished, uploading to Cloudinary...");

      // Cloudinary config
      cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
      });

      try {
        const uploadResult = await cloudinary.uploader.upload(outFile, {
          resource_type: "video",
          folder,
          public_id: `${publicIdPrefix}_final`,
          overwrite: true,
        });

        // מחיקה מקומית
        fs.unlinkSync(outFile);

        res.json({
          url: uploadResult.secure_url,
          details: uploadResult,
        });
      } catch (uploadErr) {
        console.error("❌ Upload error:", uploadErr);
        res.status(500).json({ error: uploadErr.message });
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
