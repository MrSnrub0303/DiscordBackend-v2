const { getCachedTokenUser, setCachedTokenUser } = require("./tokenCache");

const MONITOR_USERNAMES = (process.env.MONITOR_USERNAMES || "barronh,mclovin111.,joshua667746,grimescene")
  .split(",")
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean);

/**
 * Verify the caller is an authorized monitor user.
 * The username is taken only from a verified Discord access token (Bearer),
 * never from a client-supplied header, since headers can be spoofed by anyone
 * calling the API directly. Token lookups are cached (see tokenCache) so
 * Discord's API is hit at most once per token every 5 minutes.
 */
async function isMonitorAuthorized(req) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (!token) return false;
  const cachedUser = getCachedTokenUser(token);
  if (cachedUser) return MONITOR_USERNAMES.includes((cachedUser.username || "").toLowerCase());
  try {
    const resp = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return false;
    const user = await resp.json();
    setCachedTokenUser(token, user);
    const username = (user.username || "").toLowerCase();
    return MONITOR_USERNAMES.includes(username);
  } catch {
    return false;
  }
}

module.exports = { MONITOR_USERNAMES, isMonitorAuthorized };
