// server.js
import express from "express";
import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import { v2 as cloudinary } from "cloudinary";
// For local testing with .env file (not strictly needed on Render if ENV vars are set directly)
import 'dotenv/config';

// In Node.js 18+ (which your Dockerfile with node:20-slim uses), 'fetch' is globally available.
// If you were using an older Node.js version, you might need: import fetch from 'node-fetch';
// and add "node-fetch": "^3.3.2" to your package.json dependencies.

const sh = promisify(exec);
const app = express();

// A simple in-memory store for job statuses.
// IMPORTANT: In a production environment, this should be replaced with a a persistent store
// (e.g., Redis, PostgreSQL) to survive server restarts or multiple instances, and allow scaling.
const inMemoryJobs = {};

// Parse JSON request bodies
app.use(express.json({ limit: "20mb" }));

// ---------- Cloudinary Configuration (ENV in Render) ----------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------- Health Check Endpoint ----------
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- Helper Functions ----------
async function probeDuration(url) {
  // Returns real video duration in seconds as a float
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

// Function to send a callback to N8N or any other specified URL
async function sendCallback(callbackUrl, payload) {
  if (!callbackUrl) {
    console.log(`[Job ${payload?.jobId || 'UNKNOWN'}] No callback URL provided for this job. Skipping callback.`);
    return;
  }

  const controller = new AbortController();
  // Set a timeout for the callback request (e.g., 10 seconds)
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    console.log(`[Job ${payload?.jobId || 'UNKNOWN'}] Sending callback to ${callbackUrl} with payload:`, JSON.stringify(payload));
    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal // Link abort controller to fetch request
    });
    clearTimeout(timeoutId); // Clear the timeout if fetch completes in time

    if (!response.ok) {
      console.error(`[Job ${payload?.jobId || 'UNKNOWN'}] Callback to ${callbackUrl} failed with status ${response.status}: ${await response.text()}`);
    } else {
      console.log(`[Job ${payload?.jobId || 'UNKNOWN'}] Callback to ${callbackUrl} successful.`);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error(`[Job ${payload?.jobId || 'UNKNOWN'}] Callback to ${callbackUrl} timed out after 10 seconds.`);
    } else {
      console.error(`[Job ${payload?.jobId || 'UNKNOWN'}] Error sending callback to ${callbackUrl}:`, error);
    }
  } finally {
    clearTimeout(timeoutId); // Ensure timeout is cleared even on other errors
  }
}

// ---------- Main processing logic (now in a separate, non-blocking function) ----------
async function processVideoJob(jobId, jobData, callbackUrl) {
  const startedAt = Date.now();
  // Update job status in memory
  inMemoryJobs[jobId] = { status: "processing", progress: 0, startedAt, ...jobData };

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
      publicIdPrefix = ""
    } = jobData;

    console.log(`[Job ${jobId}] Starting video processing...`);
    inMemoryJobs[jobId].progress = 10; // Update progress

    // 1) Get UGC duration
    const duration = await probeDuration(ugcUrl);
    console.log(`[Job ${jobId}] UGC duration: ${duration}s`);
    inMemoryJobs[jobId].progress = 20;

    // 2) Calculate insertion points
    const points = [];
    for (let t = interval; t < duration - insertLen; t += interval) {
      points.push(+t.toFixed(3));
    }
    points.push(+(Math.max(0, duration - insertLen)).toFixed(3));
    const starts = uniqSorted(points);
    console.log(`[Job ${jobId}] Insert points:`, starts);
    inMemoryJobs[jobId].progress = 30;

    // 3) Build filter_complex string
    const fadeOutStart = +(insertLen - fadeSec).toFixed(3);
    const parts = [];

    parts.push(`[0:v]scale=${width}:${height},fps=${fps},format=yuv420p[base]`);

    parts.push(
      `[1:v]scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc1out]`
    );

    const sc2Input = show2Url ? "[2:v]" : "[1:v]"; // Use show1 if show2 is not provided
    parts.push(
      `${sc2Input}scale=${width}:${height},format=rgba,trim=0:${insertLen},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${fadeSec}:alpha=1,fade=t=out:st=${fadeOutStart}:d=${fadeSec}:alpha=1[sc2out]`
    );

    const totalOverlays = starts.length;
    const needSc1 = Math.ceil(totalOverlays / 2);
    const needSc2 = Math.floor(totalOverlays / 2);

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

    // 4) Execute ffmpeg
    const outFile = `/tmp/final_${jobId}.mp4`;

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

    console.log(`[Job ${jobId}] ==== FFmpeg filter_complex ====\n` + filter + "\n===============================");
    console.log(`[Job ${jobId}] FFmpeg CMD:`, cmd);
    inMemoryJobs[jobId].progress = 50;

    let ffmpegStdout = "";
    let ffmpegStderr = "";
    try {
      console.log(`[Job ${jobId}] Executing FFmpeg command...`);
      const { stdout, stderr } = await sh(cmd, { maxBuffer: 1024 * 1024 * 200 }); // Increased buffer for logs
      ffmpegStdout = stdout || "";
      ffmpegStderr = stderr || "";
      console.log(`[Job ${jobId}] FFmpeg command completed.`);
      inMemoryJobs[jobId].progress = 80;
    } catch (e) {
      console.error(`[Job ${jobId}] FFmpeg command failed:`, e);
      // Update job status and send callback on failure
      inMemoryJobs[jobId] = {
        ...inMemoryJobs[jobId],
        status: "failed",
        error: "ffmpeg_failed",
        details: (e && e.message) || "unknown",
        filter_complex: filter,
        cmd,
        stderr: e?.stderr ? String(e.stderr).slice(-4000) : "",
        stdout: e?.stdout ? String(e.stdout).slice(-1000) : ""
      };
      await sendCallback(callbackUrl, { jobId, status: "failed", error: inMemoryJobs[jobId].error, details: inMemoryJobs[jobId].details, cmd });
      return; // Exit as FFmpeg failed
    }

    // 5) Upload to Cloudinary
    const publicId = `${publicIdPrefix ? publicIdPrefix + "_" : ""}${jobId}`;
    let up;
    try {
      console.log(`[Job ${jobId}] Uploading to Cloudinary...`);
      up = await cloudinary.uploader.upload(outFile, {
        resource_type: "video",
        folder: `${folder}/${new Date().toISOString().slice(0, 10)}`,
        public_id: publicId,
        overwrite: true,
      });
      console.log(`[Job ${jobId}] Cloudinary upload complete. URL: ${up.secure_url}`);
      inMemoryJobs[jobId].progress = 95;
    } catch (e) {
      console.error(`[Job ${jobId}] Cloudinary upload failed:`, e);
      // Update job status and send callback on failure
      inMemoryJobs[jobId] = {
        ...inMemoryJobs[jobId],
        status: "failed",
        error: "cloudinary_upload_failed",
        details: e?.message || String(e),
        duration,
        filter_complex: filter,
        cmd,
        ffmpeg_stderr_tail: String(ffmpegStderr).slice(-1500)
      };
      await sendCallback(callbackUrl, { jobId, status: "failed", error: inMemoryJobs[jobId].error, details: inMemoryJobs[jobId].details, cmd });
      return; // Exit as Cloudinary upload failed
    } finally {
      // Always attempt to delete the temporary file
      try { await fs.unlink(outFile); console.log(`[Job ${jobId}] Deleted temporary file: ${outFile}`); } catch (e) { console.warn(`[Job ${jobId}] Failed to delete temp file: ${outFile}`, e); }
    }

    // 6) Job completed successfully
    inMemoryJobs[jobId] = {
      ...inMemoryJobs[jobId],
      status: "completed",
      progress: 100,
      video_url: up.secure_url,
      public_id: up.public_id,
      duration,
      starts,
      elapsed_ms: Date.now() - startedAt
    };
    console.log(`[Job ${jobId}] Video processing completed successfully. Elapsed: ${inMemoryJobs[jobId].elapsed_ms}ms`);
    // Send success callback
    await sendCallback(callbackUrl, {
      jobId,
      status: "completed",
      video_url: up.secure_url,
      public_id: up.public_id,
      duration,
      starts,
      elapsed_ms: Date.now() - startedAt
    });

  } catch (err) {
    console.error(`[Job ${jobId}] compose_failed:`, err);
    // Catch any unexpected errors during job processing
    inMemoryJobs[jobId] = {
      ...inMemoryJobs[jobId],
      status: "failed",
      error: "compose_failed",
      details: String(err?.message || err)
    };
    await sendCallback(callbackUrl, { jobId, status: "failed", error: inMemoryJobs[jobId].error, details: inMemoryJobs[jobId].details });
  }
}

// ---------- Main API Endpoint (now returns immediately) ----------
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
 *   publicIdPrefix="",
 *   callbackUrl (optional) - URL for the server to POST results back to N8N
 * }
 */
app.post("/compose", (req, res) => { // This function is no longer 'async' and responds immediately
  const jobId = randomUUID().slice(0, 8);
  const { ugcUrl, show1Url, callbackUrl, ...otherBodyParams } = req.body || {};

  if (!ugcUrl || !show1Url) {
    return res.status(400).json({ error: "Missing ugcUrl/show1Url" });
  }

  // Store the initial job request data and status
  inMemoryJobs[jobId] = {
    status: "queued",
    submittedAt: Date.now(),
    ugcUrl,
    show1Url,
    callbackUrl, // Store callback URL for the background process
    ...otherBodyParams
  };

  console.log(`Received new job request. Job ID: ${jobId}. Kicking off background process.`);

  // Kick off the long-running process without awaiting it.
  // This allows the current HTTP request to return immediately.
  processVideoJob(jobId, req.body, callbackUrl)
    .catch(err => {
      // This catch handles errors that might occur *during* the initial kickoff of processVideoJob
      console.error(`Error during initial background job kickoff for job ${jobId}:`, err);
      // Ensure job status is marked as failed
      inMemoryJobs[jobId] = {
        ...inMemoryJobs[jobId],
        status: "failed",
        error: "initial_background_kickoff_error",
        details: String(err?.message || err)
      };
      // Attempt to send callback even for wrapper errors
      sendCallback(callbackUrl, { jobId, status: "failed", error: "initial_background_kickoff_error", details: String(err?.message || err) });
    });

  // Immediately send a 202 Accepted response.
  // N8N will receive this response quickly, preventing timeouts.
  // The actual result will be sent via the callbackUrl or can be polled via /status/:jobId
  return res.status(202).json({
    ok: true,
    message: "Video composition job started. Awaiting completion callback.",
    jobId: jobId,
    status_url: `/status/${jobId}` // Optional: for polling the job status
  });
});

// Optional: Endpoint for N8N to check job status (if callbacks are not used or as a fallback)
app.get("/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const job = inMemoryJobs[jobId];

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }
  return res.json(job);
});


// ---------- Start Server ----------
const PORT = process.env.PORT || 10000; // Important for Render to use process.env.PORT
app.listen(PORT, () => console.log(`FFmpeg API listening on :${PORT}`));
