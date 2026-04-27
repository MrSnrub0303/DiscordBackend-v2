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
 * Ghost-lobby cap: 10 minutes. Deduplication runs after, so most recent session always wins.
 * Session cache: Steam auth renewed every 25 minutes automatically.
 */

const axios     = require('axios');
const SteamUser = require('steam-user');
const fs        = require('fs');
const path      = require('path');

// Persisted machine auth token — survives server restarts so Guard is only needed once
const MACHINE_AUTH_FILE = path.join(__dirname, '..', '.steam_machine_auth');

const APP_ID   = 933110;
const BASE_URL = 'https://aoe-api.worldsedgelink.com';
const ABC      = '-565431487';   // appBinaryChecksum – patch 100.15.59076.0
const DC       = '157255947';   // dataChecksum      – patch 100.15.59076.0

const GHOST_CAP_MS       = 10 * 60 * 1000;
const GHOST_THRESHOLD_MS =       90_000; // 3 poll cycles — trust lastSeen over getAdvertisements
const SCAN_BACK    = 500;
const BATCH_SIZE   = 50;
const CACHE_TTL_MS = 30_000;
const SESSION_TTL  = 25 * 60 * 1000;

// ─── In-memory state ─────────────────────────────────────────────────────────

let steamSession      = null;
let knownSessions     = new Map();
let sessionFirstSeen  = new Map(); // lobbyId → original firstSeen; survives ghost deletions
let lastMaxId         = 0;
let cachedResult      = null;
let pollInProgress    = false;
let sentryToken       = null;   // machine auth token — avoids Guard within same process
let consecutiveErrors = 0;

// Steam Guard state
let guardNeeded    = false;  // true → UI should show code prompt
let pendingCode    = null;   // code submitted via the app, consumed on next login attempt

// ─── Machine auth token persistence ──────────────────────────────────────────

function loadPersistedToken() {
  try {
    const token = fs.readFileSync(MACHINE_AUTH_FILE, 'utf8').trim();
    if (token) {
      sentryToken = token;
      console.log('[RankedQueue] Loaded persisted machine auth token — Steam Guard will be skipped');
    }
  } catch {
    // File doesn't exist yet — first run, Guard code will be required once
  }
}

function persistToken(token) {
  try {
    fs.writeFileSync(MACHINE_AUTH_FILE, token, { encoding: 'utf8', mode: 0o600 });
    console.log('[RankedQueue] Machine auth token written to disk — Guard will be skipped on future restarts');
  } catch (e) {
    console.warn('[RankedQueue] Could not persist machine auth token:', e.message);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getSteamSession() {
  if (steamSession && Date.now() < steamSession.expiresAt) return steamSession;
  if (guardNeeded && !pendingCode) throw new Error('needs_guard_code');

  return new Promise((resolve, reject) => {
    const client = new SteamUser();
    let guardFired = false;

    const logonOpts = {
      accountName: process.env.STEAM_USERNAME,
      password:    process.env.STEAM_PASSWORD,
    };
    if (sentryToken) logonOpts.machineAuthToken = sentryToken;

    client.logOn(logonOpts);

    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      guardFired = true;
      if (pendingCode) {
        // We have a code from the UI — use it immediately
        console.log(`[RankedQueue] Providing submitted Guard code (domain=${domain || 'mobile'})`);
        const code = pendingCode;
        pendingCode = null;
        callback(code);
      } else {
        // No code available — abort this login and signal the UI
        console.log(`[RankedQueue] Steam Guard required (domain=${domain || 'mobile'}) — waiting for code from app`);
        guardNeeded = true;
        client.logOff();
        reject(new Error('needs_guard_code'));
      }
    });

    client.on('machineAuthToken', token => {
      sentryToken = token;
      persistToken(token);
    });

    client.on('loggedOn', async () => {
      // If Guard fired but we didn't provide a code (shouldn't happen, but guard against it)
      if (guardFired && guardNeeded) { client.logOff(); return; }
      guardNeeded = false;
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

    client.on('error', e => reject(new Error(`Steam login: ${e.message}`)));
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
  if (guardNeeded && !pendingCode) return; // waiting for Guard code from UI
  pollInProgress = true;

  try {
    const { sid, cookies } = await getSteamSession();

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
      // Restore the original firstSeen so queue-time display survives ghost deletions
      const originalFirstSeen = sessionFirstSeen.get(m[0]) ?? now;
      sessionFirstSeen.set(m[0], originalFirstSeen);

      if (!knownSessions.has(m[0])) {
        knownSessions.set(m[0], { firstSeen: originalFirstSeen, lastSeen: now, data: m });
      } else {
        const s = knownSessions.get(m[0]);
        s.data     = m;
        s.lastSeen = now;
      }
    });

    const seenIds = new Set(newAds.map(m => m[0]));
    const toRecheckIds = [];
    for (const [id, session] of knownSessions) {
      if (!seenIds.has(id)) {
        const age = now - (session.lastSeen ?? session.firstSeen);
        if (age < GHOST_THRESHOLD_MS) toRecheckIds.push(id);
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

    // Expire sessionFirstSeen entries that are truly ancient (past the absolute cap)
    for (const [id, ts] of sessionFirstSeen) {
      if (now - ts >= GHOST_CAP_MS) sessionFirstSeen.delete(id);
    }

    lastMaxId = currentMax;

    const activeSessions = [...knownSessions.values()].map(s => s.data);

    // Deduplicate: if a player appears in multiple sessions keep only their most recent (highest lobbyId)
    const playerLatest = new Map(); // profileId → highest lobbyId seen
    activeSessions.forEach(m => {
      (m[17] || []).forEach(p => {
        if (!playerLatest.has(p[1]) || m[0] > playerLatest.get(p[1])) playerLatest.set(p[1], m[0]);
      });
    });
    const dedupedSessions = activeSessions.filter(m =>
      (m[17] || []).every(p => playerLatest.get(p[1]) === m[0])
    );

    const allProfileIds  = [...new Set(dedupedSessions.flatMap(m => (m[17] || []).map(p => p[1])))];
    const { statMap, profileMap } = await fetchPersonalStats(allProfileIds);

    const parties = dedupedSessions.map(m => {
      const players = (m[17] || []).map(p => {
        const pInfo  = profileMap[p[1]] || {};
        const entries = statMap[pInfo.sgId] ?? [];
        const pSize  = (m[17] || []).length;
        const elo    = relevantElo(entries, pSize);
        return { profileId: p[1], alias: pInfo.alias || null, country: pInfo.country || null, elo, hasElo: elo !== null };
      });
      const elos    = players.map(p => p.elo).filter(e => e !== null);
      const teamElo = players.length > 1 && elos.length > 0 ? Math.round(elos.reduce((a, b) => a + b, 0) / elos.length) : null;
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
    consecutiveErrors = 0;
    console.log(`[RankedQueue] Poll complete: ${parties.length} parties, ${allProfileIds.length} players`);
  } catch (e) {
    if (e.message === 'needs_guard_code') {
      console.log('[RankedQueue] Waiting for Steam Guard code from app UI');
    } else {
      consecutiveErrors++;
      console.error(`[RankedQueue] Poll error (${consecutiveErrors}):`, e.message);

      // 401 = Relic session expired — invalidate immediately so next poll re-authenticates
      if (e.response?.status === 401 || e.message?.includes('401')) {
        console.log('[RankedQueue] 401 received — clearing Steam session for immediate re-auth');
        steamSession = null;
      }

      // After 3 consecutive failures clear the cache so stale data isn't shown indefinitely
      if (consecutiveErrors >= 3) {
        cachedResult = null;
        knownSessions.clear();
        sessionFirstSeen.clear();
        console.log('[RankedQueue] Cache cleared after repeated failures');
      }
    }
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
  loadPersistedToken();
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
  if (!guardNeeded) return { success: false, error: 'No Steam Guard prompt is currently pending' };
  pendingCode  = code.trim();
  guardNeeded  = false;
  steamSession = null; // force a fresh login attempt using the code
  console.log('[RankedQueue] Guard code received — retrying login');
  setTimeout(poll, 500);
  return { success: true };
}

module.exports = { start, getQueue, submitGuardCode };
