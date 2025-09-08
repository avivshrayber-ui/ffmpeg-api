import express from "express";
import { exec } from "child_process";

const app = express();

// בריאות בסיסית (Render משתמש לעיתים לבדיקת תקינות)
app.get("/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// בדיקת גרסת FFmpeg (לווידוא שההתקנה בדוקר הצליחה)
app.get("/ffmpeg/version", (req, res) => {
  exec("ffmpeg -version", (error, stdout, stderr) => {
    if (error) {
      return res.status(500).json({ error: error.message, stderr });
    }
    const firstLine = stdout.split("\n")[0] || "";
    res.json({ version: firstLine.trim() });
  });
});

// TODO: כאן תוסיף מסלולי API אמיתיים שעושים עיבוד וידאו עם ffmpeg

const PORT = process.env.PORT || 3000;
// חשוב! להאזין על 0.0.0.0 כדי ש-Render יוכל להגיע לשירות
app.listen(PORT, "0.0.0.0", () => {
  console.log(`FFmpeg API listening on http://0.0.0.0:${PORT}`);
});
