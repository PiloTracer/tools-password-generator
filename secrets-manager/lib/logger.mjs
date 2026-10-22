const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/**
 * Minimal structured logger. Every line is a single JSON object so container
 * logs stay machine readable.
 *
 * @param {string} [level]
 * @param {Record<string, unknown>} [base]
 */
export function createLogger(level = "info", base = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;

  function emit(levelName, message, extra) {
    if (LEVELS[levelName] < threshold) {
      return;
    }
    const line = {
      ts: new Date().toISOString(),
      level: levelName,
      service: "secrets-manager",
      msg: message,
      ...base,
      ...(extra || {}),
    };
    let serialized;
    try {
      serialized = JSON.stringify(line);
    } catch {
      serialized = JSON.stringify({ ts: line.ts, level: levelName, msg: message });
    }
    if (levelName === "error") {
      console.error(serialized);
    } else if (levelName === "warn") {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }
  }

  return {
    level,
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
    child: (extra) => createLogger(level, { ...base, ...extra }),
  };
}
