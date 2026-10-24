// One line per event, with the time; no secrets ever (passwords and tokens are not logged).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.COS_LOG_LEVEL || 'info'] ?? 20;

export function setLevel(level) { threshold = LEVELS[level] ?? threshold; }

function write(level, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra))}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export const log = {
  debug: (m, x) => write('debug', m, x),
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x),
};
