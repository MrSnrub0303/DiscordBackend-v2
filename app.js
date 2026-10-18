// Express app, HTTP server and Socket.IO instance shared by all route modules
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public')));
app.use(
  cors({
    origin: [
      "http://127.0.0.1",
      "http://localhost:5173",
      "https://1438780052144783371.discordsays.com",
      "https://discord-frontend-v2.vercel.app",
      "https://discordbackend-v2.onrender.com",
    ],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Discord-Username"],
  }),
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://127.0.0.1",
      "http://localhost:5173",
  "https://1438780052144783371.discordsays.com",
      "https://discord-frontend-virid.vercel.app",
      "https://discordbackend-v2.onrender.com",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

module.exports = { app, server, io };
