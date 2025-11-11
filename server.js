require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const questions = require("./questions.json");
const cors = require("cors");
const StorageService = require("./services/StorageService");
const { logger, safeLog } = require("./utils/logger");

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: [
      "http://127.0.0.1",
      "http://localhost:5173",
      "https://1414187165146943518.discordsays.com",
      "https://discord-frontend-virid.vercel.app",
      "https://discordbackend-xggi.onrender.com",
    ],
    credentials: true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

const PORT = process.env.PORT || 3001;
const CLIENT_ID = process.env.VITE_DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const MAX_TIME = 20;

const MAX_POINTS = 150;
const SCORING_EXPONENT = 2;

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

if (!CLIENT_ID || !CLIENT_SECRET) {
  process.exit(1);
}

const fetch = global.fetch;

if (!fetch) {
  process.exit(1);
}

app.post("/api/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "missing code" });

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
  });

  try {
    const resp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await resp.json();

    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/token", async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: "missing code" });

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
  });

  try {
    const resp = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = await resp.json();

    return res.json(json);
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    server: "quiz-backend",
    timestamp: new Date().toISOString(),
  });
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
      rooms[data.roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
    }

    switch (event) {
      case "start_question":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

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

          if (data.forceNew) {
            Object.keys(room.players || {}).forEach((playerId) => {
              if (room.players[playerId]) {
                room.players[playerId].score = 0;
              }
            });
            room.scores = {};

            StorageService.clearCurrentScores(data.roomId);
          }

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

          if (!room.currentSelections) {
            room.currentSelections = {};
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

          room.currentSelections[data.playerId] = selection;

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

          res.json({
            success: true,
            message: isChange ? "Selection changed" : "Selection recorded",
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

  return {
    question: question.question,
    options: question.options,
    answer: question.answer,
    id: `trivia_${randomIndex}_${Date.now()}`,
    isCard: false,
  };
}

app.post("/game-event", (req, res) => {
  const { event, data } = req.body;

  try {
    if (data.roomId && !rooms[data.roomId]) {
      rooms[data.roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
    }

    switch (event) {
      case "start_question":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

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

          if (data.forceNew) {
            Object.keys(room.players).forEach((playerId) => {
              room.players[playerId].score = 0;
            });
            room.scores = {};

            StorageService.clearCurrentScores(data.roomId);
          }

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

          room.currentSelections[data.playerId] = selection;

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

app.get("/api/game-state/:roomId", (req, res) => {
  const { roomId } = req.params;

  try {
    if (roomId && !rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
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
          });
          return;
        }
      }

      const selectionsToSend = room.roundEnded
        ? room.lastSelections || {}
        : room.currentSelections || {};

      const showResultValue = room.roundEnded;
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
      rooms[roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
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
      });
    }
  } catch (error) {
    res.status(500).json({ error: "Failed to get game state" });
  }
});

app.post("/api/start_question", (req, res) => {
  const { roomId, forceNew } = req.body;

  if (!roomId) {
    return res.status(400).json({ success: false, error: "Missing roomId" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
    }

    const room = rooms[roomId];

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

      if (timeSinceGeneration < 3000) {
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

    room.generatingQuestion = true;
    room.lastQuestionGenerated = now;

    if (forceNew) {
      Object.keys(room.players || {}).forEach((playerId) => {
        if (room.players[playerId]) {
          room.players[playerId].score = 0;
        }
      });
      room.scores = {};

      StorageService.clearCurrentScores(roomId);
    }

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

app.post("/start_question", (req, res) => {
  const { roomId, forceNew } = req.body;

  if (!roomId) {
    return res.status(400).json({ success: false, error: "Missing roomId" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
    }

    const room = rooms[roomId];

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
  const { roomId, question, timeLeft } = req.body;

  if (!roomId || !question) {
    return res
      .status(400)
      .json({ success: false, error: "Missing roomId or question" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        playerNames: {},
        questionHistory: [],
      };
    }

    const room = rooms[roomId];

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
      "https://1414187165146943518.discordsays.com",
      "https://discord-frontend-virid.vercel.app",
      "https://discordbackend-xggi.onrender.com",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

const rooms = {};

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
      rooms[channelId] = {
        players: {},
        currentQuestion: null,
        selections: {},
        hostSocketId: null,
        timer: null,
        gameState: "waiting",
        startTime: new Date(),
        lastActive: new Date(),
        scores: {},
        questionHistory: [],
      };
    }

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

function computeScores(room) {
  const { selections, currentQuestion } = room;
  if (!currentQuestion) return;
  const correct = currentQuestion.correctIndex;
  const endTime = Date.now();
  const startTime = currentQuestion.startTime || endTime;
  const elapsedSec = Math.max(0, Math.floor((endTime - startTime) / 1000));
  const remaining = Math.max(
    0,
    (currentQuestion.maxTime || MAX_TIME) - elapsedSec,
  );
  const bonusFactor = Math.ceil(
    (remaining / (currentQuestion.maxTime || MAX_TIME)) * 10,
  );
  for (const uid of Object.keys(room.players)) {
    const pick = selections[uid];
    if (pick === correct)
      room.players[uid].score = (room.players[uid].score || 0) + bonusFactor;
  }
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

      socket.emit("game_state", {
        currentQuestion: rooms[channelId].currentQuestion,
        selections: rooms[channelId].selections,
        scores: rooms[channelId].scores,
        gameState: rooms[channelId].gameState,
        timeLeft: rooms[channelId].currentQuestion
          ? Math.max(
              0,
              MAX_TIME -
                Math.floor(
                  (Date.now() - rooms[channelId].currentQuestion.startTime) /
                    1000,
                ),
            )
          : 0,
      });
    }
  }

  if (!rooms[channelId]) {
    rooms[channelId] = {
      players: {},
      selections: {},
      currentQuestion: null,
      hostSocketId: socket.id,
      timer: null,
      scores: {},
      gameState: "waiting",
      startTime: new Date(),
      lastActive: new Date(),
      questionHistory: [],
    };
  }

  rooms[channelId].lastActive = new Date();

  rooms[channelId].players[user.id] = {
    id: user.id,
    name: user.username,
    score: rooms[channelId].players[user.id]?.score ?? 0,
    socketId: socket.id,
    avatar: user.avatar,
  };

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
  });

  socket.on("start_question", () => {
    const room = rooms[channelId];
    if (!room) return;

    if (room.hostSocketId !== socket.id) return;

    if (room.gameState === "active") return;

    const q = pickRandomQuestion(room);
    if (!q) return;

    room.currentQuestion = {
      ...q,
      startTime: Date.now(),
      maxTime: MAX_TIME,
    };
    room.selections = {};
    room.gameState = "active";
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
    });

    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => {
      computeScores(room);
      room.scores = Object.fromEntries(
        Object.entries(room.players).map(([id, p]) => [id, p.score || 0]),
      );
      io.to(channelId).emit("show_result", {
        correctIndex: room.currentQuestion.correctIndex,
        scores: room.scores,
        selections: room.selections,
      });
      room.currentQuestion = null;
      room.selections = {};
      room.timer = null;

      io.to(channelId).emit("room_state", {
        players: Object.values(room.players),
        scores: room.scores,
      });
    }, MAX_TIME * 1000);
  });

  socket.on("select_option", ({ optionIndex }) => {
    const room = rooms[channelId];
    if (!room || !room.currentQuestion || room.gameState !== "active") return;
    if (room.selections[user.id] !== undefined) return;

    room.selections[user.id] = optionIndex;
    room.lastActive = new Date();

    analytics.totalQuestionsAnswered++;
    analytics.dailyStats.questionsAnswered++;

    io.to(channelId).emit("player_selected", {
      playerId: user.id,
      optionIndex,
      playerName: room.players[user.id].name,
    });

    const connectedPlayerCount = Object.keys(room.players).length;
    const answeredCount = Object.keys(room.selections).length;
    if (answeredCount >= connectedPlayerCount) {
      if (room.timer) clearTimeout(room.timer);

      computeScores(room);
      room.scores = Object.fromEntries(
        Object.entries(room.players).map(([id, p]) => [id, p.score || 0]),
      );
      io.to(channelId).emit("show_result", {
        correctIndex: room.currentQuestion.correctIndex,
        scores: room.scores,
        selections: room.selections,
      });
      room.currentQuestion = null;
      room.selections = {};
      room.timer = null;

      io.to(channelId).emit("room_state", {
        players: Object.values(room.players),
        scores: room.scores,
      });
    }
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
          newHostSocket.emit("you_joined", {
            playerId: newHostSocket.data.user.id,
            isHost: true,
          });
        }
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
