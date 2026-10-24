// Settings come from the environment, or from a JSON file named by COS_BRIDGE_CONFIG (the environment wins).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AGENT = 'cos-bridge/0.1.0';

export function loadConfig(env = process.env) {
  let file = {};
  if (env.COS_BRIDGE_CONFIG) file = JSON.parse(readFileSync(env.COS_BRIDGE_CONFIG, 'utf8'));
  const pick = (k, d) => env[k] ?? file[k] ?? d;
  const num = (k, d) => { const v = Number(pick(k, d)); return Number.isFinite(v) && v > 0 ? v : d; };
  const c = {
    server: String(pick('COS_SERVER', '')).replace(/\/+$/, ''),
    token: String(pick('COS_BRIDGE_TOKEN', '')),
    stateDir: resolve(String(pick('COS_STATE_DIR', './state'))),
    helloEveryMs: num('COS_HELLO_EVERY_MS', 300_000),     // the device list (and passwords) again
    tasksEveryMs: num('COS_TASKS_EVERY_MS', 3_000),       // jobs from the server
    eventsEveryMs: num('COS_EVENTS_EVERY_MS', 3_000),     // the devices' new punches
    flushEveryMs: num('COS_FLUSH_EVERY_MS', 2_000),       // punches waiting to be sent
    healthEveryMs: num('COS_HEALTH_EVERY_MS', 60_000),
    // which punches carry the device's snapshot: "refused" (refusals and people the platform does not know), "all", or "none"
    eventPhotos: String(pick('COS_EVENT_PHOTOS', 'refused')),
    // a device on https: its own (self-signed) certificate is pinned the first time; true = only a certificate a CA vouches for
    deviceTlsStrict: String(pick('COS_DEVICE_TLS_STRICT', 'false')) === 'true',
    // event codes of the device's firmware, if they differ (comma separated minor codes)
    passMinors: list(pick('COS_PASS_MINORS', '')),
    failMinors: list(pick('COS_FAIL_MINORS', '')),
  };
  if (!c.server) throw new Error('COS_SERVER is not set (the CommunityOS address, e.g. https://api.example.org)');
  if (!/^https?:\/\//.test(c.server)) throw new Error('COS_SERVER must start with https:// (or http:// for a test server)');
  if (!c.token.startsWith('cosb_')) throw new Error('COS_BRIDGE_TOKEN is not set (made in CommunityOS: On site -> Devices -> Bridges)');
  return c;
}

function list(v) { return String(v || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0); }
