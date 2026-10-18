require("dotenv").config();

const express = require("express");
const path = require("path");
const BotService = require("./services/BotService");
const LogBuffer = require("./services/LogBuffer");
const RankedQueueService = require("./services/RankedQueueService");
const { app, server } = require("./app");
const { PORT, CLIENT_ID, CLIENT_SECRET } = require("./config");

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.exit(1);
}

const fetch = global.fetch;

if (!fetch) {
  process.exit(1);
}

// Route modules — loaded (and therefore registered) in the same order as before the split
require("./routes/auth");
require("./routes/diagnostics");
require("./game/routes");
require("./game/socket");
require("./routes/events");

if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../client/dist");
  app.use(express.static(frontendPath));

  app.get("/", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.redirect("https://discord-frontend-v2.vercel.app");
  });
}

require("./routes/monitor");
require("./routes/ranked");
require("./routes/coop");
require("./routes/obs");

// ─────────────────────────────────────────────────────────────────
// Start bot service
// ─────────────────────────────────────────────────────────────────

BotService.start().catch((err) =>
  LogBuffer.error("BotService", `Startup error: ${err.message}`)
);

RankedQueueService.start();

server.listen(PORT, () => {});
