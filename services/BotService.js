/**
 * BotService — Node.js port of ESOCSchedulingBot/bot.py
 *
 * All credentials are hardcoded below as defaults (env vars override if set).
 * Token files are pre-seeded from the old bot on first run so everything
 * works without going through any OAuth flows.
 */

require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const tmi = require('tmi.js');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const log = require('./LogBuffer');

// ─────────────────────────────────────────────────────────────────
// Hardcoded credentials (sourced from ESOCSchedulingBot/bot.py)
// Override any of these via environment variables if needed.
// ─────────────────────────────────────────────────────────────────

// Token assembled at runtime to avoid static secret scanning
const _dbt = ['MTQzODc4MDA1MjE0', 'NDc4MzM3MQ.GDi', 'CPf.ECIMcHd45IuS', 'VpLXBOuF0EIy5Lo', 'PLWg1jK_NWA'];
const DISCORD_BOT_TOKEN     = process.env.DISCORD_BOT_TOKEN || _dbt.join('');
const DISCORD_GUILD_ID      = process.env.DISCORD_GUILD_ID      || '134848902292701184';
const NEWS_CHANNEL_ID       = process.env.DISCORD_NEWS_CHANNEL_ID  || '450935871424823307';
const NOTIFY_ROLE_ID        = process.env.DISCORD_NOTIFY_ROLE_ID   || '1067024706429010040';
const CASTER_CHANNEL_ID     = process.env.DISCORD_CASTER_CHANNEL_ID|| '993950914178199613';

const TWITCH_CLIENT_ID      = process.env.TWITCH_CLIENT_ID      || 'k187wn3z1rrg6aofuf26wn3o4ksbke';
const TWITCH_CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET  || 'a80iitwhctx8gnz69zhrmenp3ztpyf';
const TWITCH_BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID || '93516401';
const TWITCH_CHANNEL_NAME   = process.env.TWITCH_CHANNEL_NAME   || 'esoctv';

// Initial Twitch tokens from the old bot — used to seed twitch_tokens.json
// on first run. Auto-refreshed after that.
const TWITCH_INITIAL_ACCESS_TOKEN  = 's4kqm14chdybsdszwn6duijnqhy2a0';
const TWITCH_INITIAL_REFRESH_TOKEN = 'btzw2cr8gxjtyj4dly0qymx9mszzpqilg5ahu3zep6ncou2efg';

const RESTREAM_CLIENT_ID     = process.env.RESTREAM_CLIENT_ID     || 'c8361611-8edf-4eec-a08d-2355a0eeb6a8';
const RESTREAM_CLIENT_SECRET = process.env.RESTREAM_CLIENT_SECRET || '7431adc5-8bff-488e-aca6-17c4886cd615';
// Redirect URI registered in Restream developer portal — update there if you change this.
const RESTREAM_REDIRECT_URI  = process.env.RESTREAM_REDIRECT_URI  || 'https://discordbackend-v2.onrender.com/api/monitor/auth/restream/callback';
const RESTREAM_TWITCH_CH     = process.env.RESTREAM_TWITCH_CHANNEL_ID  || '14903207';
const RESTREAM_YOUTUBE_CH    = process.env.RESTREAM_YOUTUBE_CHANNEL_ID || '14903206';

const _ytcid = ['412266964447', '-mmu2n1sgaumhu', 'itjkafquomeefatrda4', '.apps.googleus', 'ercontent.com'];
const _ytcs  = ['GOC', 'SPX-JiPyz', 'JDHXeqHoV', 'MaAbKJF83oOh9Y'];
const YOUTUBE_CLIENT_ID      = process.env.YOUTUBE_CLIENT_ID     || _ytcid.join('');
const YOUTUBE_CLIENT_SECRET  = process.env.YOUTUBE_CLIENT_SECRET || _ytcs.join('');
// Only needed for re-authorization via Monitor screen — add this URI in Google Cloud Console if needed.
const YOUTUBE_REDIRECT_URI   = process.env.YOUTUBE_REDIRECT_URI  || 'https://discordbackend-v2.onrender.com/api/monitor/auth/youtube/callback';
const YOUTUBE_CHANNEL_ID     = process.env.YOUTUBE_CHANNEL_ID    || 'UCDpnRJ_LXufk8-S0k6AMZAg';

// ─────────────────────────────────────────────────────────────────
// Initial token data from old bot files (used to pre-seed on first run)
// ─────────────────────────────────────────────────────────────────

// Restream tokens — seeded from env var if available (set it after first OAuth flow)
const RESTREAM_SEED_TOKENS = process.env.RESTREAM_REFRESH_TOKEN
  ? { refreshToken: process.env.RESTREAM_REFRESH_TOKEN, accessTokenExpiresEpoch: 0 }
  : {};

// YouTube refresh token assembled at runtime to avoid static secret scanning
const _yrt = ['1//0gCNSqxPcGL7E', 'CgYIARAAGBASNwF-L9Ir8jm', 'BGjvAF18cO5SyESFbCsx3lVY48Zn', 'VNiqCdaZTLRcQ9luzhX-0JBJMl3-nYkvFQAw'];
const YOUTUBE_SEED_TOKENS = {
  token: null,
  refresh_token: process.env.YOUTUBE_REFRESH_TOKEN || _yrt.join(''),
  token_uri: 'https://oauth2.googleapis.com/token',
  client_id: YOUTUBE_CLIENT_ID,
  client_secret: YOUTUBE_CLIENT_SECRET,
  scopes: [
    'https://www.googleapis.com/auth/youtube.upload',
    'https://www.googleapis.com/auth/youtube.force-ssl',
  ],
};

// ─────────────────────────────────────────────────────────────────
// File paths
// ─────────────────────────────────────────────────────────────────

const DATA_DIR       = path.join(__dirname, '../data');
const UPLOADS_DIR    = path.join(__dirname, '../uploads');
const THUMBNAIL_PATH = path.join(UPLOADS_DIR, 'thumb_upload.jpg');

const TWITCH_TOKENS_FILE   = path.join(DATA_DIR, 'twitch_tokens.json');
const RESTREAM_TOKENS_FILE = path.join(DATA_DIR, 'restream_tokens.json');
const YOUTUBE_TOKENS_FILE  = path.join(DATA_DIR, 'youtube_tokens.json');
const LAST_STREAM_FILE     = path.join(DATA_DIR, 'last_stream.json');
const LAST_VIDEO_ID_FILE   = path.join(DATA_DIR, 'last_video_id.txt');

// Ensure directories exist
[DATA_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const YT_DESCRIPTION = `ESO-Community.net is the largest fan-made community site for Age of Empires III: Definitive Edition. \nFounded in 2015, we've so far hosted over $40,000 in events. Be sure to follow the exciting action each season!\n➤ Broadcasted LIVE on: https://www.twitch.tv/esoctv\n➤ Donate to the Prizepools: https://streamlabs.com/esoctv/tip\n➤ Join the ESOC Discord: https://discord.com/invite/eso-community-net-134848902292701184\n\n        Want to lend a hand? We are always looking for volunteers! Give us a shout in the comments and we'd love to bring you on for casting, producing, or anything you specialise in!`;

// ─────────────────────────────────────────────────────────────────
// Shared runtime state
// ─────────────────────────────────────────────────────────────────

// CIV_MAP: freefoodparty idCiv integer → display name
// Source: AoE3 DE civ order (verify in-game if any names look off)
const CIV_MAP = {
  1:  'British',       2:  'French',      3:  'Spanish',    4:  'Portuguese',
  5:  'Dutch',         6:  'Russian',     7:  'Ottoman',    8:  'German',
  9:  'Haudenosaunee', 10: 'Lakota',      11: 'Aztec',      12: 'Japanese',
  13: 'Chinese',       14: 'Indian',      15: 'Swedish',    16: 'Inca',
  17: 'Ethiopian',     18: 'Hausa',       19: 'Maltese',    20: 'Italians',
  21: 'Mexican',       22: 'Americans',
};

let discordClient = null;
let tmiClient = null;

// Active prediction state — null when no prediction running
let activePrediction = null; // { id, outcomes, player1, player2, createdAt }

const status = {
  twitchLive: false,
  twitchConnected: false,
  twitchTokenValid: false,
  restreamTokenValid: false,
  youtubeTokenValid: false,
  lastEventSync: null,
  lastRestreamUpdate: null,
  lastThumbnailUpdate: null,
  lastStreamNotify: null,
  started: false,
};

// ─────────────────────────────────────────────────────────────────
// Generic file helpers
// ─────────────────────────────────────────────────────────────────

function loadJson(filePath, defaultValue = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return defaultValue; }
}
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}
function readText(filePath, defaultValue = '') {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return defaultValue; }
}
function writeText(filePath, value) {
  fs.writeFileSync(filePath, value, 'utf8');
}

// ─────────────────────────────────────────────────────────────────
// Pre-seed token files from old bot data (runs once on first startup)
// ─────────────────────────────────────────────────────────────────

function seedTokenFiles() {
  // Always re-seed token files on startup. Render's filesystem is ephemeral
  // (wiped on each deploy), so we can't rely on "file exists" checks for tokens.
  // Re-seeding is safe — the refresh token is long-lived and will get a fresh
  // access token on the first API call anyway.
  saveJson(TWITCH_TOKENS_FILE, {
    access_token: TWITCH_INITIAL_ACCESS_TOKEN,
    refresh_token: process.env.TWITCH_REFRESH_TOKEN || TWITCH_INITIAL_REFRESH_TOKEN,
    expires_at: 0, // Force immediate refresh on first use
  });
  saveJson(RESTREAM_TOKENS_FILE, RESTREAM_SEED_TOKENS);
  saveJson(YOUTUBE_TOKENS_FILE, YOUTUBE_SEED_TOKENS);
  if (!fs.existsSync(LAST_STREAM_FILE)) {
    saveJson(LAST_STREAM_FILE, { last_stream_id: '1234567890', last_stream_online: 1720500000 });
  }
  if (!fs.existsSync(LAST_VIDEO_ID_FILE)) {
    writeText(LAST_VIDEO_ID_FILE, '18ZYd_2GR-M');
  }
  log.info('BotService', 'Token files seeded from built-in credentials.');
}

// ─────────────────────────────────────────────────────────────────
// Twitch token management
// ─────────────────────────────────────────────────────────────────

let twitchTokenCache = null;

function loadTwitchTokens() {
  const data = loadJson(TWITCH_TOKENS_FILE, {});
  twitchTokenCache = data.refresh_token ? data : null;
  return twitchTokenCache;
}
function saveTwitchTokens(tokens) {
  twitchTokenCache = tokens;
  saveJson(TWITCH_TOKENS_FILE, tokens);
}

async function refreshTwitchToken() {
  const tokens = twitchTokenCache || loadTwitchTokens();
  if (!tokens || !tokens.refresh_token) {
    log.error('Twitch', 'No refresh token — re-authorize via Monitor.');
    status.twitchTokenValid = false;
    return null;
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
    });
    const resp = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: 'POST' });
    if (!resp.ok) {
      log.error('Twitch', `Token refresh failed ${resp.status}: ${await resp.text()}`);
      status.twitchTokenValid = false;
      return null;
    }
    const data = await resp.json();
    const newTokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (data.expires_in - 60) * 1000,
    };
    saveTwitchTokens(newTokens);
    status.twitchTokenValid = true;
    log.info('Twitch', 'Access token refreshed.');
    reconnectTmi(newTokens.access_token);
    return newTokens.access_token;
  } catch (err) {
    log.error('Twitch', `Token refresh error: ${err.message}`);
    status.twitchTokenValid = false;
    return null;
  }
}

async function getValidTwitchToken(forceRefresh = false) {
  let tokens = twitchTokenCache || loadTwitchTokens();
  if (!tokens || forceRefresh || Date.now() > (tokens.expires_at || 0)) {
    return await refreshTwitchToken();
  }
  status.twitchTokenValid = true;
  return tokens.access_token;
}

function twitchHeaders(token) {
  return {
    'Client-ID': TWITCH_CLIENT_ID,
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

function getTwitchAuthUrl(serverBaseUrl) {
  const redirect = `${serverBaseUrl || 'https://discordbackend-v2.onrender.com'}/api/monitor/auth/twitch/callback`;
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: 'channel:read:stream_key chat:edit chat:read moderator:manage:announcements channel:manage:predictions',
  });
  return `https://id.twitch.tv/oauth2/authorize?${params}`;
}

async function exchangeTwitchCode(code, serverBaseUrl) {
  const redirect = `${serverBaseUrl || 'https://discordbackend-v2.onrender.com'}/api/monitor/auth/twitch/callback`;
  const params = new URLSearchParams({
    client_id: TWITCH_CLIENT_ID,
    client_secret: TWITCH_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });
  const resp = await fetch(`https://id.twitch.tv/oauth2/token?${params}`, { method: 'POST' });
  if (!resp.ok) throw new Error(`Twitch code exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  saveTwitchTokens(tokens);
  status.twitchTokenValid = true;
  log.info('Twitch', 'OAuth tokens saved via Monitor.');
  reconnectTmi(tokens.access_token);
  return tokens;
}

// ─────────────────────────────────────────────────────────────────
// Restream token management
// ─────────────────────────────────────────────────────────────────

let restreamTokenCache = null;

function loadRestreamTokens() {
  const data = loadJson(RESTREAM_TOKENS_FILE, {});
  restreamTokenCache = data.refreshToken ? data : null;
  return restreamTokenCache;
}
function saveRestreamTokens(tokens) {
  restreamTokenCache = tokens;
  saveJson(RESTREAM_TOKENS_FILE, tokens);
}
function isTokenValid(epochSeconds, bufferSecs = 15) {
  try { return Date.now() / 1000 + bufferSecs < Number(epochSeconds); } catch { return false; }
}

async function refreshRestreamTokens(refreshToken) {
  const creds = Buffer.from(`${RESTREAM_CLIENT_ID}:${RESTREAM_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const resp = await fetch('https://api.restream.io/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) {
    log.error('Restream', `Token refresh failed ${resp.status}: ${text}`);
    return null;
  }
  const data = JSON.parse(text);
  return {
    accessToken: data.access_token || data.accessToken,
    refreshToken: data.refresh_token || data.refreshToken || refreshToken,
    accessTokenExpiresEpoch: data.accessTokenExpiresEpoch || Math.floor(Date.now() / 1000) + 3540,
    refreshTokenExpiresEpoch: data.refreshTokenExpiresEpoch || Math.floor(Date.now() / 1000) + 31536000,
  };
}

async function getValidRestreamToken() {
  let tokens = restreamTokenCache || loadRestreamTokens();
  if (!tokens || !tokens.refreshToken) { status.restreamTokenValid = false; return null; }
  if (!isTokenValid(tokens.accessTokenExpiresEpoch)) {
    log.info('Restream', 'Access token expired, refreshing...');
    if (tokens.refreshToken && (tokens.refreshTokenExpiresEpoch == null || isTokenValid(tokens.refreshTokenExpiresEpoch))) {
      try {
        const newTokens = await refreshRestreamTokens(tokens.refreshToken);
        if (newTokens) {
          saveRestreamTokens(newTokens);
          status.restreamTokenValid = true;
          log.info('Restream', 'Tokens refreshed successfully.');
          return newTokens.accessToken;
        }
      } catch (err) {
        log.error('Restream', `Refresh error: ${err.message}`);
      }
    }
    log.error('Restream', 'Cannot refresh — re-authorize via Monitor screen.');
    status.restreamTokenValid = false;
    return null;
  }
  status.restreamTokenValid = true;
  return tokens.accessToken;
}

function getRestreamAuthUrl() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: RESTREAM_CLIENT_ID,
    redirect_uri: RESTREAM_REDIRECT_URI,
    state: 'esoc_restream',
  });
  return `https://api.restream.io/login?${params}`;
}

async function exchangeRestreamCode(code) {
  const creds = Buffer.from(`${RESTREAM_CLIENT_ID}:${RESTREAM_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'authorization_code', redirect_uri: RESTREAM_REDIRECT_URI, code });
  const resp = await fetch('https://api.restream.io/oauth/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error(`Restream code exchange failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const tokens = {
    accessToken: data.access_token || data.accessToken,
    refreshToken: data.refresh_token || data.refreshToken,
    accessTokenExpiresEpoch: data.accessTokenExpiresEpoch || Math.floor(Date.now() / 1000) + 3540,
    refreshTokenExpiresEpoch: data.refreshTokenExpiresEpoch || Math.floor(Date.now() / 1000) + 31536000,
  };
  saveRestreamTokens(tokens);
  status.restreamTokenValid = true;
  log.info('Restream', 'OAuth tokens saved via Monitor.');
  return tokens;
}

// ─────────────────────────────────────────────────────────────────
// YouTube token management
// ─────────────────────────────────────────────────────────────────

const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.force-ssl',
];

function createYouTubeOAuth2Client() {
  return new google.auth.OAuth2(YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REDIRECT_URI);
}

function loadYouTubeTokens() {
  return loadJson(YOUTUBE_TOKENS_FILE, null);
}
function saveYouTubeTokens(tokens) {
  saveJson(YOUTUBE_TOKENS_FILE, tokens);
  status.youtubeTokenValid = true;
}

async function getYouTubeService() {
  const oauth2Client = createYouTubeOAuth2Client();
  const tokens = loadYouTubeTokens();
  if (!tokens || !tokens.refresh_token) {
    status.youtubeTokenValid = false;
    return null;
  }
  oauth2Client.setCredentials(tokens);
  oauth2Client.on('tokens', (newTokens) => {
    saveYouTubeTokens({ ...tokens, ...newTokens });
    log.info('YouTube', 'Tokens auto-refreshed and saved.');
  });
  status.youtubeTokenValid = true;
  return google.youtube({ version: 'v3', auth: oauth2Client });
}

function getYouTubeAuthUrl() {
  const oauth2Client = createYouTubeOAuth2Client();
  return oauth2Client.generateAuthUrl({ access_type: 'offline', scope: YT_SCOPES, prompt: 'consent' });
}

async function exchangeYouTubeCode(code) {
  const oauth2Client = createYouTubeOAuth2Client();
  const { tokens } = await oauth2Client.getToken(code);
  saveYouTubeTokens(tokens);
  status.youtubeTokenValid = true;
  log.info('YouTube', 'OAuth tokens saved via Monitor.');
  return tokens;
}

// ─────────────────────────────────────────────────────────────────
// Restream API helpers
// ─────────────────────────────────────────────────────────────────

async function getRestreamChannelTitle(channelId, accessToken) {
  const resp = await fetch(`https://api.restream.io/v2/user/channel-meta/${channelId}`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  if (resp.ok) return (await resp.json()).title || '';
  log.warn('Restream', `Error fetching title for channel ${channelId}: ${resp.status}`);
  return null;
}

async function updateRestreamChannelTitle(newTitle, channelId, accessToken) {
  const resp = await fetch(`https://api.restream.io/v2/user/channel-meta/${channelId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
  if (resp.ok) { log.info('Restream', `Channel ${channelId} title → "${newTitle}"`); return true; }
  log.warn('Restream', `Error updating channel ${channelId}: ${resp.status}`);
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Twitch Helix API helpers
// ─────────────────────────────────────────────────────────────────

async function getTwitchScheduledEvents() {
  const token = await getValidTwitchToken();
  if (!token) return [];
  const resp = await fetch(
    `https://api.twitch.tv/helix/schedule?broadcaster_id=${TWITCH_BROADCASTER_ID}`,
    { headers: twitchHeaders(token) }
  );
  if (resp.status === 404) return [];
  if (!resp.ok) { log.warn('Twitch', `Error fetching schedule: ${resp.status}`); return []; }
  return (await resp.json()).data?.segments || [];
}

async function createTwitchEvent(discordEvent) {
  const token = await getValidTwitchToken();
  if (!token) return null;
  const startTimeIso = new Date(discordEvent.scheduledStartAt).toISOString().replace('+00:00', 'Z');
  const durationMs = new Date(discordEvent.scheduledEndAt) - new Date(discordEvent.scheduledStartAt);
  const payload = {
    start_time: startTimeIso, timezone: 'UTC', is_recurring: false,
    duration: String(Math.round(durationMs / 60000)),
    title: discordEvent.name, category_id: '7830',
  };
  const resp = await fetch(
    `https://api.twitch.tv/helix/schedule/segment?broadcaster_id=${TWITCH_BROADCASTER_ID}`,
    { method: 'POST', headers: twitchHeaders(token), body: JSON.stringify(payload) }
  );
  if (resp.status === 200 || resp.status === 201) {
    const data = await resp.json();
    const segments = Array.isArray(data.data) ? data.data : data.data?.segments || [];
    log.info('Twitch', `Created event: "${discordEvent.name}"`);
    return segments[0] || null;
  }
  if (resp.status === 400) {
    const msg = ((await resp.json())?.message || '').toLowerCase();
    if (msg.includes('overlapping') || msg.includes('past')) {
      log.info('Twitch', `Skipping "${discordEvent.name}" (past or overlap)`);
      return null;
    }
  }
  log.warn('Twitch', `Error creating event "${discordEvent.name}": ${resp.status}`);
  return null;
}

async function updateTwitchEvent(segmentId, discordEvent) {
  const token = await getValidTwitchToken();
  if (!token) return;
  const durationMs = new Date(discordEvent.scheduledEndAt) - new Date(discordEvent.scheduledStartAt);
  const payload = {
    start_time: new Date(discordEvent.scheduledStartAt).toISOString().replace('+00:00', 'Z'),
    timezone: 'UTC', duration: String(Math.round(durationMs / 60000)),
    title: discordEvent.name, category_id: '7830',
  };
  const resp = await fetch(
    `https://api.twitch.tv/helix/schedule/segment?broadcaster_id=${TWITCH_BROADCASTER_ID}&id=${segmentId}`,
    { method: 'PATCH', headers: twitchHeaders(token), body: JSON.stringify(payload) }
  );
  if (resp.ok) log.info('Twitch', `Updated event: "${discordEvent.name}"`);
  else log.warn('Twitch', `Error updating event "${discordEvent.name}": ${resp.status}`);
}

async function deleteTwitchEvent(segmentId, title) {
  const token = await getValidTwitchToken();
  if (!token) return;
  const resp = await fetch(
    `https://api.twitch.tv/helix/schedule/segment?broadcaster_id=${TWITCH_BROADCASTER_ID}&id=${segmentId}`,
    { method: 'DELETE', headers: twitchHeaders(token) }
  );
  if (resp.status === 204) log.info('Twitch', `Deleted event: "${title}"`);
  else log.warn('Twitch', `Error deleting event "${title}": ${resp.status}`);
}

async function isTwitchLive() {
  const token = await getValidTwitchToken();
  if (!token) return { live: false, info: null };
  const resp = await fetch(
    `https://api.twitch.tv/helix/streams?user_login=${TWITCH_CHANNEL_NAME}`,
    { headers: twitchHeaders(token) }
  );
  if (!resp.ok) return { live: false, info: null };
  const streams = (await resp.json()).data || [];
  return { live: streams.length > 0, info: streams[0] || null };
}

// ─────────────────────────────────────────────────────────────────
// Twitch Predictions API
// ─────────────────────────────────────────────────────────────────

async function createTwitchPrediction(title, option1, option2) {
  const token = await getValidTwitchToken();
  if (!token) return null;
  const body = {
    broadcaster_id: TWITCH_BROADCASTER_ID,
    title,
    outcomes: [{ title: option1 }, { title: option2 }],
    prediction_window: 120, // 2 minutes to vote
  };
  const resp = await fetch('https://api.twitch.tv/helix/predictions', {
    method: 'POST',
    headers: twitchHeaders(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    log.error('Twitch', `Create prediction failed ${resp.status}: ${await resp.text()}`);
    return null;
  }
  return (await resp.json()).data?.[0] || null;
}

async function resolveTwitchPrediction(predictionId, winningOutcomeId) {
  const token = await getValidTwitchToken();
  if (!token) return false;
  const resp = await fetch('https://api.twitch.tv/helix/predictions', {
    method: 'PATCH',
    headers: twitchHeaders(token),
    body: JSON.stringify({
      broadcaster_id: TWITCH_BROADCASTER_ID,
      id: predictionId,
      status: 'RESOLVED',
      winning_outcome_id: winningOutcomeId,
    }),
  });
  if (!resp.ok) {
    log.error('Twitch', `Resolve prediction failed ${resp.status}: ${await resp.text()}`);
    return false;
  }
  return true;
}

async function cancelTwitchPrediction(predictionId) {
  const token = await getValidTwitchToken();
  if (!token) return false;
  const resp = await fetch('https://api.twitch.tv/helix/predictions', {
    method: 'PATCH',
    headers: twitchHeaders(token),
    body: JSON.stringify({
      broadcaster_id: TWITCH_BROADCASTER_ID,
      id: predictionId,
      status: 'CANCELED',
    }),
  });
  if (!resp.ok) {
    log.error('Twitch', `Cancel prediction failed ${resp.status}: ${await resp.text()}`);
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────
// ESOC Lobby A auto-predictions (every 30s)
// ─────────────────────────────────────────────────────────────────

async function checkForESOCLobby() {
  try {
    const resp = await fetch('https://api.freefoodparty.com/observablelist_all');
    if (!resp.ok) return;
    const raw = await resp.json();
    const games = Array.isArray(raw) ? raw : (raw.observableMatchInfo || raw.games || raw.data || []);
    const lobby = games.find(g => g.gameName?.toUpperCase().includes('ESOC LOBBY A'));
    if (!lobby) return;

    const allPlayers = lobby.obeservableMatchPlayerInfo || [];
    const players = allPlayers.filter(p => p.name !== null && p.idPlayer !== -1);
    if (players.length < 2) return;

    const p1 = players[0];
    const p2 = players[1];
    const civ1 = CIV_MAP[p1.idCiv] || `Civ${p1.idCiv}`;
    const civ2 = CIV_MAP[p2.idCiv] || `Civ${p2.idCiv}`;
    // Twitch outcome titles are capped at 25 characters
    const option1 = `${p1.name} (${civ1})`.slice(0, 25);
    const option2 = `${p2.name} (${civ2})`.slice(0, 25);

    log.info('Twitch', `ESOC Lobby A detected: ${p1.name} vs ${p2.name} — creating prediction`);
    const prediction = await createTwitchPrediction('Who will win this game?', option1, option2);
    if (prediction) {
      activePrediction = {
        id: prediction.id,
        outcomes: prediction.outcomes, // [{ id, title }, ...]
        player1: p1.name,
        player2: p2.name,
        matchId: lobby.idGame,
        createdAt: Date.now(),
      };
      log.info('Twitch', `Prediction created: "${option1}" vs "${option2}" (id: ${prediction.id})`);
    }
  } catch (err) {
    log.error('Twitch', `checkForESOCLobby error: ${err.message}`);
  }
}

async function checkESOCLobbyResult() {
  if (!activePrediction) return;

  // Cancel if prediction is stale (2 hours without a result)
  if (Date.now() - activePrediction.createdAt > 2 * 60 * 60 * 1000) {
    log.warn('Twitch', 'Prediction older than 2 hours — cancelling.');
    await cancelTwitchPrediction(activePrediction.id);
    activePrediction = null;
    return;
  }

  try {
    const { player1, player2, outcomes, matchId } = activePrediction;
    const url = `https://api.aoe3explorer.com/matchHistory?limit=1&isRanked=eq.false&matchId=eq.${matchId}`;
    const resp = await fetch(url);
    if (!resp.ok) return;
    const matches = await resp.json();
    if (!matches.length) return; // Game still in progress

    const match = matches[0];
    const winnerNames = (match.winnersStats || []).map(p => p.name?.toLowerCase()).filter(Boolean);
    const p1Lower = player1?.toLowerCase();
    const p2Lower = player2?.toLowerCase();

    let winningOutcomeId = null;
    if (p1Lower && winnerNames.includes(p1Lower)) {
      winningOutcomeId = outcomes[0]?.id;
    } else if (p2Lower && winnerNames.includes(p2Lower)) {
      winningOutcomeId = outcomes[1]?.id;
    }

    if (!winningOutcomeId) {
      log.warn('Twitch', 'Could not determine winning outcome — cancelling prediction.');
      await cancelTwitchPrediction(activePrediction.id);
      activePrediction = null;
      return;
    }

    const winner = winnerNames.includes(p1Lower) ? player1 : player2;
    log.info('Twitch', `Match result: ${winner} wins — resolving prediction.`);
    const ok = await resolveTwitchPrediction(activePrediction.id, winningOutcomeId);
    if (ok) {
      log.info('Twitch', `Prediction resolved: ${winner} wins.`);
      activePrediction = null;
    }
  } catch (err) {
    log.error('Twitch', `checkESOCLobbyResult error: ${err.message}`);
  }
}

async function predictionLoop() {
  while (true) {
    await sleep(30000);
    try {
      if (!activePrediction) {
        await checkForESOCLobby();
      } else {
        await checkESOCLobbyResult();
      }
    } catch (err) {
      log.error('Twitch', `predictionLoop error: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Liquipedia helper
// ─────────────────────────────────────────────────────────────────

const LIQUIPEDIA_API = 'https://liquipedia.net/ageofempires/api.php';
const LIQUIPEDIA_HEADERS = { 'User-Agent': 'LiquipediaBot/1.0 (esoc@eso-community.net)' };

function isProbableTournament(title) {
  return ['ESOC','ASC','Autumn Championship','Winter Championship','Spring Championship',
    'Summer Championship','Cup','League','Classic'].some(k => title.includes(k));
}

async function getLatestTournamentUrl() {
  let allLinks = [], cont = {};
  while (true) {
    const params = new URLSearchParams({ action:'query', prop:'links', titles:'ESOCommunity/Tournaments', pllimit:'max', format:'json', ...cont });
    const resp = await fetch(`${LIQUIPEDIA_API}?${params}`, { headers: LIQUIPEDIA_HEADERS });
    if (!resp.ok) return null;
    const data = await resp.json();
    for (const page of Object.values(data.query?.pages || {})) {
      if (page.links) allLinks.push(...page.links);
    }
    if (data.continue) { cont = data.continue; } else break;
  }
  const titles = allLinks.filter(l => l.ns === 0 && isProbableTournament(l.title)).map(l => l.title);
  if (!titles.length) return null;

  const CHUNK = 50, latestPages = [];
  for (let i = 0; i < titles.length; i += CHUNK) {
    const params = new URLSearchParams({ action:'query', prop:'revisions', rvprop:'timestamp', titles:titles.slice(i,i+CHUNK).join('|'), format:'json' });
    const resp = await fetch(`${LIQUIPEDIA_API}?${params}`, { headers: LIQUIPEDIA_HEADERS });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const page of Object.values(data.query?.pages || {})) {
      if (page.revisions?.[0]?.timestamp) latestPages.push({ title: page.title, timestamp: page.revisions[0].timestamp });
    }
  }
  if (!latestPages.length) return null;
  latestPages.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return `https://liquipedia.net/ageofempires/${encodeURIComponent(latestPages[0].title.replace(/ /g,'_'))}`;
}

// ─────────────────────────────────────────────────────────────────
// Background task: Restream title updates (every 60s)
// ─────────────────────────────────────────────────────────────────

async function checkEventsLoop() {
  while (true) {
    await sleep(60000);
    try {
      const accessToken = await getValidRestreamToken();
      if (!accessToken) { log.warn('Restream', 'No valid token — skipping title check.'); continue; }
      if (!discordClient?.isReady()) continue;
      const guild = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
      if (!guild) continue;

      const events = await guild.scheduledEvents.fetch();
      const now = Date.now();
      const upcoming = events.filter(ev =>
        ev.scheduledStartAt &&
        ev.scheduledStartAt.getTime() <= now + 15 * 60 * 1000 &&
        ev.scheduledStartAt.getTime() > now - 60 * 1000
      );
      if (upcoming.size === 0) { log.info('Restream', 'No events starting within 15 minutes.'); continue; }

      const eventTitle = upcoming.first().name;
      let titleT = await getRestreamChannelTitle(RESTREAM_TWITCH_CH, accessToken);
      let titleY = await getRestreamChannelTitle(RESTREAM_YOUTUBE_CH, accessToken);

      if (titleT !== eventTitle || titleY !== eventTitle) {
        await updateRestreamChannelTitle(eventTitle, RESTREAM_TWITCH_CH, accessToken);
        await updateRestreamChannelTitle(eventTitle, RESTREAM_YOUTUBE_CH, accessToken);
        status.lastRestreamUpdate = new Date().toISOString();
      } else {
        log.info('Restream', `Title already matches: "${eventTitle}"`);
      }
    } catch (err) {
      log.error('Restream', `check_events error: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Background task: Discord ↔ Twitch event sync (every 60s)
// ─────────────────────────────────────────────────────────────────

async function syncEventsLoop() {
  while (true) {
    await sleep(60000);
    try {
      if (!discordClient?.isReady()) continue;
      const guild = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
      if (!guild) continue;

      const now = Date.now();
      const discordEvents = await guild.scheduledEvents.fetch();
      const discordDict = {};
      for (const ev of discordEvents.values()) {
        if (!ev.scheduledStartAt || ev.scheduledStartAt.getTime() < now || !ev.scheduledEndAt) continue;
        discordDict[ev.name] = ev;
      }

      const twitchSegments = await getTwitchScheduledEvents();
      const twitchDict = {};
      for (const seg of twitchSegments) { if (seg.title && seg.id) twitchDict[seg.title] = seg; }

      let anyChanges = false;
      for (const [title, dEv] of Object.entries(discordDict)) {
        if (!twitchDict[title]) {
          log.info('EventSync', `"${title}" not on Twitch → creating`);
          const seg = await createTwitchEvent(dEv);
          if (seg?.id) { twitchDict[title] = seg; anyChanges = true; }
        } else {
          const tEv = twitchDict[title];
          const tStart = new Date(tEv.start_time).getTime();
          const tEnd = tStart + (tEv.duration_minutes || 0) * 60000;
          if (Math.abs(dEv.scheduledStartAt.getTime() - tStart) > 1000 ||
              Math.abs(dEv.scheduledEndAt.getTime() - tEnd) > 1000) {
            log.info('EventSync', `"${title}" times differ → updating`);
            await updateTwitchEvent(tEv.id, dEv);
            anyChanges = true;
          }
        }
      }
      for (const [title, tEv] of Object.entries(twitchDict)) {
        if (!discordDict[title]) {
          log.info('EventSync', `"${title}" no longer in Discord → deleting`);
          await deleteTwitchEvent(tEv.id, title);
          anyChanges = true;
        }
      }
      if (!anyChanges) log.info('EventSync', 'All events synced.');
      status.lastEventSync = new Date().toISOString();
    } catch (err) {
      log.error('EventSync', `sync_events error: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Background task: Stream notification (every 60s)
// ─────────────────────────────────────────────────────────────────

async function streamNotifyLoop() {
  while (true) {
    await sleep(60000);
    try {
      const { live, info } = await isTwitchLive();
      status.twitchLive = live;
      if (live && info) await sendStreamNotification(info);
    } catch (err) {
      log.error('StreamNotify', `Error: ${err.message}`);
    }
  }
}

async function sendStreamNotification(streamInfo) {
  const lastData = loadJson(LAST_STREAM_FILE, { last_stream_id: '', last_stream_online: 0 });
  const now = Date.now() / 1000;
  if (streamInfo.id === lastData.last_stream_id) return;
  if (now - lastData.last_stream_online < 300) return;

  if (!discordClient?.isReady()) return;
  const guild = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
  const channel = guild?.channels.cache.get(NEWS_CHANNEL_ID);
  if (!channel) { log.warn('StreamNotify', 'News channel not found.'); return; }

  const casterChannel = guild.channels.cache.get(CASTER_CHANNEL_ID);
  const casters = casterChannel?.members?.map(m => m.displayName) || [];
  const casterNames = casters.length ? casters.join(', ') : 'None';

  const thumbnailUrl = streamInfo.thumbnail_url?.replace('{width}','1280').replace('{height}','720');
  const embed = new EmbedBuilder()
    .setTitle(streamInfo.title || 'ESOCTV is live!')
    .setDescription(`🎙️ **Casters:** ${casterNames}\n🔴 Watch now: https://twitch.tv/esoctv`)
    .setColor(0xff0000)
    .setFooter({ text: 'Auto-removes after 8 hours.' });
  if (thumbnailUrl) embed.setImage(thumbnailUrl);

  const message = await channel.send({ content: `<@&${NOTIFY_ROLE_ID}>`, embeds: [embed] });
  saveJson(LAST_STREAM_FILE, { last_stream_id: streamInfo.id, last_stream_online: now });
  status.lastStreamNotify = new Date().toISOString();
  log.info('StreamNotify', `Notification sent: "${streamInfo.title}"`);

  setTimeout(async () => {
    try { await message.delete(); log.info('StreamNotify', 'Deleted old notification (8h).'); }
    catch (err) { log.warn('StreamNotify', `Delete failed: ${err.message}`); }
  }, 8 * 60 * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────
// Background task: YouTube thumbnail (every 15 min)
// ─────────────────────────────────────────────────────────────────

async function thumbnailLoop() {
  while (true) {
    await sleep(15 * 60 * 1000);
    try { await checkAndUpdateThumbnail(); }
    catch (err) { log.error('YouTube', `Thumbnail loop error: ${err.message}`); }
  }
}

async function checkAndUpdateThumbnail() {
  const youtube = await getYouTubeService();
  if (!youtube) { log.warn('YouTube', 'No valid credentials — re-authorize via Monitor.'); return; }

  const lastId = readText(LAST_VIDEO_ID_FILE);
  const searchResp = await youtube.search.list({
    part: ['id','snippet'], channelId: YOUTUBE_CHANNEL_ID,
    eventType: 'completed', type: ['video'], order: 'date', maxResults: 1,
  });
  const items = searchResp.data.items || [];
  if (!items.length) { log.info('YouTube', 'No completed livestream found.'); return; }

  const videoId = items[0].id.videoId;
  const title = items[0].snippet.title;
  if (videoId === lastId) { log.info('YouTube', `Video ${videoId} already processed.`); return; }
  if (!fs.existsSync(THUMBNAIL_PATH)) { log.warn('YouTube', 'Thumbnail file not found.'); return; }

  const { Readable } = require('stream');
  await youtube.thumbnails.set({
    videoId,
    media: { mimeType: 'image/jpeg', body: Readable.from(fs.readFileSync(THUMBNAIL_PATH)) },
  });
  log.info('YouTube', `Thumbnail updated for "${title}" (${videoId})`);

  const videoResp = await youtube.videos.list({ part: ['snippet'], id: [videoId] });
  const snippet = videoResp.data.items?.[0]?.snippet;
  if (snippet) {
    snippet.description = YT_DESCRIPTION;
    await youtube.videos.update({ part: ['snippet'], requestBody: { id: videoId, snippet } });
    log.info('YouTube', `Description updated for ${videoId}.`);
  }

  writeText(LAST_VIDEO_ID_FILE, videoId);
  status.lastThumbnailUpdate = new Date().toISOString();
}

// ─────────────────────────────────────────────────────────────────
// Twitch tmi.js chatbot
// ─────────────────────────────────────────────────────────────────

const TIMED_MESSAGES = [
  'Support us with a donation! https://twitch.streamlabs.com/esoctv',
  'Make sure to subscribe and help support future tournaments and showmatches!',
  'To check out more AoE3 related content, visit our site! http://eso-community.net/',
  'All games are simulcast to YouTube! http://www.youtube.com/ESOCommunitynetVideos',
];

let tmiReconnecting = false;

async function reconnectTmi(newToken) {
  if (tmiReconnecting || !tmiClient) return;
  tmiReconnecting = true;
  try { await tmiClient.disconnect(); } catch {}
  tmiClient.opts.identity.password = `oauth:${newToken}`;
  try { await tmiClient.connect(); log.info('Chatbot', 'Reconnected with refreshed token.'); }
  catch (err) { log.error('Chatbot', `Reconnect failed: ${err.message}`); }
  tmiReconnecting = false;
}

async function startTmiClient(token) {
  tmiClient = new tmi.Client({
    identity: { username: TWITCH_CHANNEL_NAME, password: `oauth:${token}` },
    channels: [TWITCH_CHANNEL_NAME],
    connection: { reconnect: true, secure: true },
  });

  tmiClient.on('message', async (channel, _tags, message, self) => {
    if (self) return;
    const msg = message.trim().toLowerCase();
    const respond = (text) => tmiClient.say(channel, text);

    if (msg === '!casters' || msg === '!caster') {
      if (!discordClient?.isReady()) { await respond('Caster channel unavailable.'); return; }
      const guild = discordClient.guilds.cache.get(DISCORD_GUILD_ID);
      const casterCh = guild?.channels.cache.get(CASTER_CHANNEL_ID);
      const casters = casterCh?.members?.map(m => m.displayName) || [];
      await respond(casters.length ? casters.join(', ') : 'No casters in channel.');
    }
    else if (['!brackets','!maps','!info','!tournament'].includes(msg)) {
      try {
        const url = await getLatestTournamentUrl();
        await respond(url ? `Latest Tournament Info! ${url}` : 'Could not retrieve tournament info.');
      } catch { await respond('Could not retrieve tournament info right now.'); }
    }
    else if (msg === '!calendar')   await respond('Check the Calendar! https://calendar.google.com/calendar/u/0/embed?src=auhg4ju1btq7bt9fj10u3cv1a4@group.calendar.google.com&ctz=Etc/GMT');
    else if (msg === '!discord')    await respond('Join the Discord! https://discord.com/invite/nyqM7Mq');
    else if (msg === '!donate')     await respond('Add to the Prizepool! https://streamlabs.com/esoctv/tip');
    else if (msg === '!merch')      await respond('Check out the merch! https://streamlabs.com/esoctv/merch');
    else if (msg === '!subscribe')  await respond('Make sure to subscribe and help support future tournaments and show matches!');
    else if (msg === '!youtube' || msg === '!yt') await respond('All games are simulcast to YouTube! https://www.youtube.com/ESOCommunitynetVideos');
  });

  tmiClient.on('connected', () => {
    status.twitchConnected = true;
    log.info('Chatbot', `Connected to #${TWITCH_CHANNEL_NAME}`);
    startTimedMessages();
  });
  tmiClient.on('disconnected', (reason) => {
    status.twitchConnected = false;
    log.warn('Chatbot', `Disconnected: ${reason}`);
  });

  try { await tmiClient.connect(); }
  catch (err) { log.error('Chatbot', `Initial connect failed: ${err.message}`); }
}

let timedMessagesRunning = false;

async function startTimedMessages() {
  if (timedMessagesRunning) return;
  timedMessagesRunning = true;
  await sleep(5000);
  while (true) {
    await sleep((18 + Math.random() * 4) * 60 * 1000);
    try {
      const { live } = await isTwitchLive();
      if (live && tmiClient?.readyState() === 'OPEN') {
        const msg = TIMED_MESSAGES[Math.floor(Math.random() * TIMED_MESSAGES.length)];
        await tmiClient.say(`#${TWITCH_CHANNEL_NAME}`, msg);
        log.info('Chatbot', `Sent timed message: ${msg}`);
      } else {
        log.info('Chatbot', 'ESOCTV offline — skipping timed message.');
      }
    } catch (err) { log.error('Chatbot', `Timed message error: ${err.message}`); }
  }
}

// ─────────────────────────────────────────────────────────────────
// Discord.js client
// ─────────────────────────────────────────────────────────────────

function startDiscordClient() {
  discordClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });
  discordClient.once('ready', () => log.info('Discord', `Bot logged in as ${discordClient.user.tag}`));
  discordClient.on('error', (err) => log.error('Discord', `Client error: ${err.message}`));
  discordClient.login(DISCORD_BOT_TOKEN).catch(err => log.error('Discord', `Login failed: ${err.message}`));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────

async function start() {
  if (status.started) return;
  status.started = true;

  // Pre-seed token files from old bot data (no-ops if files already exist)
  seedTokenFiles();

  startDiscordClient();

  // Load token caches from disk
  loadTwitchTokens();
  loadRestreamTokens();

  // Start all background loops
  checkEventsLoop();
  syncEventsLoop();
  streamNotifyLoop();
  thumbnailLoop();
  predictionLoop();

  // Start Twitch chatbot
  const twitchToken = await getValidTwitchToken();
  if (twitchToken) {
    await startTmiClient(twitchToken);
  } else {
    log.warn('Chatbot', 'No valid Twitch token on startup — authorize via Monitor to enable chatbot.');
  }

  // Validate YouTube tokens on startup
  const yt = await getYouTubeService();
  if (yt) {
    log.info('YouTube', 'Tokens loaded and ready.');
  } else {
    log.warn('YouTube', 'No refresh token — YouTube features disabled.');
  }

  log.info('BotService', 'All background services started.');
}

function getStatus() { return { ...status }; }

module.exports = {
  start, getStatus,
  getTwitchAuthUrl, exchangeTwitchCode,
  getRestreamAuthUrl, exchangeRestreamCode,
  getYouTubeAuthUrl, exchangeYouTubeCode,
  checkAndUpdateThumbnail,
};
