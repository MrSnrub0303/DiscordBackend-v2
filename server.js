require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const questions = require("./questions.json");
const cors = require("cors");
const StorageService = require("./services/StorageService");

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: [
      "http://127.0.0.1",
      "http://localhost:5173",
  "https://1438780052144783371.discordsays.com",
      "https://discord-frontend-virid.vercel.app",
      "https://discordbackend-xggi.onrender.com",
    ],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const MAX_TIME = 20;

const MAX_POINTS = 150;
const SCORING_EXPONENT = 2;

// Prevent duplicate Discord code exchanges (single-flight) to avoid 429s from double submission
const CODE_CACHE_TTL_MS = 30 * 1000;
const codeExchangeCache = new Map();

const cleanCodeExchangeCache = () => {
  const now = Date.now();
  for (const [code, entry] of codeExchangeCache.entries()) {
    if (now - entry.timestamp > CODE_CACHE_TTL_MS) {
      codeExchangeCache.delete(code);
    }
  }
};

setInterval(cleanCodeExchangeCache, CODE_CACHE_TTL_MS);

const ROOM_CLEANUP_INTERVAL = 1000 * 60 * 5;
const ROOM_INACTIVE_THRESHOLD = 1000 * 60 * 15;
const GRACE_PERIOD_MAX = 1000 * 10;

const LEADERBOARD_RESET_HOUR = 0;
const LEADERBOARD_RESET_MINUTE = 0;

const analytics = {
  totalGamesPlayed: 0,
  totalQuestionsAnswered: 0,
  activeChannels: new Set(),
  dailyStats: {
    date: new Date().toISOString().split("T")[0],
    gamesPlayed: 0,
    questionsAnswered: 0,
    uniquePlayers: new Set(),
  },
};

const HOST_INACTIVE_TIMEOUT = 1000 * 60 * 2; // 2 minutes
const PLAYER_SESSION_TIMEOUT = 1000 * 60 * 1; // 1 minute - after this, player's score resets on rejoin

const rooms = {};

// Track when players were last seen in each room (for session timeout)
// Structure: { roomId: { playerId: timestamp } }
const playerLastSeen = {};

const buildInitialRoomState = () => ({
  players: {},
  currentQuestion: null,
  selections: {},
  currentSelections: {},
  lastSelections: {},
  hostSocketId: null,
  timer: null,
  gameState: "waiting",
  startTime: new Date(),
  lastActive: new Date(),
  scores: {},
  playerNames: {},
  questionHistory: [],
  questionStartTime: null,
  resultShowStartTime: null,
  lastCorrectAnswer: null,
  roundEnded: false,
  generatingQuestion: false,
  lastQuestionGenerated: null,
  hostPlayerId: null,
  hostLastActiveAt: null,
});

function ensureRoom(roomId) {
  if (!roomId) {
    return null;
  }

  if (!rooms[roomId]) {
    rooms[roomId] = buildInitialRoomState();
  } else if (!Object.prototype.hasOwnProperty.call(rooms[roomId], "hostPlayerId")) {
    rooms[roomId].hostPlayerId = null;
    rooms[roomId].hostLastActiveAt = null;
  }

  // Initialize player tracking for this room
  if (!playerLastSeen[roomId]) {
    playerLastSeen[roomId] = {};
  }

  return rooms[roomId];
}

// Update player's last seen timestamp
function updatePlayerLastSeen(roomId, playerId) {
  if (!roomId || !playerId) return;
  if (!playerLastSeen[roomId]) {
    playerLastSeen[roomId] = {};
  }
  playerLastSeen[roomId][playerId] = Date.now();
}

// Check if player has been away too long and should have score reset
function checkPlayerSessionTimeout(roomId, playerId) {
  if (!roomId || !playerId) return { timedOut: false };
  
  const lastSeen = playerLastSeen[roomId]?.[playerId];
  if (!lastSeen) {
    // First time joining - no timeout
    return { timedOut: false, isNewPlayer: true };
  }
  
  const timeSinceLastSeen = Date.now() - lastSeen;
  const timedOut = timeSinceLastSeen > PLAYER_SESSION_TIMEOUT;
  
  return { 
    timedOut, 
    timeSinceLastSeen,
    isNewPlayer: false 
  };
}

function assertHostControl(room, playerId, options = {}) {
  const { allowClaim = false, allowTakeover = false } = options;

  if (!playerId) {
    return {
      ok: false,
      status: 400,
      error: "Missing playerId",
    };
  }

  if (!room.hostPlayerId) {
    if (allowClaim) {
      room.hostPlayerId = playerId;
      room.hostLastActiveAt = Date.now();
      return { ok: true, claimed: true };
    }

    return {
      ok: false,
      status: 409,
      error: "Host has not been assigned yet",
    };
  }

  if (room.hostPlayerId === playerId) {
    room.hostLastActiveAt = Date.now();
    return { ok: true };
  }

  if (
    allowTakeover &&
    room.hostLastActiveAt &&
    Date.now() - room.hostLastActiveAt > HOST_INACTIVE_TIMEOUT
  ) {
    room.hostPlayerId = playerId;
    room.hostLastActiveAt = Date.now();
    return { ok: true, reassigned: true };
  }

  return {
    ok: false,
    status: 403,
    error: "Only the host can perform this action",
  };
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.exit(1);
}

const fetch = global.fetch;

if (!fetch) {
  process.exit(1);
}

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

  try {
    console.log(`[Token ${label}] Starting token exchange...`);
    console.log(`[Token ${label}] Code length:`, code?.length);

    if (!CLIENT_ID || !CLIENT_SECRET) {
      console.error(`[Token ${label}] Missing credentials`);
      finalizeCodeExchange(code, 'done');
      return res.status(500).json({ error: "Server configuration error" });
    }

    console.log(`[Token ${label}] Making request to Discord API...`);

    const resp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    console.log(`[Token ${label}] Response status:`, resp.status);
    console.log(`[Token ${label}] Response content-type:`, resp.headers.get('content-type'));

    const contentType = resp.headers.get('content-type');

    if (!contentType || !contentType.includes('application/json')) {
      const textResponse = await resp.text();
      console.error(`[Token ${label}] Non-JSON response:`, textResponse.substring(0, 200));
      finalizeCodeExchange(code, 'done');
      return res.status(502).json({ 
        error: "Invalid response from Discord API",
        details: "Expected JSON but received HTML. Network or proxy issue.",
        status: resp.status,
        bodyPreview: textResponse.substring(0, 200),
      });
    }

    const json = await resp.json();

    if (!resp.ok) {
      console.error(`[Token ${label}] Discord API error:`, json);
      finalizeCodeExchange(code, 'done');
      return res.status(resp.status).json(json);
    }

    console.log(`[Token ${label}] Success`);
    finalizeCodeExchange(code, 'done');
    return res.json(json);
  } catch (err) {
    console.error(`[Token ${label}] Exception:`, err.message);
    console.error(`[Token ${label}] Stack:`, err.stack);
    releaseCodeExchange(code); // allow retry on transient failure
    return res.status(500).json({ 
      error: "Internal server error", 
      details: err.message,
      type: err.name 
    });
  }
}

app.post("/api/token", async (req, res) => exchangeDiscordCode(req, res, 'API'));

app.post("/token", async (req, res) => exchangeDiscordCode(req, res, '/token'));

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    server: "quiz-backend",
    timestamp: new Date().toISOString(),
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
    
    res.json({
      success: true,
      status: testResp.status,
      contentType: testResp.headers.get('content-type'),
      preview: text.substring(0, 200),
      canReachDiscord: testResp.status === 200
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

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: Date.now(),
    message: "Server is running",
    environment: "production",
  });
});

app.get("/api/discord-test", (req, res) => {
  res.json({
    message: "Discord URL mapping is working!",
    timestamp: Date.now(),
    headers: req.headers,
  });
});

app.post("/api/game-event", (req, res) => {
  const { event, data } = req.body;

  try {
    if (data.roomId && !rooms[data.roomId]) {
      rooms[data.roomId] = buildInitialRoomState();
    }

    switch (event) {
      case "start_question":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          // Reset scores if requested (fresh game session)
          if (data.resetScores) {
            console.log(`[/api/game-event start_question] Resetting scores for room ${data.roomId}`);
            room.scores = {};
            Object.keys(room.players || {}).forEach((playerId) => {
              if (room.players[playerId]) {
                room.players[playerId].score = 0;
              }
            });
            
            // If resetScores is true and round has ended or question is stale, clear it
            // This ensures clicking "Start" with reset doesn't resume an old finished round
            if (room.roundEnded || (room.questionStartTime && Date.now() - room.questionStartTime > (MAX_TIME + 30) * 1000)) {
              console.log(`[/api/game-event start_question] Clearing stale question for fresh start`);
              room.currentQuestion = null;
              room.roundEnded = false;
              room.currentSelections = {};
              room.lastSelections = {};
              room.questionStartTime = null;
            }
          }

          if (!data.forceNew && room.currentQuestion) {
            const now = Date.now();
            const questionStartTime = room.questionStartTime || now;
            const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
            const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

            res.json({
              success: true,
              question: room.currentQuestion,
              timeLeft: remainingTime,
              startTime: questionStartTime,
              showResult: room.roundEnded || remainingTime <= 0,
              selections: room.currentSelections || {},
              roundEnded: !!room.roundEnded,
            });
            return;
          }

          if (data.forceNew) {
          }

          if (room.generatingQuestion) {
            setTimeout(() => {
              if (room.currentQuestion) {
                const now = Date.now();
                const questionStartTime = room.questionStartTime || now;
                const elapsedSeconds = Math.floor(
                  (now - questionStartTime) / 1000,
                );
                const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

                res.json({
                  success: true,
                  question: room.currentQuestion,
                  timeLeft: remainingTime,
                  startTime: questionStartTime,
                  selections: room.currentSelections || {},
                  roundEnded: !!room.roundEnded,
                });
              } else {
                res.json({
                  success: false,
                  error: "Failed to generate question",
                });
              }
            }, 100);
            return;
          }

          room.generatingQuestion = true;

          // NOTE: forceNew only forces a new question, it does NOT reset scores
          // Score reset should only happen via explicit "reset_scores" event

          const randomQuestionForSocket = getRandomQuestion();
          const questionStartTime = Date.now();

          room.currentQuestion = randomQuestionForSocket;
          room.questionStartTime = questionStartTime;
          room.lastActive = new Date();
          room.gameState = "playing";
          room.roundEnded = false;
          room.currentSelections = {};
          room.lastSelections = {};
          room.lastCorrectAnswer = null;
          room.resultShowStartTime = null;
          room.generatingQuestion = false;

          res.json({
            success: true,
            question: randomQuestionForSocket,
            timeLeft: MAX_TIME,
            startTime: questionStartTime,
            selections: room.currentSelections || {},
            roundEnded: !!room.roundEnded,
          });
          return;
        }
        break;

      case "select_option":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];
          
          // Update player's last seen timestamp
          updatePlayerLastSeen(data.roomId, data.playerId);

          if (!room.currentSelections) {
            room.currentSelections = {};
          }

          // Ensure player exists in scores even if not connected via socket (proxy mode)
          if (!room.scores) room.scores = {};
          if (room.scores[data.playerId] === undefined) {
            room.scores[data.playerId] = 0;
          }

          // Ensure player exists in players map for proxy mode
          if (!room.players[data.playerId]) {
            room.players[data.playerId] = {
              id: data.playerId,
              name: data.playerName || "Player",
              score: room.scores[data.playerId] || 0,
            };
          }

          const previousSelection = room.currentSelections[data.playerId];
          const isChange =
            previousSelection &&
            ((data.optionIndex !== undefined &&
              previousSelection.optionIndex !== data.optionIndex) ||
              (data.cardAnswer !== undefined &&
                previousSelection.cardAnswer !== data.cardAnswer));

          const selection = {
            timeTaken: data.timeTaken,
            timestamp: Date.now(),
          };

          if (data.cardAnswer !== undefined) {
            selection.cardAnswer = data.cardAnswer;
            selection.isCorrect = data.isCorrect;
          } else {
            selection.optionIndex = data.optionIndex;
          }

          // Check if this is a NEW correct answer (not already scored)
          const previouslyScored = room.currentSelections[data.playerId]?.scored;
          
          room.currentSelections[data.playerId] = selection;
          console.log(`[select_option REST] Stored selection for player ${data.playerId}:`, JSON.stringify(selection));
          console.log(`[select_option REST] All currentSelections:`, JSON.stringify(room.currentSelections));

          // IMMEDIATE SCORE COMPUTATION for correct answers (proxy mode real-time sync)
          console.log(`[select_option REST] Score computation check: previouslyScored=${previouslyScored}, hasQuestion=${!!room.currentQuestion}, cardAnswer=${data.cardAnswer}, optionIndex=${data.optionIndex}, isCorrect=${data.isCorrect}`);
          
          if (!previouslyScored && room.currentQuestion) {
            let isCorrect = false;
            
            if (data.cardAnswer !== undefined) {
              // Card mode: isCorrect is sent by client
              isCorrect = data.isCorrect === true;
              console.log(`[select_option REST] Card mode: data.isCorrect=${data.isCorrect}, computed isCorrect=${isCorrect}`);
            } else if (data.optionIndex !== undefined) {
              // Trivia mode: check against correctIndex
              isCorrect = data.optionIndex === room.currentQuestion.correctIndex;
              console.log(`[select_option REST] Trivia mode: optionIndex=${data.optionIndex}, correctIndex=${room.currentQuestion.correctIndex}, isCorrect=${isCorrect}`);
            }
            
            if (isCorrect) {
              const points = calculatePointsFromTime(data.timeTaken ?? MAX_TIME);
              const oldScore = room.scores[data.playerId] || 0;
              room.scores[data.playerId] = oldScore + points;
              room.currentSelections[data.playerId].scored = true; // Mark as scored to prevent double-scoring
              
              // Update player object if exists
              if (room.players[data.playerId]) {
                room.players[data.playerId].score = room.scores[data.playerId];
              }
              
              console.log(`[select_option REST] Awarded ${points} points to player ${data.playerId}. Old: ${oldScore}, New: ${room.scores[data.playerId]}`);
              console.log(`[select_option REST] Current room.scores:`, JSON.stringify(room.scores));
            } else {
              console.log(`[select_option REST] Answer was incorrect, no points awarded`);
            }
          } else {
            console.log(`[select_option REST] Skipped scoring: previouslyScored=${previouslyScored}, hasQuestion=${!!room.currentQuestion}`);
          }

          if (room.roundEnded && room.lastSelections) {
            if (data.optionIndex !== undefined) {
              room.lastSelections[data.playerId] = data.optionIndex;
            } else if (data.isCorrect !== undefined) {
              room.lastSelections[data.playerId] = data.isCorrect
                ? "correct"
                : "incorrect";
            }
          }

          if (data.playerName) {
            room.playerNames[data.playerId] = data.playerName;
          } else {
          }

          room.lastActive = new Date();

          // Broadcast to all clients in the room so they can see who answered
          if (io) {
            console.log(`[player_selected] Broadcasting to room ${data.roomId}:`, {
              playerId: data.playerId,
              optionIndex: data.optionIndex,
              playerName: data.playerName || room.playerNames[data.playerId] || "Player",
              socketsInRoom: io.sockets.adapter.rooms.get(data.roomId)?.size || 0,
            });
            io.to(data.roomId).emit("player_selected", {
              playerId: data.playerId,
              optionIndex: data.optionIndex,
              playerName: data.playerName || room.playerNames[data.playerId] || "Player",
              isCorrect: data.isCorrect,
            });
          }

          res.json({
            success: true,
            message: isChange ? "Selection changed" : "Selection recorded",
            _debug: {
              serverVersion: "v4-score-debug",
              roomScores: room.scores || {},
              playerScore: room.scores?.[data.playerId] || 0,
              hasCurrentQuestion: !!room.currentQuestion,
            }
          });
          return;
        }
        break;

      case "end_round":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          if (room.roundEnded) {
            res.json({
              success: true,
              action: "round_complete",
              data: {
                selections: room.lastSelections || {},
                scores: room.scores || {},
                playerNames: room.playerNames || {},
                correctAnswer: room.lastCorrectAnswer,
              },
            });
            return;
          }

          room.roundEnded = true;

          const roundSelections = room.currentSelections || {};
          const currentQuestion = room.currentQuestion;

          if (currentQuestion) {
            if (currentQuestion.isCard) {
            } else {
            }

            Object.entries(roundSelections).forEach(([playerId, selection]) => {
              if (!room.scores) room.scores = {};
              if (!room.scores[playerId]) room.scores[playerId] = 0;

              let isCorrect = false;

              if (currentQuestion.isCard) {
                isCorrect = selection.isCorrect === true;
              } else {
                const correctIndex = currentQuestion.options?.findIndex((opt) =>
                  opt.startsWith(currentQuestion.answer),
                );
                isCorrect = selection.optionIndex === correctIndex;
              }

              if (isCorrect) {
                const points = calculatePointsFromTime(selection.timeTaken);
                room.scores[playerId] += points;
              } else {
              }
            });

            StorageService.saveCurrentScores(data.roomId, room.scores);
          } else {
          }

          const clientSelections = {};
          Object.entries(roundSelections).forEach(([playerId, selection]) => {
            if (selection.optionIndex !== undefined) {
              clientSelections[playerId] = selection.optionIndex;
            } else {
              clientSelections[playerId] = selection.isCorrect
                ? "correct"
                : "incorrect";
            }
          });

          const correctAnswer = currentQuestion?.isCard
            ? currentQuestion.cardName
            : currentQuestion?.answer;
          room.lastSelections = clientSelections;
          room.lastCorrectAnswer = correctAnswer;

          const responseData = {
            success: true,
            action: "round_complete",
            data: {
              selections: clientSelections,
              scores: room.scores || {},
              playerNames: room.playerNames || {},
              correctAnswer: correctAnswer,
            },
          };

          res.json(responseData);

          // Broadcast scores and selections to all socket clients in the room
          if (io) {
            io.to(data.roomId).emit("round_complete", responseData.data);
          }

          room.currentSelections = {};

          room.roundEnded = true;

          return;
        }
        break;

      case "reset_scores":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          room.scores = {};
          Object.keys(room.players || {}).forEach((playerId) => {
            if (room.players[playerId]) {
              room.players[playerId].score = 0;
            }
          });

          if (
            StorageService &&
            typeof StorageService.clearCurrentScores === "function"
          ) {
            StorageService.clearCurrentScores(data.roomId);
          }

          if (io) {
            io.to(data.roomId).emit("scores_reset", {
              scores: {},
              timestamp: new Date().toISOString(),
            });
          }

          res.json({ success: true, scores: {} });
          return;
        }
        break;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to process game event" });
  }
});

function calculatePointsFromTime(timeTaken) {
  if (!timeTaken || timeTaken <= 0) {
    return 0;
  }

  const timeLeft = Math.max(0, MAX_TIME - timeTaken);

  const x = Math.max(0, Math.min(1, timeLeft / MAX_TIME));

  const raw = MAX_POINTS * Math.pow(x, SCORING_EXPONENT);

  const points = Math.round(raw);

  return points;
}

const cardNames = [
  "Conquistador",
  "Team Fencing Instructor",
  "Unction",
  "Team Spanish Road",
  "Team Hidalgos",
  "Native Lore",
  "Advanced Trading Post",
  "Town Militia",
  "Pioneers",
  "Advanced Mill",
  "Advanced Market",
  "Advanced Estate",
  "Advanced Dock",
  "Llama Ranching",
  "Ranching",
  "Fish Market",
  "Schooners",
  "Sawmills",
  "Exotic Hardwoods",
  "Team Ironmonger",
  "Stockyards",
  "Furrier",
  "Rum Distillery",
  "Capitalism",
  "Stonemasons",
  "Land Grab",
  "Team Coastal Defenses",
  "Tercio Tactics",
  "Reconquista",
  "Advanced Arsenal",
  "Extensive Fortifications",
  "Rendering Plant",
  "Silversmith",
  "Sustainable Agriculture",
  "Spice Trade",
  "Medicine",
  "Cigar Roller",
  "Spanish Galleons",
  "Theaters",
  "Caballeros",
  "Liberation March",
  "Spanish Gold",
  "Armada",
  "Mercenary Loyalty",
  "Grenade Launchers",
  "Improved Buildings",
  "Blood Brothers",
  "Peninsular Guerrillas",
  "Advanced Balloon",
  "Florence Nightingale",
  "Virginia Company",
  "South Sea Bubble",
  "Fulling Mills",
  "Yeomen",
  "Siege Archery",
  "Master Surgeons",
  "Northwest Passage",
  "Distributivism",
  "Wilderness Warfare",
  "French Royal Army",
  "Naval Gunners",
  "Thoroughbreds",
  "Gribeauval System",
  "Navigator",
  "Agents",
  "Portuguese White Fleet",
  "Carracks",
  "Stadhouder",
  "Admiral Tromp",
  "Tulip Speculation",
  "Willem",
  "Polar Explorer",
  "Engineering School",
  "Suvorov Reforms",
  "Ransack",
  "Polk",
  "Offshore Support",
  "Germantown Farmers",
  "Guild Artisans",
  "Spanish Riding School",
  "Mosque Construction",
  "Flight Archery",
  "New Ways",
  "Beaver Wars",
  "Medicine Wheels",
  "Black Arrow",
  "Silent Strike",
  "Smoking Mirror",
  "Boxer Rebellion",
  "Western Reforms",
  "Advanced Wonders",
  "Seven Lucky Gods",
  "Desert Terror",
  "Foreign Logging",
  "Salt Ponds",
  "Imperial Unity",
  "Duelist",
  "Trample Tactics",
  "Virginia Oak",
  "Coffee Mill Guns",
  "Bushburning",
  "Beekeepers",
  "Koose",
  "Kingslayer",
  "Barbacoa",
  "Man of Destiny",
  "Freemasons",
  "Admirality",
  "Advanced Commanderies",
  "Bailiff",
  "Fire Towers",
  "Native Treaties",
  "Advanced Scouts",
  "Grain Market",
  "Chinampa",
  "Knight Hitpoints",
  "Knight Attack",
  "Aztec Mining",
  "Ritual Gladiators",
  "Artificial Islands",
  "Knight Combat",
  "Scorched Earth",
  "Aztec Fortification",
  "Chichimeca Rebellion",
  "Wall of Skulls",
  "Old Ways",
  "Improved Warships",
  "Terraced Houses",
  "Rangers",
  "Textile Mill",
  "Refrigeration",
  "Royal Mint",
  "Greenwich Time",
  "Dowager Empress",
  "Year of the Goat",
  "Year of the Tiger",
  "Year of the Ox",
  "Year of the Dragon",
  "Acupuncture",
  "Repelling Volley",
  "Native Crafts",
  "Colbertism",
  "Cartridge Currency",
  "European Cannons",
  "Voyageur",
  "Solingen Steel",
  "Town Destroyer",
  "Battlefield Construction",
  "Conservative Tactics",
  "Dane Guns",
];

const getCardImagePath = (cardName) => {
  const fileName = cardName.replace(/\s+/g, "_").replace(/[:/]/g, "");

  return `cards/${fileName}.png`;
};

function getRandomQuestion() {
  const pickCard = Math.random() < 0.45 && cardNames.length > 0;

  if (pickCard) {
    const idx = Math.floor(Math.random() * cardNames.length);
    const name = cardNames[idx];
    const url = getCardImagePath(name);

    return {
      isCard: true,
      cardName: name,
      cardUrl: url,
      id: `card_${idx}_${Date.now()}`,
    };
  }

  const randomIndex = Math.floor(Math.random() * questions.length);
  const question = questions[randomIndex];

  // Convert answer letter (A, B, C, D) to correctIndex (0, 1, 2, 3)
  const answerLetter = (question.answer || "").toUpperCase().trim();
  const correctIndex = { "A": 0, "B": 1, "C": 2, "D": 3 }[answerLetter] ?? -1;
  
  console.log(`[getRandomQuestion] Question: "${question.question?.substring(0, 50)}...", answer="${question.answer}", correctIndex=${correctIndex}`);

  return {
    question: question.question,
    options: question.options,
    answer: question.answer,
    correctIndex: correctIndex, // Add correctIndex for server-side scoring
    id: `trivia_${randomIndex}_${Date.now()}`,
    isCard: false,
  };
}

app.post("/game-event", (req, res) => {
  const { event, data } = req.body;

  try {
    if (data.roomId && !rooms[data.roomId]) {
      rooms[data.roomId] = buildInitialRoomState();
    }

    switch (event) {
      case "start_question":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          // Reset scores if requested (fresh game session)
          if (data.resetScores) {
            console.log(`[/game-event start_question] Resetting scores for room ${data.roomId}`);
            room.scores = {};
            Object.keys(room.players || {}).forEach((playerId) => {
              if (room.players[playerId]) {
                room.players[playerId].score = 0;
              }
            });
            
            // If resetScores is true and round has ended or question is stale, clear it
            if (room.roundEnded || (room.questionStartTime && Date.now() - room.questionStartTime > (MAX_TIME + 30) * 1000)) {
              room.currentQuestion = null;
              room.roundEnded = false;
              room.currentSelections = {};
              room.lastSelections = {};
              room.questionStartTime = null;
            }
          }

          if (!data.forceNew && room.currentQuestion) {
            const now = Date.now();
            const questionStartTime = room.questionStartTime || now;
            const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
            const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

            res.json({
              success: true,
              action: "question_started",
              data: {
                question: room.currentQuestion,
                timeLeft: remainingTime,
                startTime: questionStartTime,
                showResult: room.roundEnded || remainingTime <= 0,
                selections: room.currentSelections || {},
                roundEnded: !!room.roundEnded,
              },
            });
            return;
          }

          if (data.forceNew) {
          }

          if (room.generatingQuestion) {
            setTimeout(() => {
              if (room.currentQuestion) {
                const now = Date.now();
                const questionStartTime = room.questionStartTime || now;
                const elapsedSeconds = Math.floor(
                  (now - questionStartTime) / 1000,
                );
                const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

                res.json({
                  success: true,
                  action: "question_started",
                  data: {
                    question: room.currentQuestion,
                    timeLeft: remainingTime,
                    startTime: questionStartTime,
                    selections: room.currentSelections || {},
                    roundEnded: !!room.roundEnded,
                  },
                });
              } else {
                res.json({
                  success: false,
                  error: "Failed to generate question",
                });
              }
            }, 100);
            return;
          }

          room.generatingQuestion = true;

          if (
            room.currentQuestion &&
            room.gameState === "playing" &&
            !room.roundEnded
          ) {
            const questionResponse = {
              question: room.currentQuestion,
              timeLeft: MAX_TIME,
              startTime: Date.now(),
              selections: room.currentSelections || {},
              roundEnded: !!room.roundEnded,
            };
            res.json({
              success: true,
              action: "question_started",
              data: questionResponse,
            });
            return;
          }

          if (
            room.currentQuestion &&
            room.gameState === "playing" &&
            !room.roundEnded
          ) {
            const now = Date.now();
            const questionStartTime = room.questionStartTime || now;
            const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
            const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

            const questionResponse = {
              question: room.currentQuestion,
              timeLeft: remainingTime,
              startTime: questionStartTime,
              selections: room.currentSelections || {},
              roundEnded: !!room.roundEnded,
            };
            res.json({
              success: true,
              action: "question_started",
              data: questionResponse,
            });
            return;
          }

          // NOTE: forceNew only forces a new question, it does NOT reset scores
          // Score reset should only happen via explicit "reset_scores" event
          // (removed score reset from forceNew block)

          const randomQuestion = getRandomQuestion();
          const questionStartTime = Date.now();

          room.currentQuestion = randomQuestion;
          room.questionStartTime = questionStartTime;
          room.lastActive = new Date();
          room.gameState = "playing";
          room.roundEnded = false;
          room.currentSelections = {};
          room.lastSelections = {};
          room.lastCorrectAnswer = null;
          room.resultShowStartTime = null;
          room.generatingQuestion = false;

          const questionResponse = {
            question: randomQuestion,
            timeLeft: MAX_TIME,
            startTime: questionStartTime,
            selections: room.currentSelections || {},
            roundEnded: !!room.roundEnded,
          };

          res.json({
            success: true,
            action: "question_started",
            data: questionResponse,
          });
          return;
        }
        break;

      case "select_option":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          if (!room.currentSelections) {
            room.currentSelections = {};
          }

          // Ensure player exists in scores even if not connected via socket (proxy mode)
          if (!room.scores) room.scores = {};
          if (room.scores[data.playerId] === undefined) {
            room.scores[data.playerId] = 0;
          }

          // Ensure player exists in players map for proxy mode
          if (!room.players[data.playerId]) {
            room.players[data.playerId] = {
              id: data.playerId,
              name: data.playerName || "Player",
              score: room.scores[data.playerId] || 0,
            };
          }

          const previousSelection = room.currentSelections[data.playerId];
          const isChange =
            previousSelection &&
            ((data.optionIndex !== undefined &&
              previousSelection.optionIndex !== data.optionIndex) ||
              (data.cardAnswer !== undefined &&
                previousSelection.cardAnswer !== data.cardAnswer));

          const selection = {
            timeTaken: data.timeTaken,
            timestamp: Date.now(),
          };

          if (data.cardAnswer !== undefined) {
            selection.cardAnswer = data.cardAnswer;
            selection.isCorrect = data.isCorrect;
          } else {
            selection.optionIndex = data.optionIndex;
          }

          // Check if this is a NEW correct answer (not already scored)
          const previouslyScored = room.currentSelections[data.playerId]?.scored;
          
          room.currentSelections[data.playerId] = selection;
          
          console.log(`[/api/game-event select_option] Player ${data.playerId} selected option ${data.optionIndex} in room ${data.roomId}`);
          console.log(`[/api/game-event select_option] Score check: previouslyScored=${previouslyScored}, hasQuestion=${!!room.currentQuestion}, correctIndex=${room.currentQuestion?.correctIndex}`);

          // IMMEDIATE SCORE COMPUTATION for correct answers (proxy mode real-time sync)
          if (!previouslyScored && room.currentQuestion) {
            let isCorrect = false;
            
            if (data.cardAnswer !== undefined) {
              // Card mode: isCorrect is sent by client
              isCorrect = data.isCorrect === true;
              console.log(`[/api/game-event select_option] Card mode: data.isCorrect=${data.isCorrect}, computed isCorrect=${isCorrect}`);
            } else if (data.optionIndex !== undefined) {
              // Trivia mode: check against correctIndex
              isCorrect = data.optionIndex === room.currentQuestion.correctIndex;
              console.log(`[/api/game-event select_option] Trivia mode: optionIndex=${data.optionIndex}, correctIndex=${room.currentQuestion.correctIndex}, isCorrect=${isCorrect}`);
            }
            
            if (isCorrect) {
              const points = calculatePointsFromTime(data.timeTaken ?? MAX_TIME);
              const oldScore = room.scores[data.playerId] || 0;
              room.scores[data.playerId] = oldScore + points;
              room.currentSelections[data.playerId].scored = true; // Mark as scored to prevent double-scoring
              
              // Update player object if exists
              if (room.players[data.playerId]) {
                room.players[data.playerId].score = room.scores[data.playerId];
              }
              
              console.log(`[/api/game-event select_option] Awarded ${points} points to player ${data.playerId}. Old: ${oldScore}, New: ${room.scores[data.playerId]}`);
              console.log(`[/api/game-event select_option] Current room.scores:`, JSON.stringify(room.scores));
            } else {
              console.log(`[/api/game-event select_option] Answer was incorrect, no points awarded`);
            }
          } else {
            console.log(`[/api/game-event select_option] Skipped scoring: previouslyScored=${previouslyScored}, hasQuestion=${!!room.currentQuestion}`);
          }

          if (room.roundEnded && room.lastSelections) {
            if (data.optionIndex !== undefined) {
              room.lastSelections[data.playerId] = data.optionIndex;
            } else if (data.isCorrect !== undefined) {
              room.lastSelections[data.playerId] = data.isCorrect
                ? "correct"
                : "incorrect";
            }
          }

          if (data.playerName) {
            room.playerNames[data.playerId] = data.playerName;
          }

          room.lastActive = new Date();

          res.json({
            success: true,
            message: isChange ? "Selection changed" : "Selection recorded",
          });
          return;
        }

        res.json({ success: true });
        return;

      case "end_round":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          if (room.roundEnded) {
            res.json({
              success: true,
              action: "round_complete",
              data: {
                selections: room.lastSelections || {},
                scores: room.scores || {},
                playerNames: room.playerNames || {},
                correctAnswer: room.lastCorrectAnswer,
              },
            });
            return;
          }

          room.roundEnded = true;

          const roundSelections = room.currentSelections || {};
          const currentQuestion = room.currentQuestion;

          if (currentQuestion) {
            if (currentQuestion.isCard) {
            } else {
            }

            Object.entries(roundSelections).forEach(([playerId, selection]) => {
              if (!room.scores) room.scores = {};
              if (!room.scores[playerId]) room.scores[playerId] = 0;

              let isCorrect = false;

              if (currentQuestion.isCard) {
                isCorrect = selection.isCorrect === true;
              } else {
                const correctIndex = currentQuestion.options?.findIndex((opt) =>
                  opt.startsWith(currentQuestion.answer),
                );
                isCorrect = selection.optionIndex === correctIndex;
              }

              if (isCorrect) {
                const points = calculatePointsFromTime(selection.timeTaken);
                room.scores[playerId] += points;
              } else {
              }
            });

            StorageService.saveCurrentScores(data.roomId, room.scores);
          } else {
          }

          const clientSelections = {};
          Object.entries(roundSelections).forEach(([playerId, selection]) => {
            if (selection.optionIndex !== undefined) {
              clientSelections[playerId] = selection.optionIndex;
            } else {
              clientSelections[playerId] = selection.isCorrect
                ? "correct"
                : "incorrect";
            }
          });

          const correctAnswer = currentQuestion?.isCard
            ? currentQuestion.cardName
            : currentQuestion?.answer;
          room.lastSelections = clientSelections;
          room.lastCorrectAnswer = correctAnswer;

          const responseData = {
            success: true,
            action: "round_complete",
            data: {
              selections: clientSelections,
              scores: room.scores || {},
              playerNames: room.playerNames || {},
              correctAnswer: correctAnswer,
            },
          };

          res.json(responseData);

          // Broadcast scores and selections to all socket clients in the room
          if (io) {
            io.to(data.roomId).emit("round_complete", responseData.data);
          }

          room.currentSelections = {};

          room.roundEnded = true;

          return;
        }
        break;

      case "reset_scores":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          room.scores = {};
          Object.keys(room.players || {}).forEach((playerId) => {
            if (room.players[playerId]) {
              room.players[playerId].score = 0;
            }
          });

          if (
            StorageService &&
            typeof StorageService.clearCurrentScores === "function"
          ) {
            StorageService.clearCurrentScores(data.roomId);
          }

          if (io) {
            io.to(data.roomId).emit("scores_reset", {
              scores: {},
              timestamp: new Date().toISOString(),
            });
          }

          res.json({ success: true, scores: {} });
          return;
        }
        break;
    }

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to process game event" });
  }
});

// Player join endpoint - handles session timeout and score reset
app.post("/api/player-join", (req, res) => {
  const { roomId, playerId, playerName } = req.body;
  
  if (!roomId || !playerId) {
    return res.status(400).json({ success: false, error: "Missing roomId or playerId" });
  }
  
  try {
    const room = ensureRoom(roomId);
    
    // Check if player has been away too long
    const sessionCheck = checkPlayerSessionTimeout(roomId, playerId);
    
    let scoreReset = false;
    if (sessionCheck.timedOut) {
      // Player was away for more than 1 minute - reset their score
      console.log(`[player-join] Player ${playerId} was away for ${Math.round(sessionCheck.timeSinceLastSeen / 1000)}s, resetting score`);
      if (room.scores[playerId] !== undefined) {
        room.scores[playerId] = 0;
      }
      if (room.players[playerId]) {
        room.players[playerId].score = 0;
      }
      scoreReset = true;
    }
    
    // Update last seen timestamp
    updatePlayerLastSeen(roomId, playerId);
    
    // Update player name if provided
    if (playerName) {
      room.playerNames[playerId] = playerName;
    }
    
    // Return current game state info
    const hasActiveQuestion = room.currentQuestion && !room.roundEnded;
    let timeLeft = MAX_TIME;
    if (room.questionStartTime && hasActiveQuestion) {
      const elapsedSeconds = Math.floor((Date.now() - room.questionStartTime) / 1000);
      timeLeft = Math.max(0, MAX_TIME - elapsedSeconds);
    }
    
    res.json({
      success: true,
      scoreReset,
      isNewPlayer: sessionCheck.isNewPlayer,
      hasActiveQuestion,
      timeLeft,
      hostPlayerId: room.hostPlayerId,
      scores: room.scores || {},
      playerScore: room.scores[playerId] || 0,
    });
  } catch (error) {
    console.error("[player-join] Error:", error);
    res.status(500).json({ success: false, error: "Failed to process player join" });
  }
});

app.get("/api/game-state/:roomId", (req, res) => {
  const { roomId } = req.params;
  console.log(`[game-state] Request for room ${roomId}`);

  try {
    if (roomId && !rooms[roomId]) {
      rooms[roomId] = buildInitialRoomState();
    }

    const room = rooms[roomId];
    console.log(`[game-state] Room state:`, {
      hasQuestion: !!room?.currentQuestion,
      currentSelections: room?.currentSelections,
      scores: room?.scores,
      roundEnded: room?.roundEnded,
    });
    if (room && room.currentQuestion) {
      let remainingTime = MAX_TIME;
      if (room.questionStartTime) {
        const now = Date.now();
        const elapsedSeconds = Math.floor(
          (now - room.questionStartTime) / 1000,
        );
        remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);
      }

      if (remainingTime <= 0) {
        const now = Date.now();
        const timeSinceStart = now - room.questionStartTime;
        const gracePeriodExpired =
          timeSinceStart > MAX_TIME * 1000 + GRACE_PERIOD_MAX;

        if (room.roundEnded) {
          room.currentQuestion = null;
          room.questionStartTime = null;
          room.roundEnded = false;
          room.currentSelections = {};
          room.gameState = "waiting";

          res.json({
            success: true,
            currentQuestion: null,
            timeLeft: MAX_TIME,
            showResult: false,
            gameState: "waiting",
            roundEnded: false,
            questionStartTime: null,
            selections: {},
            scores: room.scores || {},
            playerNames: room.playerNames || {},
          });
          return;
        } else {
          // AUTO-END THE ROUND when time runs out (for proxy mode without socket timer)
          console.log(`[game-state] Auto-ending round for room ${roomId}, currentSelections:`, room.currentSelections);
          
          // Compute scores before ending
          computeScores(room);
          
          // Mark round as ended
          room.roundEnded = true;
          room.lastSelections = getClientFacingSelections(room);
          room.lastCorrectAnswer = room.currentQuestion?.correctIndex;
          room.resultShowStartTime = Date.now();
          room.gameState = "waiting";
          
          console.log(`[game-state] Round ended, lastSelections:`, room.lastSelections, "scores:", room.scores);
          
          res.json({
            success: true,
            currentQuestion: room.currentQuestion,
            timeLeft: 0,
            showResult: true,
            gameState: "waiting",
            roundEnded: true,
            questionStartTime: room.questionStartTime,
            selections: room.lastSelections || {},
            scores: room.scores || {},
            playerNames: room.playerNames || {},
            correctIndex: room.currentQuestion?.correctIndex,
          });
          return;
        }
      }

      const selectionsToSend = room.roundEnded
        ? room.lastSelections || {}
        : room.currentSelections || {};

      const showResultValue = room.roundEnded;
      
      // Debug: Log what scores are being returned (version v3 - score fix deployed)
      console.log(`[game-state v3] Returning scores for room ${roomId}:`, JSON.stringify(room.scores || {}));
      
      res.json({
        success: true,
        currentQuestion: room.currentQuestion,
        timeLeft: remainingTime,
        showResult: showResultValue,
        gameState: room.gameState,
        roundEnded: room.roundEnded,
        questionStartTime: room.questionStartTime,
        selections: selectionsToSend,
        scores: room.scores || {},
        playerNames: room.playerNames || {},
        _serverVersion: "v3-score-fix", // Debug marker
      });
    } else {
      res.json({
        success: true,
        currentQuestion: null,
        timeLeft: MAX_TIME,
        showResult: false,
        gameState: "waiting",
        roundEnded: false,
        questionStartTime: null,
        selections: {},
        scores: room ? room.scores || {} : {},
        playerNames: room ? room.playerNames || {} : {},
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to get game state" });
  }
});

app.get("/game-state/:roomId", (req, res) => {
  const { roomId } = req.params;

  try {
    if (roomId && !rooms[roomId]) {
      rooms[roomId] = buildInitialRoomState();
    }

    const room = rooms[roomId];
    if (room && room.currentQuestion) {
      let remainingTime = MAX_TIME;
      if (room.questionStartTime) {
        const now = Date.now();
        const elapsedSeconds = Math.floor(
          (now - room.questionStartTime) / 1000,
        );
        remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);
      }

      if (remainingTime <= 0) {
        const now = Date.now();
        const timeSinceStart = now - room.questionStartTime;
        const gracePeriodExpired =
          timeSinceStart > MAX_TIME * 1000 + GRACE_PERIOD_MAX;

        const selectionsToSend = room.roundEnded
          ? room.lastSelections || {}
          : room.currentSelections || {};
        res.json({
          success: true,
          currentQuestion: room.currentQuestion,
          timeLeft: 0,
          showResult: room.roundEnded,
          gameState: "active",
          roundEnded: room.roundEnded,
          questionStartTime: room.questionStartTime,
          selections: selectionsToSend,
          scores: room.scores || {},
          playerNames: room.playerNames || {},
          hostPlayerId: room.hostPlayerId,
        });
        return;
      }

      const selectionsToSend = room.roundEnded
        ? room.lastSelections || {}
        : room.currentSelections || {};
      res.json({
        success: true,
        currentQuestion: room.currentQuestion,
        timeLeft: remainingTime,
        showResult: room.roundEnded,
        gameState: room.gameState,
        roundEnded: room.roundEnded,
        questionStartTime: room.questionStartTime,
        selections: selectionsToSend,
        scores: room.scores || {},
        playerNames: room.playerNames || {},
        hostPlayerId: room.hostPlayerId,
      });
    } else {
      res.json({
        success: true,
        currentQuestion: null,
        timeLeft: MAX_TIME,
        showResult: false,
        gameState: "waiting",
        roundEnded: false,
        questionStartTime: null,
        hostPlayerId: room ? room.hostPlayerId : null,
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to get game state" });
  }
});

app.post("/api/start_question", (req, res) => {
  const { roomId, forceNew, playerId, resetScores } = req.body;

  if (!roomId) {
    return res.status(400).json({ success: false, error: "Missing roomId" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = buildInitialRoomState();
    }

    const room = rooms[roomId];

    // Reset scores if requested (fresh game session)
    if (resetScores) {
      console.log(`[/api/start_question] Resetting scores for room ${roomId}`);
      room.scores = {};
      Object.keys(room.players || {}).forEach((pid) => {
        if (room.players[pid]) {
          room.players[pid].score = 0;
        }
      });
      
      // If resetScores is true and round has ended or question is stale, clear it
      if (room.roundEnded || (room.questionStartTime && Date.now() - room.questionStartTime > (MAX_TIME + 30) * 1000)) {
        room.currentQuestion = null;
        room.roundEnded = false;
        room.currentSelections = {};
        room.lastSelections = {};
        room.questionStartTime = null;
      }
    }

    if (!forceNew && room.currentQuestion && !room.roundEnded) {
      const now = Date.now();
      const questionStartTime = room.questionStartTime || now;
      const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
      const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

      return res.json({
        success: true,
        question: room.currentQuestion,
        timeLeft: remainingTime,
        startTime: questionStartTime,
        showResult: room.roundEnded || remainingTime <= 0,
        hostPlayerId: room.hostPlayerId,
      });
    }

    if (forceNew && room.currentQuestion && room.questionStartTime) {
      const now = Date.now();
      const timeSinceGeneration = now - room.questionStartTime;

      if (timeSinceGeneration < 3000) {
        const elapsedSeconds = Math.floor(timeSinceGeneration / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: room.questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
          hostPlayerId: room.hostPlayerId,
        });
      }
    }

    const hostCheck = assertHostControl(room, playerId, {
      allowClaim: true,
      allowTakeover: true,
    });

    if (!hostCheck.ok) {
      return res
        .status(hostCheck.status)
        .json({
          success: false,
          error: hostCheck.error,
          hostPlayerId: room.hostPlayerId,
        });
    }

    if (room.generatingQuestion) {
      if (room.currentQuestion && !room.roundEnded) {
        const now = Date.now();
        const questionStartTime = room.questionStartTime || now;
        const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
          hostPlayerId: room.hostPlayerId,
        });
      } else {
        return res
          .status(409)
          .json({
            success: false,
            error: "Question generation in progress, try again",
            hostPlayerId: room.hostPlayerId,
          });
      }
    }

    const now = Date.now();
    if (room.lastQuestionGenerated && now - room.lastQuestionGenerated < 2000) {
      if (room.currentQuestion) {
        const questionStartTime = room.questionStartTime || now;
        const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
          hostPlayerId: room.hostPlayerId,
        });
      } else {
        return res
          .status(429)
          .json({
            success: false,
            error: "Rate limited: too many requests",
            hostPlayerId: room.hostPlayerId,
          });
      }
    }

    if (forceNew) {
    } else {
    }

    if (room.generatingQuestion) {
      if (room.currentQuestion && !room.roundEnded) {
        const questionStartTime = room.questionStartTime || now;
        const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
          hostPlayerId: room.hostPlayerId,
        });
      } else {
        return res
          .status(409)
          .json({
            success: false,
            error: "Question generation in progress, try again",
            hostPlayerId: room.hostPlayerId,
          });
      }
    }

    room.generatingQuestion = true;
    room.lastQuestionGenerated = now;

    // NOTE: forceNew only forces a new question, it does NOT reset scores
    // Score reset should only happen via explicit "reset_scores" event

    const randomQuestion = getRandomQuestion();
    const questionStartTime = Date.now();

    room.currentQuestion = randomQuestion;
    room.questionStartTime = questionStartTime;
    room.lastActive = new Date();
    room.gameState = "playing";
    room.roundEnded = false;
    room.currentSelections = {};
    room.lastSelections = {};
    room.lastCorrectAnswer = null;
    room.resultShowStartTime = null;
    room.selections = {};
    room.generatingQuestion = false;

    io.to(roomId).emit("gameState", {
      currentQuestion: randomQuestion,
      timeLeft: MAX_TIME,
      showResult: false,
      gameState: "playing",
      questionStartTime: questionStartTime,
      selections: {},
      scores: room.scores || {},
      playerNames: room.playerNames || {},
      hostPlayerId: room.hostPlayerId,
    });

    res.json({
      success: true,
      question: randomQuestion,
      timeLeft: MAX_TIME,
      startTime: questionStartTime,
      hostPlayerId: room.hostPlayerId,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to start question" });
  }
});

app.post("/start_question", (req, res) => {
  const { roomId, forceNew, resetScores } = req.body;

  if (!roomId) {
    return res.status(400).json({ success: false, error: "Missing roomId" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = buildInitialRoomState();
    }

    const room = rooms[roomId];

    // Reset scores if requested (fresh game session)
    if (resetScores) {
      console.log(`[/start_question] Resetting scores for room ${roomId}`);
      room.scores = {};
      Object.keys(room.players || {}).forEach((pid) => {
        if (room.players[pid]) {
          room.players[pid].score = 0;
        }
      });
      
      // If resetScores is true and round has ended or question is stale, clear it
      if (room.roundEnded || (room.questionStartTime && Date.now() - room.questionStartTime > (MAX_TIME + 30) * 1000)) {
        room.currentQuestion = null;
        room.roundEnded = false;
        room.currentSelections = {};
        room.lastSelections = {};
        room.questionStartTime = null;
      }
    }

    if (!forceNew && room.currentQuestion && !room.roundEnded) {
      const now = Date.now();
      const questionStartTime = room.questionStartTime || now;
      const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
      const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

      return res.json({
        success: true,
        question: room.currentQuestion,
        timeLeft: remainingTime,
        startTime: questionStartTime,
        showResult: room.roundEnded || remainingTime <= 0,
      });
    }

    if (forceNew && room.currentQuestion && room.questionStartTime) {
      const now = Date.now();
      const timeSinceGeneration = now - room.questionStartTime;

      if (timeSinceGeneration < 5000) {
        const elapsedSeconds = Math.floor(timeSinceGeneration / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: room.questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
        });
      }
    }

    if (forceNew) {
    }

    if (room.generatingQuestion) {
      if (room.currentQuestion && !room.roundEnded) {
        const now = Date.now();
        const questionStartTime = room.questionStartTime || now;
        const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
        });
      } else {
        return res
          .status(409)
          .json({
            success: false,
            error: "Question generation in progress, try again",
          });
      }
    }

    const now = Date.now();
    if (room.lastQuestionGenerated && now - room.lastQuestionGenerated < 2000) {
      if (room.currentQuestion) {
        const questionStartTime = room.questionStartTime || now;
        const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
        const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: questionStartTime,
          showResult: room.roundEnded || remainingTime <= 0,
        });
      } else {
        return res
          .status(429)
          .json({ success: false, error: "Rate limited: too many requests" });
      }
    }

    room.generatingQuestion = true;
    room.lastQuestionGenerated = now;

    const randomQuestion = getRandomQuestion();
    const questionStartTime = Date.now();

    room.currentQuestion = randomQuestion;
    room.questionStartTime = questionStartTime;
    room.lastActive = new Date();
    room.gameState = "playing";
    room.roundEnded = false;
    room.currentSelections = {};
    room.lastSelections = {};
    room.lastCorrectAnswer = null;
    room.resultShowStartTime = null;
    room.generatingQuestion = false;

    io.to(roomId).emit("gameState", {
      currentQuestion: randomQuestion,
      timeLeft: MAX_TIME,
      showResult: false,
      gameState: "playing",
      questionStartTime: questionStartTime,
      selections: {},
      scores: room.scores || {},
      playerNames: room.playerNames || {},
      hostPlayerId: room.hostPlayerId,
    });

    res.json({
      success: true,
      question: randomQuestion,
      timeLeft: MAX_TIME,
      startTime: questionStartTime,
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to start question" });
  }
});

app.post("/api/sync_local_question", (req, res) => {
  const { roomId, question, timeLeft, playerId } = req.body;

  if (!roomId || !question) {
    return res
      .status(400)
      .json({ success: false, error: "Missing roomId or question" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = buildInitialRoomState();
    }

    const room = rooms[roomId];

    const hostCheck = assertHostControl(room, playerId, {
      allowClaim: true,
      allowTakeover: true,
    });

    if (!hostCheck.ok) {
      return res
        .status(hostCheck.status)
        .json({
          success: false,
          error: hostCheck.error,
          hostPlayerId: room.hostPlayerId,
        });
    }

    if (!room.currentQuestion) {
      const now = Date.now();
      const elapsedTime = MAX_TIME - (timeLeft || MAX_TIME);
      const questionStartTime = now - elapsedTime * 1000;

      room.currentQuestion = question;
      room.gameState = "playing";
      room.questionStartTime = questionStartTime;
      room.roundEnded = false;
      room.selections = {};

      if (room.timer) {
        clearTimeout(room.timer);
      }

      if (timeLeft > 0) {
        room.timer = setTimeout(() => {
          room.roundEnded = true;
          room.gameState = "ended";
        }, timeLeft * 1000);
      }

      return res.json({
        success: true,
        message: "Local question synced to server",
        question: room.currentQuestion,
        timeLeft: timeLeft || MAX_TIME,
        hostPlayerId: room.hostPlayerId,
      });
    } else {
      const now = Date.now();
      const questionStartTime = room.questionStartTime || now;
      const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
      const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

      return res.json({
        success: true,
        message: "Server already has question",
        question: room.currentQuestion,
        timeLeft: remainingTime,
        hadExisting: true,
        hostPlayerId: room.hostPlayerId,
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to sync local question" });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [
      "http://127.0.0.1",
      "http://localhost:5173",
  "https://1438780052144783371.discordsays.com",
      "https://discord-frontend-virid.vercel.app",
      "https://discordbackend-xggi.onrender.com",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const channelId = socket.handshake.auth?.channelId;
    const reconnecting = socket.handshake.auth?.reconnecting;

    if (!token) return next(new Error("Missing token"));
    if (!channelId) return next(new Error("Missing voice channel ID"));

    socket.data.reconnecting = reconnecting;

    const resp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) return next(new Error("Invalid Discord token"));
    const user = await resp.json();

    socket.data.user = user;
    socket.data.channelId = channelId;

    if (!rooms[channelId]) {
      rooms[channelId] = buildInitialRoomState();
    }

    rooms[channelId].hostSocketId = rooms[channelId].hostSocketId || socket.id;

    return next();
  } catch (err) {
    return next(new Error("Auth error"));
  }
});

function pickRandomQuestion(room) {
  if (!questions || !questions.length) return null;
  const idx = Math.floor(Math.random() * questions.length);
  const qraw = questions[idx];

  return {
    id: `q_${Date.now()}_${idx}`,
    question: qraw.question,
    options: qraw.options,
    correctIndex: qraw.options.findIndex((opt) => opt.startsWith(qraw.answer)),
  };
}

function cleanupInactiveRooms() {
  const now = new Date();
  const roomsToDelete = [];

  Object.entries(rooms).forEach(([channelId, room]) => {
    const timeSinceLastActive = now - room.lastActive;
    if (timeSinceLastActive > ROOM_INACTIVE_THRESHOLD) {
      roomsToDelete.push(channelId);

      if (room.timer) {
        clearTimeout(room.timer);
      }

      if (room.scores && Object.keys(room.scores).length > 0) {
        StorageService.saveLeaderboard(channelId, room.scores);
      }
    }
  });

  roomsToDelete.forEach((channelId) => {
    delete rooms[channelId];
  });

  if (roomsToDelete.length > 0) {
  }
}

setInterval(cleanupInactiveRooms, ROOM_CLEANUP_INTERVAL);

function scheduleNextReset() {
  const now = new Date();
  const nextReset = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (now.getHours() >= LEADERBOARD_RESET_HOUR ? 1 : 0),
    LEADERBOARD_RESET_HOUR,
    LEADERBOARD_RESET_MINUTE,
  );

  const timeUntilReset = nextReset.getTime() - now.getTime();
  setTimeout(() => {
    resetLeaderboards();
    scheduleNextReset();
  }, timeUntilReset);
}

async function resetLeaderboards() {
  const archive = {
    date: new Date().toISOString().split("T")[0],
    channels: {},
  };

  for (const [channelId, room] of Object.entries(rooms)) {
    await StorageService.archiveLeaderboard(
      channelId,
      Object.entries(room.players).map(([id, player]) => ({
        id,
        name: player.name,
        score: player.score,
        avatar: player.avatar,
      })),
    );
  }

  Object.entries(rooms).forEach(([channelId, room]) => {
    archive.channels[channelId] = {
      players: Object.entries(room.players).map(([id, player]) => ({
        id,
        name: player.name,
        score: player.score,
        avatar: player.avatar,
      })),
    };

    Object.keys(room.players).forEach((playerId) => {
      room.players[playerId].score = 0;
    });
    room.scores = {};

    StorageService.clearCurrentScores(channelId);

    io.to(channelId).emit("leaderboard_reset", {
      previousScores: archive.channels[channelId].players,
      timestamp: new Date().toISOString(),
    });

    io.to(channelId).emit("room_state", {
      players: Object.values(room.players).map((p) => ({
        id: p.id,
        name: p.name,
        score: 0,
        avatar: p.avatar,
      })),
      scores: room.scores,
      gameState: room.gameState,
      hostPlayerId: room.hostPlayerId,
    });
  });

  analytics.dailyStats = {
    date: new Date().toISOString().split("T")[0],
    gamesPlayed: 0,
    questionsAnswered: 0,
    uniquePlayers: new Set(),
  };
}

scheduleNextReset();

function getClientFacingSelections(room) {
  if (room.currentSelections && Object.keys(room.currentSelections).length > 0) {
    const normalized = {};
    Object.entries(room.currentSelections).forEach(([playerId, selection]) => {
      if (selection.optionIndex !== undefined) {
        normalized[playerId] = selection.optionIndex;
      } else if (selection.cardAnswer !== undefined) {
        normalized[playerId] = selection.cardAnswer;
      }
    });
    return normalized;
  }

  return { ...room.selections };
}

function computeScores(room) {
  const { currentSelections, currentQuestion } = room;
  if (!currentQuestion || !currentSelections) return;

  const correctIndex = currentQuestion.correctIndex;

  // Ensure room.scores exists
  if (!room.scores) {
    room.scores = {};
  }

  Object.entries(currentSelections).forEach(([playerId, selection]) => {
    // Skip if already scored during selection (real-time scoring for proxy mode)
    if (selection.scored) {
      return;
    }
    
    // Initialize score for this player if not present
    if (room.scores[playerId] === undefined) {
      room.scores[playerId] = 0;
    }

    const player = room.players[playerId];
    
    // Determine if answer is correct based on question type
    let isCorrect = false;
    if (currentQuestion.isCard) {
      isCorrect = selection.isCorrect === true;
    } else {
      isCorrect = selection.optionIndex === correctIndex;
    }

    if (isCorrect) {
      const points = calculatePointsFromTime(selection.timeTaken ?? MAX_TIME);
      
      // Update room.scores directly (authoritative)
      room.scores[playerId] = (room.scores[playerId] || 0) + points;
      
      // Also update player object if it exists
      if (player) {
        player.score = room.scores[playerId];
      }
    }
  });
}

io.on("connection", (socket) => {
  const user = socket.data.user;
  const channelId = socket.data.channelId;
  const reconnecting = socket.data.reconnecting;

  if (reconnecting && rooms[channelId]) {
    const existingPlayer = rooms[channelId].players[user.id];
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      existingPlayer.connected = true;
      existingPlayer.lastActive = new Date();

      const questionStartTime =
        rooms[channelId].questionStartTime ||
        rooms[channelId].currentQuestion?.startTime;
      const elapsedSeconds = questionStartTime
        ? Math.floor((Date.now() - questionStartTime) / 1000)
        : 0;
      const timeLeft = rooms[channelId].currentQuestion
        ? Math.max(0, MAX_TIME - elapsedSeconds)
        : 0;

      socket.emit("game_state", {
        currentQuestion: rooms[channelId].currentQuestion,
        selections: rooms[channelId].selections,
        scores: rooms[channelId].scores,
        gameState: rooms[channelId].gameState,
        roundEnded: rooms[channelId].roundEnded,
        timeLeft,
        hostPlayerId: rooms[channelId].hostPlayerId,
      });
    }
  }

  if (!rooms[channelId]) {
    rooms[channelId] = buildInitialRoomState();
  }

  rooms[channelId].hostSocketId = rooms[channelId].hostSocketId || socket.id;
  if (
    !rooms[channelId].hostPlayerId ||
    rooms[channelId].hostSocketId === socket.id
  ) {
    rooms[channelId].hostPlayerId = user.id;
    rooms[channelId].hostLastActiveAt = Date.now();
  }

  rooms[channelId].lastActive = new Date();

  rooms[channelId].players[user.id] = {
    id: user.id,
    name: user.username,
    score: rooms[channelId].players[user.id]?.score ?? 0,
    socketId: socket.id,
    avatar: user.avatar,
  };

  rooms[channelId].playerNames[user.id] = user.username;

  if (rooms[channelId].hostSocketId === socket.id) {
    rooms[channelId].hostPlayerId = user.id;
    rooms[channelId].hostLastActiveAt = Date.now();
  }

  rooms[channelId].scores = Object.fromEntries(
    Object.entries(rooms[channelId].players).map(([id, p]) => [
      id,
      p.score || 0,
    ]),
  );

  socket.join(channelId);

  socket.emit("you_joined", {
    playerId: user.id,
    isHost: rooms[channelId].hostSocketId === socket.id,
    hostPlayerId: rooms[channelId].hostPlayerId,
  });

  const playersList = Object.values(rooms[channelId].players).map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score || 0,
    avatar: p.avatar,
  }));

  io.to(channelId).emit("room_state", {
    players: playersList,
    scores: rooms[channelId].scores,
    gameState: rooms[channelId].gameState,
    hostPlayerId: rooms[channelId].hostPlayerId,
  });

  socket.on("start_question", () => {
    const room = rooms[channelId];
    if (!room) return;

    if (room.hostSocketId !== socket.id) return;

    if (room.gameState === "playing") return;

    const q = pickRandomQuestion(room);
    if (!q) return;

    room.currentQuestion = {
      ...q,
      startTime: Date.now(),
      maxTime: MAX_TIME,
    };
    room.questionStartTime = room.currentQuestion.startTime;
    room.selections = {};
    room.currentSelections = {};
    room.lastSelections = {};
    room.lastCorrectAnswer = null;
    room.resultShowStartTime = null;
    room.gameState = "playing";
    room.lastActive = new Date();
    room.roundEnded = false;

    analytics.totalGamesPlayed++;
    analytics.dailyStats.gamesPlayed++;
    analytics.activeChannels.add(channelId);

    Object.keys(room.players).forEach((playerId) => {
      analytics.dailyStats.uniquePlayers.add(playerId);
    });

    room.questionHistory.push({
      questionId: q.id,
      startTime: room.currentQuestion.startTime,
    });

    io.to(channelId).emit("question_started", {
      question: {
        id: q.id,
        question: q.question,
        options: q.options,
      },
      startTime: room.currentQuestion.startTime,
      maxTime: room.currentQuestion.maxTime,
      selections: room.selections || {},
      roundEnded: false,
      hostPlayerId: room.hostPlayerId,
    });

    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      computeScores(room);
      // Merge scores from players into room.scores (don't overwrite scores from proxy-mode players)
      Object.entries(room.players).forEach(([id, p]) => {
        const playerScore = p.score || 0;
        const existingScore = room.scores[id] || 0;
        // Use the higher score to avoid losing points
        room.scores[id] = Math.max(playerScore, existingScore);
        // Sync player object
        p.score = room.scores[id];
      });
      const selectionSnapshot = getClientFacingSelections(room);
      const correctIndex = room.currentQuestion?.correctIndex;
      room.lastSelections = selectionSnapshot;
      room.lastCorrectAnswer = correctIndex;
      room.roundEnded = true;
      room.resultShowStartTime = Date.now();
      room.gameState = "waiting";
      room.questionStartTime = null;
      io.to(channelId).emit("show_result", {
        correctIndex,
        scores: room.scores,
        selections: selectionSnapshot,
        hostPlayerId: room.hostPlayerId,
      });
      room.currentQuestion = null;
      room.selections = {};
      room.currentSelections = {};
      room.timer = null;

      io.to(channelId).emit("room_state", {
        players: Object.values(room.players),
        scores: room.scores,
        hostPlayerId: room.hostPlayerId,
      });
    }, MAX_TIME * 1000);
  });

  socket.on("select_option", ({ optionIndex }) => {
    const room = rooms[channelId];
    if (!room || !room.currentQuestion || room.gameState !== "playing") return;
    if (room.selections[user.id] !== undefined) return;

    if (!room.currentSelections) {
      room.currentSelections = {};
    }

    const now = Date.now();
    const questionStart =
      room.questionStartTime || room.currentQuestion.startTime || now;
    const timeTakenSeconds = Math.min(
      MAX_TIME,
      Math.max(0, (now - questionStart) / 1000),
    );

    room.selections[user.id] = optionIndex;
    room.currentSelections[user.id] = {
      optionIndex,
      timeTaken: timeTakenSeconds,
      timestamp: now,
    };
    room.playerNames[user.id] =
      room.players[user.id]?.name || user.username || room.playerNames[user.id];
    room.lastActive = new Date();

    analytics.totalQuestionsAnswered++;
    analytics.dailyStats.questionsAnswered++;

    console.log(`[player_selected via socket] Broadcasting to channel ${channelId}:`, {
      playerId: user.id,
      optionIndex,
      playerName: room.players[user.id].name,
      socketsInRoom: io.sockets.adapter.rooms.get(channelId)?.size || 0,
    });
    io.to(channelId).emit("player_selected", {
      playerId: user.id,
      optionIndex,
      playerName: room.players[user.id].name,
    });

    // Do NOT auto-end early; wait for the timer or host action so the round stays active
  });

  socket.on("activity_ended", ({ roomId: requestedRoomId }) => {
    const targetRoom = requestedRoomId || channelId;
    const room = rooms[targetRoom];

    if (room) {
      if (room.timer) {
        clearTimeout(room.timer);
      }

      if (room.scores && Object.keys(room.scores).length > 0) {
        StorageService.saveLeaderboard(targetRoom, room.scores);
      }

      delete rooms[targetRoom];

      io.to(targetRoom).emit("activity_cleanup", {
        message: "Activity ended, room cleaned up",
      });
    }
  });

  socket.on("disconnect", () => {
    const room = rooms[channelId];
    if (!room) return;

    room.lastActive = new Date();

    delete room.players[user.id];
    delete room.scores[user.id];

    if (room.hostSocketId === socket.id) {
      const sockets = Array.from(io.sockets.adapter.rooms.get(channelId) ?? []);
      room.hostSocketId = sockets.length > 0 ? sockets[0] : null;

      if (room.hostSocketId) {
        const newHostSocket = io.sockets.sockets.get(room.hostSocketId);
        if (newHostSocket) {
          room.hostPlayerId = newHostSocket.data.user.id;
          room.hostLastActiveAt = Date.now();
          newHostSocket.emit("you_joined", {
            playerId: newHostSocket.data.user.id,
            isHost: true,
            hostPlayerId: room.hostPlayerId,
          });
        }
      } else {
        room.hostPlayerId = null;
        room.hostLastActiveAt = null;
      }
    }

    if (Object.keys(room.players).length === 0) {
      if (room.timer) {
        clearTimeout(room.timer);
      }

      if (room.scores && Object.keys(room.scores).length > 0) {
        StorageService.saveLeaderboard(channelId, room.scores);
      }

      delete rooms[channelId];
    } else {
      io.to(channelId).emit("room_state", {
        players: Object.values(room.players).map((p) => ({
          id: p.id,
          name: p.name,
          score: p.score || 0,
          avatar: p.avatar,
        })),
        scores: room.scores,
        gameState: room.gameState,
        hostPlayerId: room.hostPlayerId,
      });
    }
  });
});

const path = require("path");

if (process.env.NODE_ENV === "production") {
  const frontendPath = path.join(__dirname, "../client/dist");
  app.use(express.static(frontendPath));

  app.get("/", (req, res) => {
    res.sendFile(path.join(frontendPath, "index.html"));
  });
} else {
  app.get("/", (req, res) => {
    res.redirect("https://discord-frontend-virid.vercel.app");
  });
}

server.listen(PORT, () => {});
