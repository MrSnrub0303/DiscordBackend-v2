const { app, io } = require("../app");
const { MAX_TIME } = require("../config");
const questions = require("../questions.json");
const StorageService = require("../services/StorageService");
const { GRACE_PERIOD_MAX, rooms, buildInitialRoomState, ensureRoom, updatePlayerLastSeen, checkPlayerSessionTimeout } = require("./state");
const { calculatePointsFromTime } = require("./scoring");

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

const gameEventHandler = (req, res) => {
  const { event, data } = req.body;

  try {
    if (data.roomId && !rooms[data.roomId]) {
      rooms[data.roomId] = buildInitialRoomState();
    }

    switch (event) {
      case "start_question":
        if (data.roomId && rooms[data.roomId]) {
          const room = rooms[data.roomId];

          // FIRST: Check if there's already an active question in progress
          // If so, just return it - don't reset scores or start a new question
          if (!data.forceNew && room.currentQuestion) {
            const now = Date.now();
            const questionStartTime = room.questionStartTime || now;
            const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
            const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

            // Case 1: Question is still active (time remaining)
            if (remainingTime > 0 && !room.roundEnded) {
              console.log(`[/game-event start_question] Active question in progress, syncing player ${data.playerId} to current game (${remainingTime}s remaining)`);
              return res.json({
                success: true,
                action: "question_started",
                data: {
                  question: room.currentQuestion,
                  timeLeft: remainingTime,
                  startTime: questionStartTime,
                  showResult: false,
                  selections: room.currentSelections || {},
                  roundEnded: false,
                  hostPlayerId: room.hostPlayerId,
                  scores: room.scores || {},
                  playerNames: room.playerNames || {},
                  synced: true,
                },
              });
            }
            
            // Case 2: Round has ended (showing results) - sync to results screen
            // Only the host can start a new question from results screen
            if (room.roundEnded) {
              const isHost = room.hostPlayerId === data.playerId;
              if (!isHost && room.hostPlayerId) {
                // Non-host player - just sync them to the results screen
                console.log(`[/game-event start_question] Round ended, syncing non-host player ${data.playerId} to results screen`);
                return res.json({
                  success: true,
                  action: "question_started",
                  data: {
                    question: room.currentQuestion,
                    timeLeft: 0,
                    startTime: questionStartTime,
                    showResult: true,
                    selections: room.lastSelections || room.currentSelections || {},
                    roundEnded: true,
                    hostPlayerId: room.hostPlayerId,
                    scores: room.scores || {},
                    playerNames: room.playerNames || {},
                    synced: true,
                  },
                });
              }
              // Host can proceed to start a new question
            }
          }

          // Only reset scores if there's no active question (or forceNew is true)
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

          // Check again for active question after potential stale clearing
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
                scores: room.scores || {},
                synced: true,
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
          const previousPoints = room.currentSelections[data.playerId]?.pointsAwarded || 0;
          
          room.currentSelections[data.playerId] = selection;
          
          console.log(`[/api/game-event select_option] Player ${data.playerId} selected option ${data.optionIndex} in room ${data.roomId}`);
          console.log(`[/api/game-event select_option] Score check: previouslyScored=${previouslyScored}, previousPoints=${previousPoints}, hasQuestion=${!!room.currentQuestion}, correctIndex=${room.currentQuestion?.correctIndex}`);

          // IMMEDIATE SCORE COMPUTATION for correct answers (proxy mode real-time sync)
          // If previously scored correctly but now changing answer, check if we need to revoke points
          if (previouslyScored && previousPoints > 0 && room.currentQuestion) {
            // Check if new answer is wrong - if so, revoke the points
            let newAnswerIsCorrect = false;
            if (data.cardAnswer !== undefined) {
              newAnswerIsCorrect = data.isCorrect === true;
            } else if (data.optionIndex !== undefined) {
              newAnswerIsCorrect = data.optionIndex === room.currentQuestion.correctIndex;
            }
            
            if (!newAnswerIsCorrect) {
              // Revoke the previously awarded points
              const oldScore = room.scores[data.playerId] || 0;
              room.scores[data.playerId] = Math.max(0, oldScore - previousPoints);
              room.currentSelections[data.playerId].scored = false;
              room.currentSelections[data.playerId].pointsAwarded = 0;
              
              if (room.players[data.playerId]) {
                room.players[data.playerId].score = room.scores[data.playerId];
              }
              
              console.log(`[/api/game-event select_option] REVOKED ${previousPoints} points from player ${data.playerId}. Old: ${oldScore}, New: ${room.scores[data.playerId]} (changed to wrong answer)`);
            } else {
              // Still correct, keep the scored flag and points
              room.currentSelections[data.playerId].scored = true;
              room.currentSelections[data.playerId].pointsAwarded = previousPoints;
              console.log(`[/api/game-event select_option] Player changed to different correct answer, keeping ${previousPoints} points`);
            }
          } else if (!previouslyScored && room.currentQuestion) {
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
              room.currentSelections[data.playerId].pointsAwarded = points; // Track points for potential revocation
              
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
};

app.post("/api/game-event", gameEventHandler);
app.post("/game-event", gameEventHandler);

// Player join endpoint - handles session timeout and score reset
const playerJoinHandler = (req, res) => {
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
      // Always reset score to 0 (initialize if not exists)
      room.scores[playerId] = 0;
      if (room.players[playerId]) {
        room.players[playerId].score = 0;
      }
      scoreReset = true;
      
      // Broadcast updated scores to all clients in the room
      if (io) {
        io.to(roomId).emit("room_state", {
          scores: room.scores || {},
          playerNames: room.playerNames || {},
          hostPlayerId: room.hostPlayerId,
        });
      }
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
};

// Discord's URL mapping strips the /api prefix, so the plain path is what runs in production
app.post("/api/player-join", playerJoinHandler);
app.post("/player-join",     playerJoinHandler);

const gameStateHandler = (req, res) => {
  const { roomId } = req.params;
  const { playerId } = req.query; // Optional player ID for tracking

  try {
    // Update player's last seen if playerId provided (used by player-join session timeout)
    if (playerId && roomId) {
      updatePlayerLastSeen(roomId, playerId);
    }

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
};

app.get("/api/game-state/:roomId", gameStateHandler);
app.get("/game-state/:roomId", gameStateHandler);

const startQuestionHandler = (req, res) => {
  const { roomId, forceNew, resetScores, playerId } = req.body;

  if (!roomId) {
    return res.status(400).json({ success: false, error: "Missing roomId" });
  }

  try {
    if (!rooms[roomId]) {
      rooms[roomId] = buildInitialRoomState();
    }

    const room = rooms[roomId];

    // FIRST: Check if there's already an active question in progress
    // If so, just return it - don't reset scores or start a new question
    // This allows players to rejoin without disrupting the game
    if (!forceNew && room.currentQuestion) {
      const now = Date.now();
      const questionStartTime = room.questionStartTime || now;
      const elapsedSeconds = Math.floor((now - questionStartTime) / 1000);
      const remainingTime = Math.max(0, MAX_TIME - elapsedSeconds);

      // Case 1: Question is still active (time remaining)
      if (remainingTime > 0 && !room.roundEnded) {
        console.log(`[/start_question] Active question in progress, syncing player ${playerId} to current game (${remainingTime}s remaining)`);
        return res.json({
          success: true,
          question: room.currentQuestion,
          timeLeft: remainingTime,
          startTime: questionStartTime,
          showResult: false,
          hostPlayerId: room.hostPlayerId,
          scores: room.scores || {},
          playerNames: room.playerNames || {},
          synced: true,
        });
      }
      
      // Case 2: Round has ended (showing results) - sync to results screen
      // Only the host can start a new question from results screen
      if (room.roundEnded) {
        const isHost = room.hostPlayerId === playerId;
        if (!isHost && room.hostPlayerId) {
          // Non-host player - just sync them to the results screen
          console.log(`[/start_question] Round ended, syncing non-host player ${playerId} to results screen`);
          return res.json({
            success: true,
            question: room.currentQuestion,
            timeLeft: 0,
            startTime: questionStartTime,
            showResult: true,
            hostPlayerId: room.hostPlayerId,
            scores: room.scores || {},
            playerNames: room.playerNames || {},
            selections: room.lastSelections || room.currentSelections || {},
            synced: true,
          });
        }
        // Host can proceed to start a new question
      }
    }

    // Only reset scores if there's no active question (or forceNew is true)
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

    // Check again for active question (handles edge case after stale check)
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
        scores: room.scores || {},
        synced: true,
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
};

app.post("/api/start_question", startQuestionHandler);
app.post("/start_question", startQuestionHandler);
