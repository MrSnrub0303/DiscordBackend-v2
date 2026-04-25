'use strict';
/**
 * RankedQueueService
 *
 * Scans the Relic API for AoE3:DE ranked queue parties (SESSION_MATCH_KEY
 * advertisements) and enriches each player with their ELO via getPersonalStat.
 *
 * Steam Guard: when prompted, the service stores the pending callback and sets
 * status to 'needs_guard_code'. The app's /api/ranked/steam-guard endpoint
 * accepts the code and resolves the callback — no env vars or redeploys needed.
 *
 * Rate limit:  max ~15 API calls per 30 s poll (well under the 50/30 s ceiling).
 * Ghost-lobby cap: 8 minutes (after 7.5 min players get force-matched anyway).
 * Session cache: Steam auth renewed every 25 minutes automatically.
 */

const axios     = require('axios');
const SteamUser = require('steam-user');

const APP_ID   = 933110;
const BASE_URL = 'https://aoe-api.worldsedgelink.com';
const ABC      = '-565431487';   // appBinaryChecksum – patch 100.15.59076.0
const DC       = '157255947';   // dataChecksum      – patch 100.15.59076.0

const GHOST_CAP_MS = 8 * 60 * 1000;
const SCAN_BACK    = 500;
const BATCH_SIZE   = 50;
const CACHE_TTL_MS = 30_000;
const SESSION_TTL  = 25 * 60 * 1000;

// ─── In-memory state ─────────────────────────────────────────────────────────

let steamSession       = null;
let knownSessions      = new Map();
let lastMaxId          = 0;
let cachedResult       = null;
let pollInProgress     = false;
let sentryToken        = null;   // machine auth token persisted across re-auths

// Steam Guard pending state
let guardPendingCallback = null; // the callback steam-user gave us
let guardNeeded          = false;

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getSteamSession() {
  if (steamSession && Date.now() < steamSession.expiresAt) return steamSession;

  return new Promise((resolve, reject) => {
    const client = new SteamUser();

    const logonOpts = {
      accountName: process.env.STEAM_USERNAME,
      password:    process.env.STEAM_PASSWORD,
    };
    if (sentryToken) logonOpts.machineAuthToken = sentryToken;

    client.logOn(logonOpts);

    // Steam Guard fired — store the callback, expose status to the UI
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      console.log(`[RankedQueue] Steam Guard required (domain=${domain || 'mobile'}, wrong=${lastCodeWrong})`);
      guardPendingCallback = callback;
      guardNeeded          = true;
      // Don't reject — just wait. The /api/ranked/steam-guard endpoint will call submitGuardCode().
    });

    // Machine auth token — save in memory so restarts within the same Render dyno lifetime skip Guard
    client.on('machineAuthToken', token => {
      sentryToken = token;
      guardNeeded = false;
      console.log('[RankedQueue] Machine auth token saved — Guard not needed for this process lifetime');
    });

    client.on('loggedOn', async () => {
      guardNeeded          = false;
      guardPendingCallback = null;
      try {
        const { encryptedAppTicket } = await client.createEncryptedAppTicket(APP_ID, Buffer.from('RLINK'));
        const auth = encodeURIComponent(encryptedAppTicket.toString('base64'));
        const id64 = client.steamID.getSteamID64();

        const loginURL =
          `${BASE_URL}/game/login/platformlogin?` +
          `accountType=STEAM&activeMatchId=-1&alias=${id64}&appID=${APP_ID}` +
          `&auth=${auth}&callNum=0&clientLibVersion=190&country=AU` +
          `&installationType=windows&language=en&macAddress=DE-AD-D0-0D-00-00` +
          `&majorVersion=4.0.0&minorVersion=0&platformUserID=${id64}` +
          `&timeoutOverride=0&title=age3`;

        const r = await axios.post(loginURL, null, {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' },
        });

        const sid     = Array.isArray(r.data) && typeof r.data[1] === 'string' ? r.data[1] : null;
        const cookies = (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');

        if (!sid) throw new Error('Could not extract sessionID from Relic login');

        client.logOff();
        steamSession = { sid, cookies, expiresAt: Date.now() + SESSION_TTL };
        console.log('[RankedQueue] Steam session acquired');
        resolve(steamSession);
      } catch (e) {
        client.logOff();
        reject(e);
      }
    });

    client.on('error', e => reject(new Error(`Steam login error: ${e.message}`)));
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeHeaders(cookies) {
  return { Cookie: cookies, 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-store' };
}

function baseParams(sid) {
  return { sessionID: sid, connect_id: sid, title: 'age3', callNum: '0', appBinaryChecksum: ABC, dataChecksum: DC, versionFlags: '0', modName: 'INVALID', modDLLChecksum: '0', modDLLFile: 'INVALID', modVersion: 'INVALID' };
}

async function getAdvertisements(ids, sid, cookies) {
  const r = await axios.post(
    `${BASE_URL}/game/advertisement/getAdvertisements`,
    new URLSearchParams({ ...baseParams(sid), match_ids: JSON.stringify(ids) }).toString(),
    { headers: makeHeaders(cookies) }
  );
  return Array.isArray(r.data[1]) ? r.data[1] : [];
}

async function fetchPersonalStats(profileIds) {
  if (!profileIds.length) return { statMap: {}, profileMap: {} };
  const statMap = {}, profileMap = {};
  for (let i = 0; i < profileIds.length; i += 50) {
    const batch = profileIds.slice(i, i + 50);
    try {
      const r = await axios.get(
        `${BASE_URL}/community/leaderboard/getPersonalStat?title=age3&profile_ids=${JSON.stringify(batch)}`
      );
      (r.data?.statGroups ?? []).forEach(sg => sg.members?.forEach(m => {
        profileMap[m.profile_id] = { sgId: sg.id, alias: m.alias, country: m.country };
      }));
      (r.data?.leaderboardStats ?? []).forEach(ls => {
        if (!statMap[ls.statgroup_id]) statMap[ls.statgroup_id] = [];
        statMap[ls.statgroup_id].push({ lbId: ls.leaderboard_id, rating: ls.rating, rank: ls.rank > 0 ? ls.rank : null, wins: ls.wins, losses: ls.losses });
      });
    } catch { /* tolerate individual batch failures */ }
    await delay(120);
  }
  return { statMap, profileMap };
}

function relevantElo(entries, partySize) {
  if (!entries?.length) return null;
  const targetLb = partySize === 1 ? 1 : 2;
  return entries.find(e => e.lbId === targetLb)?.rating ?? null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Core poll ────────────────────────────────────────────────────────────────

async function poll() {
  if (pollInProgress) return;
  if (guardNeeded)    return; // waiting for user to submit Guard code — skip poll
  pollInProgress = true;

  try {
    const { sid, cookies } = await getSteamSession();

    // If getSteamSession triggered Guard, it will just be pending — bail gracefully
    if (guardNeeded) return;

    const now = Date.now();
    const commR      = await axios.get(`${BASE_URL}/community/advertisement/findAdvertisements?title=age3`);
    const currentMax = Math.max(...(commR.data.matches || []).map(m => m.id), lastMaxId);

    const newStartId = Math.max(lastMaxId - 100, currentMax - SCAN_BACK);
    const newAds = [];
    for (let id = newStartId; id <= currentMax + 50; id += BATCH_SIZE) {
      const ids = Array.from({ length: BATCH_SIZE }, (_, i) => id + i);
      const results = await getAdvertisements(ids, sid, cookies);
      results.filter(m => m[8] === 'SESSION_MATCH_KEY' && m[24] === null).forEach(m => newAds.push(m));
      await delay(80);
    }

    newAds.forEach(m => {
      if (!knownSessions.has(m[0])) knownSessions.set(m[0], { firstSeen: now, data: m });
      else knownSessions.get(m[0]).data = m;
    });

    const seenIds = new Set(newAds.map(m => m[0]));
    const toRecheckIds = [];
    for (const [id, session] of knownSessions) {
      if (!seenIds.has(id)) {
        if (now - session.firstSeen < GHOST_CAP_MS) toRecheckIds.push(id);
        else knownSessions.delete(id);
      }
    }

    if (toRecheckIds.length > 0) {
      for (let i = 0; i < toRecheckIds.length; i += BATCH_SIZE) {
        const batch = toRecheckIds.slice(i, i + BATCH_SIZE);
        const results = await getAdvertisements(batch, sid, cookies);
        const stillActive = new Set(results.filter(m => m[8] === 'SESSION_MATCH_KEY' && m[24] === null).map(m => m[0]));
        batch.forEach(id => { if (!stillActive.has(id)) knownSessions.delete(id); });
        await delay(80);
      }
    }

    for (const [id, session] of knownSessions) {
      if (now - session.firstSeen >= GHOST_CAP_MS) knownSessions.delete(id);
    }

    lastMaxId = currentMax;

    const activeSessions = [...knownSessions.values()].map(s => s.data);
    const allProfileIds  = [...new Set(activeSessions.flatMap(m => (m[17] || []).map(p => p[1])))];
    const { statMap, profileMap } = await fetchPersonalStats(allProfileIds);

    const parties = activeSessions.map(m => {
      const players = (m[17] || []).map(p => {
        const pInfo  = profileMap[p[1]] || {};
        const entries = statMap[pInfo.sgId] ?? [];
        const pSize  = (m[17] || []).length;
        const elo    = relevantElo(entries, pSize);
        return { profileId: p[1], alias: pInfo.alias || null, country: pInfo.country || null, elo, hasElo: elo !== null };
      });
      const elos    = players.map(p => p.elo).filter(e => e !== null);
      const teamElo = players.length > 1 && elos.length > 0 ? elos.reduce((a, b) => a + b, 0) : null;
      return {
        lobbyId: m[0], partySize: players.length, region: m[25], teamElo, players,
        firstSeen: knownSessions.get(m[0])?.firstSeen ?? now,
      };
    });

    parties.sort((a, b) => {
      const aElo = a.teamElo ?? (a.players[0]?.elo ?? 0);
      const bElo = b.teamElo ?? (b.players[0]?.elo ?? 0);
      return bElo - aElo;
    });

    cachedResult = { timestamp: new Date().toISOString(), parties };
    console.log(`[RankedQueue] Poll complete: ${parties.length} parties, ${allProfileIds.length} players`);
  } catch (e) {
    console.error('[RankedQueue] Poll error:', e.message);
  } finally {
    pollInProgress = false;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

let pollInterval = null;

function start() {
  if (pollInterval) return;
  if (!process.env.STEAM_USERNAME || !process.env.STEAM_PASSWORD) {
    console.warn('[RankedQueue] STEAM_USERNAME/STEAM_PASSWORD not set — ranked queue disabled');
    return;
  }
  poll();
  pollInterval = setInterval(poll, CACHE_TTL_MS);
  console.log('[RankedQueue] Service started (polling every 30s)');
}

function getQueue() {
  if (guardNeeded) return { timestamp: null, parties: [], status: 'needs_guard_code' };
  if (!cachedResult) return { timestamp: null, parties: [], status: 'initializing' };
  return { ...cachedResult, status: 'ok' };
}

/** Called by POST /api/ranked/steam-guard when the user submits the code from the app */
function submitGuardCode(code) {
  if (!guardPendingCallback) return { success: false, error: 'No Steam Guard prompt pending' };
  const cb = guardPendingCallback;
  guardPendingCallback = null;
  guardNeeded          = false;
  cb(code.trim());
  // Trigger a poll now that auth can proceed
  setTimeout(poll, 1000);
  return { success: true };
}

module.exports = { start, getQueue, submitGuardCode };
