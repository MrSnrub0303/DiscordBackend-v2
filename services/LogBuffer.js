/**
 * LogBuffer — circular in-memory log buffer (max 200 entries).
 * All bot background tasks write here instead of to the terminal,
 * so authorized users can read logs via GET /api/monitor/logs.
 */

const MAX_ENTRIES = 200;

const entries = [];

/**
 * Add a log entry.
 * @param {'info'|'warn'|'error'} level
 * @param {string} category  e.g. 'EventSync', 'StreamNotify', 'Twitch', 'YouTube'
 * @param {string} message
 */
function log(level, category, message) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    category,
    message,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.shift();
  }
  // Also mirror to console so server stdout isn't completely silent
  const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${category}]`;
  if (level === 'error') {
    console.error(prefix, message);
  } else if (level === 'warn') {
    console.warn(prefix, message);
  } else {
    console.log(prefix, message);
  }
}

/** Convenience wrappers */
const info  = (category, message) => log('info',  category, message);
const warn  = (category, message) => log('warn',  category, message);
const error = (category, message) => log('error', category, message);

/** Return a copy of all current entries (newest-last order). */
function getAll() {
  return [...entries];
}

module.exports = { info, warn, error, getAll };
