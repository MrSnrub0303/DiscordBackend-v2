const { app } = require("../app");
const { analytics, rooms } = require("../game/state");

app.get("/api/health", async (req, res) => {
  let publicIp = null;
  try {
    const ipResp = await fetch("https://api.ipify.org?format=json");
    publicIp = (await ipResp.json()).ip;
  } catch {}
  res.json({
    status: "healthy",
    server: "quiz-backend",
    timestamp: new Date().toISOString(),
    publicIp,
  });
});

app.get("/api/test-discord", async (req, res) => {
  try {
    console.log('[Test] Testing Discord API connectivity...');
    
    const testResp = await fetch("https://discord.com/api/v10/gateway", {
      method: "GET",
      headers: { "User-Agent": "DiscordBot (https://github.com/discord/discord-api-docs, 1.0)" }
    });
    
    console.log('[Test] Discord API status:', testResp.status);
    console.log('[Test] Content-Type:', testResp.headers.get('content-type'));
    
    const text = await testResp.text();
    console.log('[Test] Response preview:', text.substring(0, 200));
    
    const isBlocked = testResp.status === 429 || !testResp.headers.get('content-type')?.includes('application/json');

    // Capture all headers for diagnosis
    const headers = {};
    testResp.headers.forEach((value, key) => { headers[key] = value; });

    const retryAfter = testResp.headers.get('retry-after');
    const retryAfterSeconds = retryAfter ? parseFloat(retryAfter) : null;

    res.json({
      success: !isBlocked,
      blocked: isBlocked,
      status: testResp.status,
      contentType: testResp.headers.get('content-type'),
      retryAfter: retryAfterSeconds,
      retryAfterHuman: retryAfterSeconds ? `${Math.ceil(retryAfterSeconds / 60)} minutes` : null,
      headers,
      preview: isBlocked ? text.substring(0, 200) : undefined,
      canReachDiscord: !isBlocked,
      message: isBlocked
        ? 'Discord API is rate-limiting this server\'s IP. Try again later.'
        : 'Discord API is reachable.',
    });
  } catch (err) {
    console.error('[Test] Failed:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      canReachDiscord: false
    });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    server: "quiz-backend",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/me", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "missing auth" });
  const token = auth.replace(/^Bearer\s+/i, "");
  try {
    const resp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return res.status(401).json({ error: "invalid token" });
    const user = await resp.json();
    res.json(user);
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/analytics", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "missing auth" });
  const token = auth.replace(/^Bearer\s+/i, "");

  try {
    const resp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return res.status(401).json({ error: "invalid token" });
    const user = await resp.json();

    const isAdmin = process.env.ADMIN_USER_IDS?.split(",").includes(user.id);
    if (!isAdmin) {
      return res.status(403).json({ error: "unauthorized" });
    }

    res.json({
      totalGamesPlayed: analytics.totalGamesPlayed,
      totalQuestionsAnswered: analytics.totalQuestionsAnswered,
      activeChannels: analytics.activeChannels.size,
      dailyStats: {
        date: analytics.dailyStats.date,
        gamesPlayed: analytics.dailyStats.gamesPlayed,
        questionsAnswered: analytics.dailyStats.questionsAnswered,
        uniquePlayers: analytics.dailyStats.uniquePlayers.size,
      },
      currentSessions: Object.keys(rooms).length,
    });
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/discord-test", (req, res) => {
  res.json({
    message: "Discord URL mapping is working!",
    timestamp: Date.now(),
    headers: req.headers,
  });
});
