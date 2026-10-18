const { app } = require("../app");
const RankedQueueService = require("../services/RankedQueueService");

// ─────────────────────────────────────────────────────────────────
// Ranked – queue & ongoing
// ─────────────────────────────────────────────────────────────────

// Ranked endpoints — registered both WITH and WITHOUT /api/ prefix
// because the Discord Activity proxy strips /api/ before hitting the server

const rankedQueueHandler = (_req, res) => res.json(RankedQueueService.getQueue());
app.get("/api/ranked/queue", rankedQueueHandler);
app.get("/ranked/queue",     rankedQueueHandler);

const steamGuardHandler = (req, res) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ success: false, error: 'Missing code' });
  }
  res.json(RankedQueueService.submitGuardCode(code));
};
app.post("/api/ranked/steam-guard", steamGuardHandler);
app.post("/ranked/steam-guard",     steamGuardHandler);

// GET /ranked/find-player?alias=NAME — look up a player's ELO by in-game name
const findPlayerHandler = async (req, res) => {
  const alias = (req.query.alias || '').trim();
  if (!alias) return res.status(400).json({ found: false, error: 'Missing alias' });
  try {
    // Step 1: find profile_id via freefoodparty leaderboard (same as events register)
    const lb = await fetch('https://api.freefoodparty.com/player/leaderboard?gameMode=2', { headers: { Accept: 'application/json' } });
    const leaderboard = await lb.json();
    const match = Array.isArray(leaderboard) && leaderboard.find(p => p.name?.toLowerCase() === alias.toLowerCase());
    if (!match) return res.json({ found: false });

    // Step 2: fetch ELO from Relic using the profile_id
    const profileId = match.idPlayer;
    const axios = require('axios');
    const r = await axios.get(`https://aoe-api.worldsedgelink.com/community/leaderboard/getPersonalStat?title=age3&profile_ids=[${profileId}]`);
    const stats = r.data?.leaderboardStats ?? [];
    const groups = r.data?.statGroups ?? [];
    const sgId = groups[0]?.id;
    const lb1 = stats.find(s => s.statgroup_id === sgId && s.leaderboard_id === 1);
    const lb2 = stats.find(s => s.statgroup_id === sgId && s.leaderboard_id === 2);
    res.json({ found: true, alias: match.name, profileId, soloElo: lb1?.rating ?? null, teamElo: lb2?.rating ?? null });
  } catch (e) {
    res.status(502).json({ found: false, error: e.message });
  }
};
app.get('/api/ranked/find-player', findPlayerHandler);
app.get('/ranked/find-player',     findPlayerHandler);

const ongoingHandler = async (_req, res) => {
  try {
    const axios = require("axios");
    const r = await axios.get("https://api.freefoodparty.com/observablelist_all", { timeout: 8000 });
    const all = r.data?.observableMatchInfo ?? [];
    const automatch = all
      .filter(m => m.gameName === "AUTOMATCH")
      .map(m => {
        const players = (m.obeservableMatchPlayerInfo ?? []).map(p => ({
          profileId: p.idPlayer,
          name:      p.name,
          elo:       p.elo >= 0 ? p.elo : null,
          civ:       p.idCiv,
          team:      p.team,
        }));
        const elos = players.map(p => p.elo).filter(e => e !== null);
        const avgElo = elos.length ? Math.round(elos.reduce((a, b) => a + b, 0) / elos.length) : 0;
        return {
          matchId:    m.idGame,
          region:     m.region,
          playerCount: m.playerCount,
          startDate:  m.startDate,
          spectators: m.spectators ?? 0,
          avgElo,
          players,
        };
      })
      .sort((a, b) => b.avgElo - a.avgElo);
    res.json({ success: true, matches: automatch, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ success: false, error: e.message });
  }
};
app.get("/api/ranked/ongoing", ongoingHandler);
app.get("/ranked/ongoing",     ongoingHandler);
