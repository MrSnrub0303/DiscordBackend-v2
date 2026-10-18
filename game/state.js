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

module.exports = {
  ROOM_CLEANUP_INTERVAL, ROOM_INACTIVE_THRESHOLD, GRACE_PERIOD_MAX,
  LEADERBOARD_RESET_HOUR, LEADERBOARD_RESET_MINUTE, HOST_INACTIVE_TIMEOUT, PLAYER_SESSION_TIMEOUT,
  analytics, rooms, playerLastSeen,
  buildInitialRoomState, ensureRoom, updatePlayerLastSeen, checkPlayerSessionTimeout,
};
