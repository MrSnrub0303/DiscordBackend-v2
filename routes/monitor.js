const fsSync = require("fs");
const path = require("path");
const multer = require("multer");
const { app } = require("../app");
const BotService = require("../services/BotService");
const LogBuffer = require("../services/LogBuffer");
const { getCachedTokenUser, setCachedTokenUser } = require("../lib/tokenCache");
const ROOT_DIR = path.join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────
// Monitor endpoints
// ─────────────────────────────────────────────────────────────────

const MONITOR_USERNAMES = (process.env.MONITOR_USERNAMES || "barronh,mclovin111.,joshua667746,grimescene")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

/**
 * Verify the caller is an authorized monitor user.
 * Reads the Discord username from the X-Discord-Username header (sent by the
 * client from currentUser.username, which comes from the verified Discord SDK
 * session). Falls back to a Discord API token check if the header is absent.
 */
async function isMonitorAuthorized(req) {
  // Primary: trust the username forwarded from the Discord SDK session
  const headerUsername = (req.headers["x-discord-username"] || "").toLowerCase().trim();
  if (headerUsername && MONITOR_USERNAMES.includes(headerUsername)) {
    return true;
  }

  // Fallback: verify via Discord API Bearer token (covers direct API calls)
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return false;
  const cachedUser = getCachedTokenUser(token);
  if (cachedUser) return MONITOR_USERNAMES.includes((cachedUser.username || "").toLowerCase());
  try {
    const resp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return false;
    const user = await resp.json();
    setCachedTokenUser(token, user);
    const username = (user.username || "").toLowerCase();
    return MONITOR_USERNAMES.includes(username);
  } catch {
    return false;
  }
}

// GET /api/restream/chat-token — returns a valid Restream access token for OBS chat overlay
// Allow-all CORS so OBS browser sources (file:// origin) can reach this endpoint
app.get("/api/restream/chat-token", async (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = await BotService.getRestreamAccessToken();
  if (!token) return res.status(503).json({ error: "No valid Restream token — authorize via Monitor." });
  res.json({ token });
});

// ─── Semi-automatic Twitch prediction controls (called from OBS dashboard) ───
app.get("/api/prediction/status", (_req, res) => {
  res.json(BotService.getPredictionStatus());
});

app.post("/api/prediction/end", async (_req, res) => {
  const result = await BotService.endPrediction();
  res.status(result.ok ? 200 : 400).json(result);
});

// GET /obs-dashboard — serves the ESOC Admin OBS dashboard (no auth; OBS loads it directly as a browser dock)
app.get("/obs-dashboard", (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, "obs-dashboard.html"));
});

// POST /api/monitor/upload-thumbnail  (multer, authorized only)
const thumbnailUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(ROOT_DIR, "uploads"),
    filename: (_req, _file, cb) => cb(null, "thumb_upload.jpg"),
  }),
  fileFilter: (_req, file, cb) => {
    const ok = ["image/jpeg", "image/png", "image/jpg"].includes(file.mimetype);
    cb(ok ? null : new Error("Only PNG or JPEG images allowed"), ok);
  },
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// ── Monitor routes (served with and without /api; Discord Activity proxy strips /api) ──
// Status and logs are public (UI is already gated; data isn't sensitive)
const monitorStatusHandler = (_req, res) => res.json(BotService.getStatus());
const monitorLogsHandler   = (_req, res) => res.json({ logs: LogBuffer.getAll() });

// Serves the current thumbnail image (authorized only)
const monitorThumbnailHandler = async (req, res) => {
  if (!(await isMonitorAuthorized(req))) return res.status(403).json({ error: "Forbidden" });
  const thumbnailPath = path.join(ROOT_DIR, "uploads", "thumb_upload.jpg");
  if (!fsSync.existsSync(thumbnailPath)) return res.status(404).json({ error: "No thumbnail uploaded yet" });
  res.sendFile(thumbnailPath);
};

// Thumbnail upload (multer, authorized only)
const monitorUploadThumbnailHandlers = [
  async (req, res, next) => {
    if (!(await isMonitorAuthorized(req))) return res.status(403).json({ error: "Forbidden" });
    next();
  },
  thumbnailUpload.single("thumbnail"),
  (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    LogBuffer.info("Monitor", `Thumbnail updated (${req.file.originalname})`);
    res.json({ success: true, filename: req.file.filename });
  },
];

app.get("/api/monitor/status",            monitorStatusHandler);
app.get("/monitor/status",                monitorStatusHandler);
app.get("/api/monitor/logs",              monitorLogsHandler);
app.get("/monitor/logs",                  monitorLogsHandler);
app.get("/api/monitor/thumbnail",         monitorThumbnailHandler);
app.get("/monitor/thumbnail",             monitorThumbnailHandler);
app.post("/api/monitor/upload-thumbnail", ...monitorUploadThumbnailHandlers);
app.post("/monitor/upload-thumbnail",     ...monitorUploadThumbnailHandlers);

// ── OAuth flows ──────────────────────────────────────────────────

const SERVER_BASE_URL = process.env.SERVER_BASE_URL || "https://discordbackend-v2.onrender.com";

// Twitch
app.get("/api/monitor/auth/twitch", (_req, res) => {
  res.redirect(BotService.getTwitchAuthUrl(SERVER_BASE_URL));
});

app.get("/api/monitor/auth/twitch/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<h2>Twitch auth failed: ${error || "no code"}</h2>`);
  }
  try {
    const tokens = await BotService.exchangeTwitchCode(String(code), SERVER_BASE_URL);
    res.send(`<h2>Twitch connected!</h2><p>Copy this refresh token and set it as <b>TWITCH_REFRESH_TOKEN</b> in Render so it survives restarts:</p><pre style="background:#111;color:#4ade80;padding:12px;word-break:break-all">${tokens.refresh_token}</pre>`);
  } catch (err) {
    res.send(`<h2>Twitch auth error: ${err.message}</h2>`);
  }
});

// Restream
app.get("/api/monitor/auth/restream", (_req, res) => {
  res.redirect(BotService.getRestreamAuthUrl());
});

app.get("/api/monitor/auth/restream/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<h2>Restream auth failed: ${error || "no code"}</h2>`);
  }
  try {
    const tokens = await BotService.exchangeRestreamCode(String(code));
    res.send(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2rem;background:#1a1a2e;color:#e0e0e0">
<h2 style="color:#4ade80">✅ Restream connected!</h2>
<p>Add this as a Render environment variable to avoid re-authorizing after each deploy:</p>
<p><b>Key:</b> <code style="background:#333;padding:2px 6px">RESTREAM_REFRESH_TOKEN</code></p>
<p><b>Value:</b></p>
<textarea rows="3" style="width:100%;background:#333;color:#fff;border:1px solid #555;padding:8px;font-family:monospace" onclick="this.select()">${tokens.refreshToken}</textarea>
<p style="color:#94a3b8;font-size:0.85em">Once saved in Render, this token will be used automatically on every restart. You can close this tab.</p>
</body></html>`);
  } catch (err) {
    res.send(`<h2>Restream auth error: ${err.message}</h2>`);
  }
});

// YouTube
app.get("/api/monitor/auth/youtube", (_req, res) => {
  res.redirect(BotService.getYouTubeAuthUrl());
});

app.get("/api/monitor/auth/youtube/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.send(`<h2>YouTube auth failed: ${error || "no code"}</h2>`);
  }
  try {
    const tokens = await BotService.exchangeYouTubeCode(String(code));
    const refreshToken = tokens?.refresh_token;
    if (!refreshToken) {
      return res.send(`<h2>YouTube connected!</h2><p>No refresh token returned — Google only issues a refresh token on first authorization. If you need a new one, revoke access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and re-authorize.</p>`);
    }
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>YouTube Connected</title></head>
<body style="font-family:sans-serif;background:#1a1a2e;color:#e2e8f0;padding:40px;max-width:600px;margin:auto">
<h2 style="color:#22c55e">✓ YouTube Connected!</h2>
<p>Save this as a Render environment variable so it survives redeploys:</p>
<p><b>Key:</b> <code style="background:#333;padding:2px 6px">YOUTUBE_REFRESH_TOKEN</code></p>
<p><b>Value:</b></p>
<textarea rows="3" style="width:100%;background:#333;color:#fff;border:1px solid #555;padding:8px;font-family:monospace" onclick="this.select()">${refreshToken}</textarea>
<p style="color:#94a3b8;font-size:0.85em">Once saved in Render, this token will be used automatically on every restart. You can close this tab.</p>
</body></html>`);
  } catch (err) {
    res.send(`<h2>YouTube auth error: ${err.message}</h2>`);
  }
});
