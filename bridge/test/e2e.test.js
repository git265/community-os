// End to end without hardware: the bridge between a stand-in CommunityOS (the bridge API, strict about fields like the real one) and
// the DS-K1T344 stand-in. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSimulator } from '../sim/ds-k1t344.js';
import { Bridge } from '../src/bridge.js';
import { Cloud } from '../src/cloud.js';
import { Store } from '../src/store.js';
import { parseChallenge } from '../src/drivers/hikvision/digest.js';
import { setLevel } from '../src/log.js';

setLevel(process.env.COS_LOG_LEVEL || 'error');
const TOKEN = 'cosb_' + 'x'.repeat(43);
const EMP = 'a'.repeat(32), EMP2 = 'b'.repeat(32);
const JPEG = readFileSync(new URL('./face.jpg', import.meta.url)).toString('base64');
const PUNCH_KEYS = ['eventNo', 'at', 'credential', 'employeeNo', 'cardNo', 'result', 'reason', 'attendanceStatus', 'photo', 'raw'];
const HEALTH_KEYS = ['deviceId', 'online', 'serial', 'model', 'firmware', 'clockDriftS', 'enrolledCount', 'lastError'];

function fakeCloud(device) {
  const c = { queue: [], results: [], ledger: new Map(), health: [], down: false, calls: 0, device };
  const server = http.createServer(async (req, res) => {
    c.calls++;
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    if (req.headers['x-bridge-token'] !== TOKEN) return send(403, { title: 'Forbidden', detail: 'Unknown site bridge' });
    const chunks = []; for await (const x of req) chunks.push(x);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v1/bridge/hello') return send(200, { bridgeId: 'b1', name: 'Test bridge', serverTime: new Date().toISOString(), devices: [c.device] });
    if (url.pathname === '/api/v1/bridge/tasks' && req.method === 'GET') { const out = c.queue.splice(0, Number(url.searchParams.get('max') || 10)); return send(200, out); }
    if (url.pathname.startsWith('/api/v1/bridge/tasks/')) {
      assert.deepEqual(Object.keys(body).sort(), ['error', 'ok', 'permanent']);
      c.results.push({ id: url.pathname.split('/').pop(), ...body }); res.writeHead(204); return res.end();
    }
    if (url.pathname === '/api/v1/bridge/events') {
      if (c.down) return send(503, { title: 'Service Unavailable' });
      let added = 0;
      for (const p of body.events) {
        for (const k of Object.keys(p)) assert.ok(PUNCH_KEYS.includes(k), `unknown punch field ${k}`);
        const key = body.deviceId + ':' + p.eventNo;
        if (!c.ledger.has(key)) { c.ledger.set(key, p); added++; }
      }
      return send(200, { received: body.events.length, added, counted: added, flagged: 0 });
    }
    if (url.pathname === '/api/v1/bridge/health') {
      for (const h of body.devices) assert.deepEqual(Object.keys(h).sort(), [...HEALTH_KEYS].sort());
      c.health.push(...body.devices); res.writeHead(204); return res.end();
    }
    send(404, {});
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ ...c, state: c, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((d) => { server.closeAllConnections?.(); server.close(() => d()); }) })));
}
const until = async (what, cond, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); } assert.fail(`timed out waiting for ${what}`); };
function setup(sim, password = 'Passw0rd!') {
  return { id: 'dev-1', name: 'Main gate face', gate: 'Main gate', kind: 'Face terminal', driver: 'hikvision-isapi', direction: 'Both', capabilities: ['Face', 'Card', 'QR', 'Relay'],
    host: '127.0.0.1', port: sim.port, useTls: false, username: 'admin', password, doorNo: 1, lastEventNo: 0 };
}
function newBridge(cloud, dir) {
  const cfg = { server: cloud.url, token: TOKEN, stateDir: dir, helloEveryMs: 60_000, tasksEveryMs: 40, eventsEveryMs: 40, flushEveryMs: 40, healthEveryMs: 200, eventPhotos: 'refused', passMinors: [], failMinors: [] };
  return new Bridge(cfg, { cloud: new Cloud(cfg), store: new Store(dir) });
}

test('puts people on the device, reads their punches, opens the door, sets the clock, takes them off', async () => {
  const sim = await createSimulator({ driftSeconds: 45 });
  const cloud = await fakeCloud(setup(sim));
  const dir = mkdtempSync(join(tmpdir(), 'cosb-'));
  const bridge = newBridge(cloud, dir);
  try {
    cloud.state.queue.push(
      { id: 't1', deviceId: 'dev-1', kind: 'enrol', employeeNo: EMP, name: 'Savitri', validFrom: '2026-01-01', validTo: null, cardNo: '100200300', faceJpegBase64: JPEG, attempts: 1 },
      { id: 't2', deviceId: 'dev-1', kind: 'enrol', employeeNo: EMP2, name: 'Shankar Guard', validFrom: null, validTo: null, cardNo: null, faceJpegBase64: JPEG, attempts: 1 });
    await bridge.start();
    await until('both enrolled', () => cloud.state.results.length === 2);
    assert.deepEqual(cloud.state.results.map((r) => r.ok), [true, true]);
    const st = sim.state();
    assert.deepEqual(st.users.map((u) => u.employeeNo).sort(), [EMP, EMP2]);
    assert.equal(st.cards['100200300'], EMP); assert.deepEqual(st.faces.sort(), [EMP, EMP2]);
    assert.equal(st.users.find((u) => u.employeeNo === EMP).Valid.beginTime, '2026-01-01T00:00:00');
    // enrolled again with a new card: modified in place, the old card gone
    cloud.state.queue.push({ id: 't3', deviceId: 'dev-1', kind: 'enrol', employeeNo: EMP, name: 'Savitri', validFrom: '2026-01-01', validTo: null, cardNo: '100200301', faceJpegBase64: JPEG, attempts: 1 });
    await until('re-enrolled', () => cloud.state.results.length === 3);
    assert.equal(cloud.state.results[2].ok, true, cloud.state.results[2].error);
    assert.equal(sim.state().cards['100200301'], EMP); assert.equal(sim.state().cards['100200300'], undefined);
    // punches: a face, a card, an unknown face (with the device's snapshot), a door event that is not a punch
    sim.present({ face: EMP }); sim.present({ card: '100200301', attendanceStatus: 'checkOut' }); sim.present({ face: null });
    cloud.state.queue.push({ id: 't4', deviceId: 'dev-1', kind: 'open', employeeNo: null, note: 'Ambulance', attempts: 1 });
    await until('three punches in CommunityOS', () => cloud.state.ledger.size === 3);
    const got = [...cloud.state.ledger.values()].sort((a, b) => a.eventNo - b.eventNo);
    assert.deepEqual(got.map((p) => [p.credential, p.result, p.employeeNo]), [['Face', 'Allowed', EMP], ['Card', 'Allowed', EMP], ['Face', 'Refused', null]]);
    assert.equal(got[1].cardNo, '100200301'); assert.equal(got[1].attendanceStatus, 'checkOut');
    assert.equal(got[0].photo, null, 'a known face passing carries no snapshot'); assert.match(got[2].photo, /^data:image\/jpeg;base64,/, 'a refusal does');
    assert.equal(got[2].reason, 'Face not recognised');
    assert.ok(Math.abs(Date.parse(got[0].at) - Date.now()) < 120_000, 'the device time, read with its zone');
    await until('door opened', () => sim.state().opens.length === 1);
    // health: the clock 45 s off -> CommunityOS queues set-time -> set right
    await until('health reported', () => cloud.state.health.length > 0);
    const h = cloud.state.health[0];
    assert.equal(h.online, true); assert.equal(h.model, 'DS-K1T344MBWX-QRE1'); assert.equal(h.enrolledCount, 2); assert.ok(h.clockDriftS >= 44 && h.clockDriftS <= 46, String(h.clockDriftS));
    cloud.state.queue.push({ id: 't5', deviceId: 'dev-1', kind: 'set-time', employeeNo: null, note: new Date().toISOString(), attempts: 1 });
    await until('clock set', () => Math.abs(sim.state().clockDriftS) <= 1);
    // taken off
    cloud.state.queue.push({ id: 't6', deviceId: 'dev-1', kind: 'remove', employeeNo: EMP2, attempts: 1 }, { id: 't7', deviceId: 'dev-1', kind: 'remove', employeeNo: 'c'.repeat(32), attempts: 1 });
    await until('removed', () => cloud.state.results.filter((r) => ['t6', 't7'].includes(r.id)).length === 2);
    assert.ok(cloud.state.results.filter((r) => ['t6', 't7'].includes(r.id)).every((r) => r.ok), 'someone not on the device is already off it');
    assert.deepEqual(sim.state().users.map((u) => u.employeeNo), [EMP]); assert.deepEqual(sim.state().faces, [EMP]);
    // a face the device rejects: failed for good (not retried)
    cloud.state.queue.push({ id: 't8', deviceId: 'dev-1', kind: 'enrol', employeeNo: EMP2, name: 'Bad photo', validFrom: null, validTo: null, cardNo: null, faceJpegBase64: Buffer.from('not a jpeg').toString('base64'), attempts: 1 });
    await until('bad photo reported', () => cloud.state.results.some((r) => r.id === 't8'));
    const t8 = cloud.state.results.find((r) => r.id === 't8');
    assert.equal(t8.ok, false); assert.equal(t8.permanent, true); assert.match(t8.error, /invalidPicture/);
  } finally { await bridge.stop(); await sim.close(); await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('keeps the punches while CommunityOS is away, across a restart, and sends each once', async () => {
  const sim = await createSimulator();
  const cloud = await fakeCloud(setup(sim));
  const dir = mkdtempSync(join(tmpdir(), 'cosb-'));
  cloud.state.queue.push({ id: 't1', deviceId: 'dev-1', kind: 'enrol', employeeNo: EMP, name: 'Savitri', validFrom: null, validTo: null, cardNo: '555', faceJpegBase64: JPEG, attempts: 1 });
  let bridge = newBridge(cloud, dir);
  try {
    await bridge.start();
    await until('enrolled', () => cloud.state.results.length === 1);
    cloud.state.down = true;
    for (let i = 0; i < 5; i++) sim.present({ face: EMP });
    await until('kept on disk', () => { try { return JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')).length === 5; } catch { return false; } });
    assert.equal(cloud.state.ledger.size, 0);
    await bridge.stop();                                                  // the gate PC restarts
    bridge = newBridge(cloud, dir);
    cloud.state.down = false;
    await bridge.start();
    await until('all five in CommunityOS', () => cloud.state.ledger.size === 5);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(cloud.state.ledger.size, 5, 'nothing twice');
    assert.equal(JSON.parse(readFileSync(join(dir, 'outbox.json'), 'utf8')).length, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, 'cursors.json'), 'utf8'))['dev-1'].no, 5);
  } finally { await bridge.stop(); await sim.close(); await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('a wrong device password is tried twice, then left alone (the device never locks)', async () => {
  const sim = await createSimulator();
  const cloud = await fakeCloud(setup(sim, 'wrong-password'));
  const dir = mkdtempSync(join(tmpdir(), 'cosb-'));
  const bridge = newBridge(cloud, dir);
  try {
    cloud.state.queue.push({ id: 't1', deviceId: 'dev-1', kind: 'enrol', employeeNo: EMP, name: 'Savitri', validFrom: null, validTo: null, cardNo: null, faceJpegBase64: JPEG, attempts: 1 });
    await bridge.start();
    await until('the job reported', () => cloud.state.results.length === 1);
    await new Promise((r) => setTimeout(r, 600));                          // health and event polls keep coming
    assert.equal(sim.state().logins.refused, 2); assert.equal(sim.state().locked, false);
    assert.equal(cloud.state.results[0].ok, false); assert.equal(cloud.state.results[0].permanent, false, 'tried again once the password is fixed');
    await until('health says why', () => cloud.state.health.some((h) => !h.online && /refused|paused/.test(h.lastError)));
    assert.equal(sim.state().logins.refused, 2, 'still only two');
    // the password fixed in CommunityOS: the next hello lifts the pause
    cloud.state.device = setup(sim);
    await bridge.hello();
    await until('online again', () => cloud.state.health.at(-1)?.online === true);
  } finally { await bridge.stop(); await sim.close(); await cloud.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('reads a Digest challenge among several WWW-Authenticate headers', () => {
  const ch = parseChallenge(['Basic realm="x"', 'Digest qop="auth", realm="DS-K1T344", nonce="abc123", stale="FALSE", opaque="o"']);
  assert.deepEqual(ch, { realm: 'DS-K1T344', nonce: 'abc123', qop: 'auth', opaque: 'o', algorithm: undefined, stale: false });
  assert.equal(parseChallenge('Basic realm="x"'), null);
});
