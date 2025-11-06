const INACTIVE_PLAYER_THRESHOLD = 1000 * 60 * 5;

function cleanupInactivePlayers(room, channelId, io) {
  const now = new Date();
  const playersToRemove = [];

  Object.entries(room.players).forEach(([playerId, player]) => {
    const timeSinceActive = now - new Date(player.lastActive);
    if (timeSinceActive > INACTIVE_PLAYER_THRESHOLD) {
      playersToRemove.push(playerId);
    }
  });

  if (playersToRemove.length === 0) return;

  playersToRemove.forEach((playerId) => {
    delete room.players[playerId];
    delete room.scores[playerId];
    delete room.selections[playerId];
  });

  if (Object.keys(room.players).length === 0) {
    if (room.timer) {
      clearTimeout(room.timer);
    }
    return true;
  }

  if (playersToRemove.includes(room.hostSocketId)) {
    const remainingPlayers = Object.values(room.players);
    if (remainingPlayers.length > 0) {
      room.hostSocketId = remainingPlayers[0].socketId;

      io.to(room.hostSocketId).emit("you_joined", {
        playerId: remainingPlayers[0].id,
        isHost: true,
      });
    }
  }

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

  return false;
}

function handleQuestionError(room, channelId, io) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }

  room.currentQuestion = null;
  room.selections = {};
  room.gameState = "waiting";

  io.to(channelId).emit("question_error", {
    message: "Question terminated due to error",
    gameState: "waiting",
  });

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

module.exports = {
  cleanupInactivePlayers,
  handleQuestionError,
  INACTIVE_PLAYER_THRESHOLD,
};
