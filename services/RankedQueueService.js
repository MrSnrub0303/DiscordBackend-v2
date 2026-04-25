'use strict';
/**
 * RankedQueueService
 *
 * Scans the Relic API for AoE3:DE ranked queue parties (SESSION_MATCH_KEY
 * advertisements) and enriches each player with their ELO via getPersonalStat.
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

const GHOST_CAP_MS  = 8 * 60 * 1000;   // 8 minutes
const SCAN_BACK     = 500;              // IDs to scan on each poll (~last 10 min)
const BATCH_SIZE    = 50;
const CACHE_TTL_MS  = 30_000;          // serve cached result for up to 30 s
const SESSION_TTL   = 25 * 60 * 1000;  // renew Steam session every 25 min

// ─── In-memory state ─────────────────────────────────────────────────────────

let steamSession  = null;          // { sid, cookies, expiresAt }
let knownSessions = new Map();     // lobbyId → { firstSeen, data }
let lastMaxId     = 0;
let cachedResult  = null;          // { timestamp, parties }
let pollInProgress = false;
let sentryToken   = null;          // persisted in-memory across re-auths to avoid repeated Guard prompts

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getSteamSession() {
  if (steamSession && Date.now() < steamSession.expiresAt) return steamSession;

  return new Promise((resolve, reject) => {
    const client = new SteamUser();

    // Persist machine auth token in memory so Guard isn't re-prompted within the same process lifetime
    if (sentryToken) {
      client.on('machineAuthToken', token => { sentryToken = token; });
    }

    // Use sentry from previous successful login if available
    const logonOpts = {
      accountName: process.env.STEAM_USERNAME,
      password:    process.env.STEAM_PASSWORD,
    };
    if (sentryToken) logonOpts.machineAuthToken = sentryToken;

    client.logOn(logonOpts);

    // Handle Steam Guard — reads from STEAM_GUARD_CODE env var (set once on Render, then cleared)
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      const code = process.env.STEAM_GUARD_CODE || '';
      if (!code) {
        console.error('[RankedQueue] Steam Guard required but STEAM_GUARD_CODE env var is not set');
        client.logOff();
        reject(new Error('Steam Guard code required — set STEAM_GUARD_CODE env var on Render'));
        return;
      }
      console.log(`[RankedQueue] Providing Steam Guard code from env (domain=${domain || 'mobile'}, wrong=${lastCodeWrong})`);
      callback(code.trim());
    });

    // Save machine auth token so subsequent re-auths within this process don't need Guard
    client.on('machineAuthToken', token => {
      sentryToken = token;
      console.log('[RankedQueue] Machine auth token saved — Guard not needed until process restart');
    });

    client.on('loggedOn', async () => {
      try {
        const { encryptedAppTicket } = await client.createEncryptedAppTicket(APP_ID, Buffer.from('RLINK'));
        const auth  = encodeURIComponent(encryptedAppTicket.toString('base64'));
        const id64  = client.steamID.getSteamID64();

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

async function fetchPersonalStats(profileIds, cookies) {
  if (!profileIds.length) return { statMap: {}, profileMap: {} };
  const statMap = {}, profileMap = {};
  for (let i = 0; i < profileIds.length; i += 50) {
    const batch = profileIds.slice(i, i + 50);
    try {
      const r = await axios.get(
        `${BASE_URL}/community/leaderboard/getPersonalStat?title=age3&profile_ids=${JSON.stringify(batch)}`
      );
      (r.data?.statGroups ?? []).forEach(sg => sg.members?.forEach(m => { profileMap[m.profile_id] = { sgId: sg.id, alias: m.alias, country: m.country }; }));
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
  pollInProgress = true;

  try {
    const { sid, cookies } = await getSteamSession();
    const now = Date.now();

    // 1. Get current max lobby ID (unauthenticated community API – 1 req)
    const commR    = await axios.get(`${BASE_URL}/community/advertisement/findAdvertisements?title=age3`);
    const currentMax = Math.max(...(commR.data.matches || []).map(m => m.id), lastMaxId);

    // 2. Scan NEW IDs above our last known max (typically ~50-100 IDs per 30 s)
    const newStartId = Math.max(lastMaxId - 100, currentMax - SCAN_BACK);
    const newAds = [];
    for (let id = newStartId; id <= currentMax + 50; id += BATCH_SIZE) {
      const ids = Array.from({ length: BATCH_SIZE }, (_, i) => id + i);
      const results = await getAdvertisements(ids, sid, cookies);
      results.filter(m => m[8] === 'SESSION_MATCH_KEY' && m[24] === null).forEach(m => newAds.push(m));
      await delay(80);
    }

    // 3. Update known sessions + apply ghost-lobby cap
    newAds.forEach(m => {
      if (!knownSessions.has(m[0])) knownSessions.set(m[0], { firstSeen: now, data: m });
      else knownSessions.get(m[0]).data = m;
    });

    // Remove sessions not seen in this scan (matched or left)
    const seenIds = new Set(newAds.map(m => m[0]));
    // Keep sessions seen before if still within ghost cap
    const toRecheckIds = [];
    for (const [id, session] of knownSessions) {
      if (!seenIds.has(id)) {
        if (now - session.firstSeen < GHOST_CAP_MS) toRecheckIds.push(id);
        else knownSessions.delete(id);
      }
    }

    // 4. Recheck existing sessions that weren't in the new scan
    if (toRecheckIds.length > 0) {
      for (let i = 0; i < toRecheckIds.length; i += BATCH_SIZE) {
        const batch = toRecheckIds.slice(i, i + BATCH_SIZE);
        const results = await getAdvertisements(batch, sid, cookies);
        const stillActive = new Set(results.filter(m => m[8] === 'SESSION_MATCH_KEY' && m[24] === null).map(m => m[0]));
        batch.forEach(id => { if (!stillActive.has(id)) knownSessions.delete(id); });
        await delay(80);
      }
    }

    // Apply ghost cap
    for (const [id, session] of knownSessions) {
      if (now - session.firstSeen >= GHOST_CAP_MS) knownSessions.delete(id);
    }

    lastMaxId = currentMax;

    // 5. Collect active sessions → build parties
    const activeSessions = [...knownSessions.values()].map(s => s.data);
    const allProfileIds  = [...new Set(activeSessions.flatMap(m => (m[17] || []).map(p => p[1])))];

    // 6. Fetch fresh ELO (1-2 req for typical queue sizes)
    const { statMap, profileMap } = await fetchPersonalStats(allProfileIds, cookies);

    // 7. Assemble output
    const parties = activeSessions.map(m => {
      const players = (m[17] || []).map(p => {
        const pInfo  = profileMap[p[1]] || {};
        const sgId   = pInfo.sgId;
        const entries = statMap[sgId] ?? [];
        const pSize  = (m[17] || []).length;
        const elo    = relevantElo(entries, pSize);
        return {
          profileId:  p[1],
          alias:      pInfo.alias || null,
          country:    pInfo.country || null,
          elo,
          hasElo:     elo !== null,
          ping:       p[2],
        };
      });
      const elos    = players.map(p => p.elo).filter(e => e !== null);
      const teamElo = players.length > 1 && elos.length > 0 ? elos.reduce((a, b) => a + b, 0) : null;
      return {
        lobbyId:   m[0],
        partySize: players.length,
        region:    m[25],
        teamElo,
        players,
        firstSeen: knownSessions.get(m[0])?.firstSeen ?? now,
      };
    });

    // Sort by highest relevant ELO (team ELO for teams, solo ELO for 1v1)
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
  poll(); // immediate first run
  pollInterval = setInterval(poll, CACHE_TTL_MS);
  console.log('[RankedQueue] Service started (polling every 30s)');
}

function getQueue() {
  if (!cachedResult) return { timestamp: null, parties: [], status: 'initializing' };
  return { ...cachedResult, status: 'ok' };
}

module.exports = { start, getQueue };
