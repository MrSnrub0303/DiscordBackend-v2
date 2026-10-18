const { app } = require("../app");
const { CLIENT_ID, CLIENT_SECRET } = require("../config");

// Prevent duplicate Discord code exchanges (single-flight) to avoid 429s from double submission
const CODE_CACHE_TTL_MS = 30 * 1000;
const codeExchangeCache = new Map();

// Cloudflare IP-ban cooldown — when Discord's Cloudflare layer bans the server's
// outbound IP, all token-exchange requests fail fast instead of sleeping for hours.
let discordCloudflareBlockedUntil = 0;

const cleanCodeExchangeCache = () => {
  const now = Date.now();
  for (const [code, entry] of codeExchangeCache.entries()) {
    if (now - entry.timestamp > CODE_CACHE_TTL_MS) {
      codeExchangeCache.delete(code);
    }
  }
};

setInterval(cleanCodeExchangeCache, CODE_CACHE_TTL_MS);

const reserveCodeExchange = (code) => {
  const now = Date.now();
  const existing = codeExchangeCache.get(code);

  if (existing && now - existing.timestamp < CODE_CACHE_TTL_MS) {
    return existing.status; // 'pending' | 'done'
  }

  codeExchangeCache.set(code, { timestamp: now, status: 'pending' });
  return null;
};

const finalizeCodeExchange = (code, status) => {
  const entry = codeExchangeCache.get(code);
  if (entry) {
    entry.status = status;
    entry.timestamp = Date.now();
  }
};

const releaseCodeExchange = (code) => {
  codeExchangeCache.delete(code);
};

async function exchangeDiscordCode(req, res, label) {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "missing code" });

  const existingStatus = reserveCodeExchange(code);
  if (existingStatus) {
    return res.status(409).json({
      error: "This authorization code was already submitted",
      details: "Discord codes are single-use. Please reopen the activity to get a fresh code.",
    });
  }

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
  });

  const MAX_RETRIES = 3;
  const BASE_DELAY_MS = 1000;
  // Retry-After values above this threshold indicate a Cloudflare IP-level ban
  // (not a normal Discord per-route rate limit). We never sleep through these —
  // we fail fast and gate all subsequent requests until the ban expires.
  const CLOUDFLARE_BAN_THRESHOLD_S = 60;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const attemptExchange = async (attempt) => {
    const resp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    console.log(`[Token ${label}] Attempt ${attempt} response status:`, resp.status);
    console.log(`[Token ${label}] Response content-type:`, resp.headers.get('content-type'));

    if (resp.status === 429) {
      const retryAfterRaw = resp.headers.get('retry-after');
      const retryAfterSec = retryAfterRaw ? parseFloat(retryAfterRaw) : 0;

      // Cloudflare IP-level ban: Retry-After is huge and the body is HTML, not JSON.
      // Never sleep through this — record the ban expiry and fail immediately.
      if (retryAfterSec > CLOUDFLARE_BAN_THRESHOLD_S) {
        discordCloudflareBlockedUntil = Date.now() + retryAfterSec * 1000;
        const minutesLeft = Math.ceil(retryAfterSec / 60);
        console.error(`[Token ${label}] Cloudflare IP ban detected — blocked for ~${minutesLeft} min. Failing fast.`);
        throw Object.assign(
          new Error(`Discord infrastructure rate limit — try again in ~${minutesLeft} minutes`),
          { status: 429, isCloudflareban: true, retryAfterSec }
        );
      }

      // Normal Discord per-route rate limit: short Retry-After, safe to retry.
      const waitMs = retryAfterSec > 0
        ? retryAfterSec * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[Token ${label}] Rate limited (429), waiting ${waitMs}ms before retry...`);
      if (attempt < MAX_RETRIES) {
        await sleep(waitMs);
        return attemptExchange(attempt + 1);
      }
      throw Object.assign(new Error('Discord rate limit exceeded after retries'), { status: 429, isRateLimit: true });
    }

    const contentType = resp.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const textResponse = await resp.text();
      console.error(`[Token ${label}] Non-JSON response (status ${resp.status}):`, textResponse.substring(0, 200));
      if (resp.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`[Token ${label}] Server error, retrying in ${waitMs}ms...`);
        await sleep(waitMs);
        return attemptExchange(attempt + 1);
      }
      throw Object.assign(new Error('Invalid response from Discord API'), {
        status: resp.status,
        bodyPreview: textResponse.substring(0, 200),
      });
    }

    const json = await resp.json();
    if (!resp.ok) {
      console.error(`[Token ${label}] Discord API error:`, json);
      throw Object.assign(new Error('Discord API error'), { status: resp.status, body: json });
    }

    return json;
  };

  try {
    console.log(`[Token ${label}] Starting token exchange...`);
    console.log(`[Token ${label}] Code length:`, code?.length);

    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error(`[Token ${label}] Missing credentials`);
      finalizeCodeExchange(code, 'done');
      return res.status(500).json({ error: "Server configuration error" });
    }

    // Gate: if the server's IP is currently Cloudflare-banned, fail immediately
    // without sending another request to Discord (which would just extend the ban).
    if (Date.now() < discordCloudflareBlockedUntil) {
      const secondsLeft = Math.ceil((discordCloudflareBlockedUntil - Date.now()) / 1000);
      const minutesLeft = Math.ceil(secondsLeft / 60);
      console.warn(`[Token ${label}] Cloudflare ban still active — ${secondsLeft}s remaining. Rejecting without calling Discord.`);
      releaseCodeExchange(code);
      return res.status(503).json({
        error: "Service temporarily unavailable",
        details: `Discord's infrastructure has rate-limited this server's IP. Please try again in ~${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`,
        retryAfterSeconds: secondsLeft,
      });
    }

    console.log(`[Token ${label}] Making request to Discord API...`);

    const json = await attemptExchange(1);
    console.log(`[Token ${label}] Success`);
    finalizeCodeExchange(code, 'done');
    return res.json(json);
  } catch (err) {
    console.error(`[Token ${label}] Exception:`, err.message);
    releaseCodeExchange(code);

    if (err.isCloudflareban) {
      const minutesLeft = Math.ceil(err.retryAfterSec / 60);
      return res.status(503).json({
        error: "Service temporarily unavailable",
        details: `Discord's infrastructure has rate-limited this server's IP. Please try again in ~${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.`,
        retryAfterSeconds: err.retryAfterSec,
      });
    }
    if (err.isRateLimit) {
      return res.status(429).json({
        error: "Discord rate limit exceeded",
        details: "The server was rate limited by Discord. Please wait a moment and try again.",
      });
    }
    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }
    if (err.status === 502 || (err.bodyPreview !== undefined)) {
      return res.status(502).json({
        error: "Invalid response from Discord API",
        details: "Expected JSON but received HTML. Network or proxy issue.",
        status: err.status,
        bodyPreview: err.bodyPreview,
      });
    }
    return res.status(500).json({
      error: "Internal server error",
      details: err.message,
      type: err.name,
    });
  }
}

app.post("/api/token", async (req, res) => exchangeDiscordCode(req, res, 'API'));

app.post("/token", async (req, res) => exchangeDiscordCode(req, res, '/token'));
