const isProd = process.env.NODE_ENV === "production";
const isDebug = process.env.DEBUG === "true";

const SENSITIVE_PATTERNS = [
  /discord\.com/gi,
  /oauth/gi,
  /token/gi,
  /client_id/gi,
  /secret/gi,
  /authorization/gi,
  /bearer/gi,
  /password/gi,
  /key/gi,
];

function sanitizeData(data) {
  if (isProd && !isDebug) {
    if (typeof data === "string") {
      let sanitized = data;
      SENSITIVE_PATTERNS.forEach((pattern) => {
        sanitized = sanitized.replace(pattern, "[REDACTED]");
      });
      return sanitized;
    }

    if (typeof data === "object" && data !== null) {
      const sanitized = {};
      Object.keys(data).forEach((key) => {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey.includes("token") ||
          lowerKey.includes("secret") ||
          lowerKey.includes("password") ||
          lowerKey.includes("auth") ||
          lowerKey.includes("key") ||
          lowerKey.includes("headers")
        ) {
          sanitized[key] = "[REDACTED]";
        } else if (
          lowerKey.includes("id") &&
          typeof data[key] === "string" &&
          data[key].length > 10
        ) {
          sanitized[key] = data[key].substring(0, 4) + "***";
        } else if (Array.isArray(data[key])) {
          sanitized[key] = `[Array with ${data[key].length} items]`;
        } else {
          sanitized[key] = data[key];
        }
      });
      return sanitized;
    }
  }

  return data;
}

const logger = {
  log: (...args) => {
    if (isProd && !isDebug) {
      return;
    }
    const sanitizedArgs = args.map(sanitizeData);
  },

  error: (...args) => {
    const sanitizedArgs = args.map(sanitizeData);
    console.error(...sanitizedArgs);
  },

  warn: (...args) => {
    const sanitizedArgs = args.map(sanitizeData);
    console.warn(...sanitizedArgs);
  },

  info: (...args) => {
    if (isProd && !isDebug) {
      return;
    }
    const sanitizedArgs = args.map(sanitizeData);
    console.info(...sanitizedArgs);
  },

  debug: (...args) => {
    if (isProd && !isDebug) {
      return;
    }
    const sanitizedArgs = args.map(sanitizeData);
  },
};

module.exports = { logger };
