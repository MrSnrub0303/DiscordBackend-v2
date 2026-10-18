const fs = require("fs").promises;
const path = require("path");
const { app } = require("../app");
const ROOT_DIR = path.join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────
// Events Leaderboard
// ─────────────────────────────────────────────────────────────────

const EVENTS_DATA_PATH = path.join(ROOT_DIR, "events_leaderboard.json");
const AOE3_API_BASE = "https://api.aoe3explorer.com";

async function loadEventsData() {
  try {
    const raw = await fs.readFile(EVENTS_DATA_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return { players: [] };
  }
}

async function saveEventsData(data) {
  await fs.writeFile(EVENTS_DATA_PATH, JSON.stringify(data, null, 2), "utf-8");
}

// ── Archived: GGplz Challenge – 3v3 Ranked Grind (Apr 1–10 2026) ──────────────
// Metric: total qualifying wins (3v3 ranked wins with elo gain >= 5 in window)
// const TOURNAMENT_START = new Date(1775174400 * 1000); // 2026-04-01 00:00 UTC
// const TOURNAMENT_END   = new Date(1775952000 * 1000); // 2026-04-10 00:00 UTC
// ─────────────────────────────────────────────────────────────────────────────

// GGplz Challenge – Spring Rabbit Hunt (Apr 14 2026 → May 1 2026 10:00 PM PST)
// End time note: "10:00 PM PST" = UTC-8 → May 2 2026 06:00 UTC.
// (If PDT/UTC-7 was intended, change end timestamp to 1777697400.)
const TOURNAMENT_START = new Date(1776124800 * 1000); // 2026-04-14 00:00 UTC
const TOURNAMENT_END   = new Date(1777701600 * 1000); // 2026-05-02 06:00 UTC (May 1 10 PM PST)

async function fetchPlayerWins(playerId) {
  // Returns the highest win streak the player achieved during the tournament window.
  //
  // Streak rules (3v3 ranked only):
  //   Valid win (elo gain >= 5) → +1 streak
  //   Win with elo gain  < 5   → ignored (streak unchanged)
  //   Loss                     → streak reset to 0
  //
  // Games are fetched newest-first, collected for the window, then processed
  // oldest-first so streak progression is chronologically correct.
  const pid = String(playerId);
  const size = 50;
  let page = 0;
  const windowGames = [];

  while (true) {
    const url =
      `https://api.freefoodparty.com/games` +
      `?playerId=${playerId}&gameMode=2&page=${page}&size=${size}`;

    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`Match history fetch failed (${resp.status})`);
    const body = await resp.json();

    const games = body.content || [];
    if (games.length === 0) break;

    let passedWindowStart = false;

    for (const game of games) {
      const startDate = new Date(game.startDate);

      // Games are sorted newest-first; stop once we go past the window start
      if (startDate < TOURNAMENT_START) {
        passedWindowStart = true;
        break;
      }

      // Skip games that haven't started yet / are after the window end
      if (startDate >= TOURNAMENT_END) continue;

      // Must be ranked and exactly 6 players (true 3v3)
      if (!game.isRanked || game.playerCount !== 6) continue;

      // Find this player's entry
      const entry = (game.matchPlayerInfo || []).find(
        (p) => String(p.idPlayer) === pid
      );
      if (!entry) continue;

      windowGames.push({ startDate, entry });
    }

    if (passedWindowStart || games.length < size) break;
    page++;
  }

  // Sort oldest-first so we process streak chronologically
  windowGames.sort((a, b) => a.startDate - b.startDate);

  let currentStreak = 0;
  let bestStreak = 0;

  for (const { entry } of windowGames) {
    if (entry.result === 1) {
      // Win — check elo gain
      const eloGain = (entry.eloAfter || 0) - (entry.eloBefore || 0);
      if (eloGain >= 5) {
        // Qualifying win: extend the streak
        currentStreak++;
        if (currentStreak > bestStreak) bestStreak = currentStreak;
      }
      // Sub +5 elo win: ignored — no change to streak
    } else {
      // Loss: reset streak
      currentStreak = 0;
    }
  }

  return bestStreak;
}

// GET /events/leaderboard
app.get("/events/leaderboard", async (req, res) => {
  try {
    const data = await loadEventsData();
    const sorted = [...data.players].sort((a, b) => b.wins - a.wins);
    res.json({ success: true, players: sorted });
  } catch (err) {
    console.error("[Events] Leaderboard error:", err);
    res.status(500).json({ success: false, error: "Failed to load leaderboard" });
  }
});

// POST /events/register  { username: "STONED_TARXAN" }
// Server looks up the player, fetches wins, and stores the result.
app.post("/events/register", async (req, res) => {
  const { username } = req.body || {};
  if (!username || !username.trim()) {
    return res.status(400).json({ success: false, error: "Username is required" });
  }

  const name = username.trim();

  try {
    // Look up player by name via freefoodparty leaderboard
    const lookupResp = await fetch(
      "https://api.freefoodparty.com/player/leaderboard?gameMode=2",
      { headers: { Accept: "application/json" } }
    );
    if (!lookupResp.ok) throw new Error(`Player lookup failed (${lookupResp.status})`);
    const leaderboard = await lookupResp.json();

    if (!Array.isArray(leaderboard)) {
      throw new Error("Unexpected leaderboard response format");
    }

    const match = leaderboard.find(
      (p) => p.name && p.name.toLowerCase() === name.toLowerCase()
    );

    if (!match) {
      return res.status(404).json({ success: false, error: `Player "${name}" not found` });
    }

    const playerId = match.idPlayer;
    const playerName = match.name;

    if (!playerId) {
      return res.status(404).json({ success: false, error: "Could not determine player ID" });
    }

    // Calculate qualifying wins via freefoodparty
    const wins = await fetchPlayerWins(playerId);

    // Upsert into persistent storage
    const data = await loadEventsData();
    const existing = data.players.findIndex(
      (p) => String(p.playerId) === String(playerId)
    );
    const entry = { playerId: String(playerId), name: playerName, wins };

    if (existing >= 0) {
      data.players[existing] = entry;
    } else {
      data.players.push(entry);
    }
    await saveEventsData(data);

    res.json({ success: true, player: entry });
  } catch (err) {
    console.error("[Events] Register error:", err);
    res.status(500).json({ success: false, error: err.message || "Registration failed" });
  }
});

// POST /events/refresh  { playerId: "15762644" } — re-fetches wins for one player
app.post("/events/refresh", async (req, res) => {
  const { playerId } = req.body || {};
  if (!playerId) {
    return res.status(400).json({ success: false, error: "playerId is required" });
  }

  try {
    const data = await loadEventsData();
    const idx = data.players.findIndex((p) => String(p.playerId) === String(playerId));
    if (idx < 0) {
      return res.status(404).json({ success: false, error: "Player not registered" });
    }

    const wins = await fetchPlayerWins(playerId);
    data.players[idx].wins = wins;
    await saveEventsData(data);

    res.json({ success: true, player: data.players[idx] });
  } catch (err) {
    console.error("[Events] Refresh error:", err);
    res.status(500).json({ success: false, error: err.message || "Refresh failed" });
  }
});

// POST /events/refresh-all — re-fetches wins for all registered players atomically
app.post("/events/refresh-all", async (req, res) => {
  try {
    const data = await loadEventsData();
    if (!data.players.length) {
      return res.json({ success: true, players: [] });
    }

    const updatedPlayers = await Promise.all(
      data.players.map(async (player) => {
        const wins = await fetchPlayerWins(player.playerId);
        return { ...player, wins };
      })
    );

    data.players = updatedPlayers;
    await saveEventsData(data);

    res.json({ success: true, players: updatedPlayers });
  } catch (err) {
    console.error("[Events] Refresh-all error:", err);
    res.status(500).json({ success: false, error: err.message || "Refresh failed" });
  }
});
