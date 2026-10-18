const { io } = require("../app");
const { MAX_TIME } = require("../config");
const questions = require("../questions.json");
const StorageService = require("../services/StorageService");
const { getCachedTokenUser, setCachedTokenUser } = require("../lib/tokenCache");
const {
  ROOM_CLEANUP_INTERVAL, ROOM_INACTIVE_THRESHOLD, LEADERBOARD_RESET_HOUR, LEADERBOARD_RESET_MINUTE,
  analytics, rooms, buildInitialRoomState,
} = require("./state");
const { calculatePointsFromTime } = require("./scoring");

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    const channelId = socket.handshake.auth?.channelId;
    const reconnecting = socket.handshake.auth?.reconnecting;

    if (!token) return next(new Error("Missing token"));
    if (!channelId) return next(new Error("Missing voice channel ID"));

    socket.data.reconnecting = reconnecting;

    // Use cached user if token was validated recently (avoids hammering Discord API on reconnects)
    let user = getCachedTokenUser(token);
    if (!user) {
      const resp = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return next(new Error("Invalid Discord token"));
      user = await resp.json();
      setCachedTokenUser(token, user);
    }

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
