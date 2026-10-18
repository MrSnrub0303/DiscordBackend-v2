const { MAX_TIME, MAX_POINTS, SCORING_EXPONENT } = require("../config");

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

module.exports = { calculatePointsFromTime };
