// Cache Discord token validation results to avoid hitting discord.com/api/users/@me
// on every socket.io connection/reconnection (e.g. network blips).
// TTL of 5 minutes — tokens are valid for much longer, so this is safe.
const TOKEN_VALIDATION_TTL_MS = 5 * 60 * 1000;
const tokenValidationCache = new Map();

const getCachedTokenUser = (token) => {
  const entry = tokenValidationCache.get(token);
  if (entry && Date.now() - entry.timestamp < TOKEN_VALIDATION_TTL_MS) {
    return entry.user;
  }
  tokenValidationCache.delete(token);
  return null;
};

const setCachedTokenUser = (token, user) => {
  tokenValidationCache.set(token, { user, timestamp: Date.now() });
};

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokenValidationCache.entries()) {
    if (now - entry.timestamp > TOKEN_VALIDATION_TTL_MS) {
      tokenValidationCache.delete(token);
    }
  }
}, TOKEN_VALIDATION_TTL_MS).unref(); // don't hold the process open on its own (the HTTP server does that)

module.exports = { getCachedTokenUser, setCachedTokenUser };
