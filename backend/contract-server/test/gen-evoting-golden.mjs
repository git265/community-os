// The "golden" answers the Java e-voting rules (com.communityos.evoting) are tested against.
//
//   node --import ./register-hooks.mjs test/gen-evoting-golden.mjs     (from backend/contract-server; or: npm run gen:evoting)
//
// It runs the REAL JavaScript (src/lib/evoting.js: whyCannotVote, requestOtp, verifyOtp, evotingPreWrite) through thousands of short "sessions":
// a ballot and a voter roll, then a sequence of steps (ask for a code, check a code, let time pass, write a ballot / a roll mark / a vote) with
// every answer recorded. Time is a variable the run controls and the random bytes (codes, salts, tokens, receipts) come from a seeded generator,
// so the Java replay (EVotingConformanceCheck) can use the same clock and the same bytes and must give the same code, the same proof, the same
// receipt and the same hash chain, or say exactly where it differs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let NOW = Date.parse('2026-10-19T12:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
};
// seeded random bytes: xorshift32, one byte = bits 8..15 of the state. The Java side uses the same recurrence.
let rs = 1;
const nextByte = () => { rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5; rs |= 0; return (rs >>> 8) & 0xff; };
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: { subtle: webcrypto.subtle, getRandomValues(arr) { const b = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); for (let i = 0; i < b.length; i++) b[i] = nextByte(); return arr; } },
});

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/test/resources/evoting/golden.json.gz');
const { setServerAdapter } = await import(path.join(SRC, 'storage/index.js'));
const ev = await import(path.join(SRC, 'evoting.js'));

let seed = 20261020;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const U = undefined;
const strip = (o) => JSON.parse(JSON.stringify(o));

let DB = {};
const mem = {
  list: async (c) => structuredClone(DB[c] || []),
  get: async (c, id) => structuredClone((DB[c] || []).find((r) => r.id === id) || null),
  put: async (c, row) => { const rows = (DB[c] ||= []); const i = rows.findIndex((r) => r.id === row.id); if (i >= 0) rows[i] = structuredClone(row); else rows.push(structuredClone(row)); return row; },
  putMany: async (c, rows) => { for (const r of rows) await mem.put(c, r); return rows; },
  remove: async (c, id) => { DB[c] = (DB[c] || []).filter((r) => r.id !== id); },
};
setServerAdapter(() => mem);

const DAY = 86400000;
const iso = (ms) => new RealDate(ms).toISOString().slice(0, 10);
const NAMES = ['Asha Rao', 'Bimal Das', 'Chitra Nair', 'Dev Patel', 'Esha Khan', 'Farid Ali'];
const UNITS = ['A-101', 'A-102', 'B-201', 'C-301', 'D-1'];

// ---- one session ---------------------------------------------------------------------------------------------------------------------
async function session(index) {
  DB = {};
  NOW = Date.parse('2026-10-19T12:00:00.000Z') + Math.floor(rnd() * 3) * DAY;
  rs = (index * 2654435761 + 12345) | 0 || 1;
  const startSeed = rs;
  const steps = [];
  let n = 0;
  const id = (p) => `${p}${++n}`;
  const record = async (op) => {
    let out;
    try { out = await exec(op); } catch (e) { out = { threw: String(e.message || e) }; }
    steps.push({ op, out });
    return out;
  };
  async function exec(op) {
    if (op.t === 'adv') { NOW += op.ms; return {}; }
    if (op.t === 'set') { await mem.put(op.collection, structuredClone(op.row)); return {}; }
    if (op.t === 'req') {
      try { const ballot = await mem.get('ballots', op.ballotId); const r = await ev.requestOtp(ballot, op.p); return { code: r.code, phoneLast4: r.phoneLast4 }; } catch (e) { return { err: e.message }; }
    }
    if (op.t === 'ver') {
      try { const ballot = await mem.get('ballots', op.ballotId); return { proof: await ev.verifyOtp(ballot, op.p, op.code) }; } catch (e) { return { err: e.message }; }
    }
    if (op.t === 'wr') {
      const old = op.existingId ? await mem.get(op.collection, op.existingId) : null;
      const r = await ev.evotingPreWrite({ collection: op.collection, record: structuredClone(op.record), old, p: op.p });
      if (r.error) return { error: r.error };
      const patch = r.patch || {};
      const removed = Object.keys(patch).filter((k) => patch[k] === undefined);
      const merged = { ...op.record, ...patch };
      Object.keys(merged).forEach((k) => { if (merged[k] === undefined) delete merged[k]; });
      await mem.put(op.collection, merged);   // as if the write went through, so the next step sees it
      return { patch: strip(patch), removed, merged: strip(merged) };
    }
    throw new Error(`unknown op ${op.t}`);
  }

  // the community and the ballot (ids are unique per session: the module keeps its second-factor Maps for the whole run)
  const BID1 = `bal${index}a`, BID2 = `bal${index}b`;
  const today = iso(NOW);
  const owners = UNITS.map((u, i) => ({ unit: u, name: NAMES[i % NAMES.length] }));
  const rollSize = 2 + Math.floor(rnd() * 4);
  const roll = owners.slice(0, rollSize).map((o, i) => {
    const second = chance(0.3) ? NAMES[(i + 3) % NAMES.length] : null;
    const ow = second ? [o.name, second] : [o.name];
    return { unit: o.unit, owners: ow, phones: Object.fromEntries(ow.map((x, k) => [x, String(1000 + i * 7 + k)])), phoneLast4: chance(0.8) ? String(2000 + i) : '' };
  });
  const open = pick([-5, -1, 0, 0, -2, -3, -1, 1, 3]); const close = pick([0, 1, 1, 2, 10, 3, 5, 0, -2]);
  const baseBallot = {
    id: BID1, title: 'Lift replacement', description: '', kind: pick(['Resolution', 'Choose one']), options: pick([['For', 'Against', 'Abstain'], ['For', 'Against'], ['Yes', 'No', 'Later'], ['1', '2', '3']]),
    opensOn: iso(NOW + open * DAY), closesOn: iso(NOW + close * DAY), quorumPct: pick([0, 25, 50]), passPct: pick([50, 66]), roll, rollHash: await ev.rollHash(roll),
  };
  const status = pick(['Open', 'Open', 'Open', 'Open', 'Open', 'Open', 'Open', 'Open', 'Draft', 'Closed', 'Paused']);
  const ballot = { ...baseBallot, status };
  if (chance(0.15)) ballot.opensOn = U; if (chance(0.1)) ballot.closesOn = 7;
  await record({ t: 'set', collection: 'ballots', row: strip(ballot) });
  await record({ t: 'set', collection: 'ballots', row: strip({ ...baseBallot, id: BID2, status: 'Open', title: 'Other', opensOn: iso(NOW - DAY), closesOn: iso(NOW + 5 * DAY) }) });

  // votes already cast on bal1, with a correct (or damaged) chain
  const prior = Math.floor(rnd() * 4);
  let prev = ev.GENESIS;
  for (let i = 1; i <= prior; i++) {
    const choice = pick(baseBallot.options); const receipt = `rc${i}${index}`.slice(0, 12);
    let row = { id: id('bx'), ballotId: BID1, choice, seq: i, prevHash: prev, receipt, hash: await ev.chainHash(prev, i, receipt, choice) };
    prev = row.hash;
    if (chance(0.06)) row = { ...row, choice: pick(baseBallot.options) + 'x' };
    if (chance(0.04)) row = { ...row, seq: i + 1 };
    if (chance(0.03)) row = { ...row, prevHash: 'bad' };
    await record({ t: 'set', collection: 'ballotBox', row: strip(row) });
  }
  if (chance(0.3)) await record({ t: 'set', collection: 'ballotBox', row: strip({ id: id('bx'), ballotId: BID2, choice: 'For', seq: 1, prevHash: ev.GENESIS, receipt: 'zz', hash: await ev.chainHash(ev.GENESIS, 1, 'zz', 'For') }) });
  const marked = chance(0.25) ? pick(UNITS.slice(0, rollSize)) : null;
  if (marked) await record({ t: 'set', collection: 'voteRoll', row: strip({ id: id('vr'), ballotId: BID1, unit: marked, owner: pick([NAMES[0], '', U]), markedOn: today }) });

  const principals = () => {
    const i = Math.floor(rnd() * Math.min(rollSize, 3));
    const o = roll[i];
    const nm = o.owners[0];
    return pick([
      { roleId: 'owner', unit: o.unit, name: nm }, { roleId: 'owner', unit: o.unit, name: nm }, { roleId: 'owner', unit: o.unit, name: nm }, { roleId: 'owner', unit: o.unit, name: nm },
      { roleId: 'owner', unit: o.unit, name: nm.toUpperCase() }, { roleId: 'owner', unit: o.unit, name: `  ${nm.toLowerCase()} ` }, { roleId: 'owner', unit: o.unit, name: o.owners[o.owners.length - 1] },
      { roleId: 'owner', unit: o.unit, name: 'Mallory' }, { roleId: 'owner', unit: 'Z-9', name: nm }, { roleId: 'owner', unit: '', name: nm }, { roleId: 'owner', unit: o.unit, name: U },
      { roleId: 'tenant', unit: o.unit, name: nm }, { roleId: 'super_admin', unit: '', name: 'Boss' },
    ]);
  };
  const p = principals();
  const pAlt = principals();
  const ballotId = chance(0.93) ? BID1 : BID2;

  // early attempts that must be refused: no proof, no allowance
  if (chance(0.3)) await record({ t: 'wr', collection: 'ballotBox', record: { id: id('bx'), ballotId, choice: baseBallot.options[0] }, p });
  if (chance(0.3)) await record({ t: 'wr', collection: 'voteRoll', record: { id: id('vr'), ballotId, unit: p.unit }, p });

  // the second factor
  let code = null; let proof = null; let other = null;
  const r1 = await record({ t: 'req', p, ballotId });
  if (r1.code) code = r1.code;
  if (chance(0.25)) await record({ t: 'req', p, ballotId });                                            // too soon
  if (chance(0.15)) { const r = await record({ t: 'req', p: pAlt, ballotId }); if (r.code) other = { code: r.code }; }
  if (chance(0.25)) await record({ t: 'adv', ms: pick([10000, 31000, 29999, 30000, 60000]) });
  if (chance(0.2)) await record({ t: 'req', p, ballotId });
  const tries = pick([0, 0, 0, 1, 2, 3, 4]);
  for (let i = 0; i < tries; i++) await record({ t: 'ver', p, ballotId, code: pick(['000000', '123456', '', 'abc', ' 12 ']) });
  if (chance(0.1)) await record({ t: 'adv', ms: pick([299999, 300000, 300001, 400000]) });
  const vcode = chance(0.8) ? code : pick(['111111', code && `${code} `, code && ` ${code}`]);
  const v = await record({ t: 'ver', p, ballotId, code: vcode ?? '000000' });
  if (v.proof) proof = v.proof;
  if (chance(0.15)) { const v2 = await record({ t: 'ver', p, ballotId, code: vcode ?? '000000' }); if (v2.proof && !proof) proof = v2.proof; }
  if (chance(0.1) && other) { const v3 = await record({ t: 'ver', p: pAlt, ballotId, code: other.code }); if (v3.proof) other.proof = v3.proof; }
  if (chance(0.2)) await record({ t: 'adv', ms: pick([60000, 119999, 120000, 120001, 200000]) });

  // the roll mark (uses the proof up), then the vote
  const markWith = pick([proof, proof, proof, proof, proof, other?.proof, 'junk', '', null, 5]);
  const markUnit = chance(0.9) ? p.unit : pick(UNITS);
  const rec = { id: id('vr'), ballotId, unit: markUnit, ...(markWith === null ? {} : { proof: markWith }), ...(chance(0.1) ? { owner: 'Forged', markedOn: '1999-01-01' } : {}) };
  const m1 = await record({ t: 'wr', collection: 'voteRoll', record: rec, p });
  if (chance(0.2)) await record({ t: 'wr', collection: 'voteRoll', record: { ...rec, id: id('vr') }, p });   // the same proof again
  if (chance(0.15) && (m1.merged || chance(0.3))) await record({ t: 'set', collection: 'ballots', row: strip({ ...ballot, status: pick(['Closed', 'Open']) }) });
  const choice = pick([baseBallot.options[0], baseBallot.options[0], baseBallot.options[0], baseBallot.options[1], baseBallot.options[1], baseBallot.options[1], baseBallot.options[2] ?? 'For', 'Maybe', '', U, 3, null]);
  const box = { id: id('bx'), ballotId: chance(0.95) ? ballotId : BID2, ...(choice === U ? {} : { choice }) };
  await record({ t: 'wr', collection: 'ballotBox', record: box, p: chance(0.9) ? p : pAlt });
  if (chance(0.2)) await record({ t: 'wr', collection: 'ballotBox', record: { ...box, id: id('bx') }, p });          // a second vote on the same allowance
  if (chance(0.1)) await record({ t: 'wr', collection: 'ballotBox', record: box, existingId: box.id, p });          // editing a vote
  if (chance(0.1)) await record({ t: 'wr', collection: 'voteRoll', record: rec, existingId: rec.id, p });           // editing a mark
  // a second voter goes through the whole flow: the new vote must link to the one before it in the chain
  if (chance(0.5)) {
    const q = pAlt;
    const a = await record({ t: 'req', p: q, ballotId });
    const b = a.code ? await record({ t: 'ver', p: q, ballotId, code: a.code }) : {};
    const mr = { id: id('vr'), ballotId, unit: q.unit, ...(b.proof ? { proof: b.proof } : {}) };
    await record({ t: 'wr', collection: 'voteRoll', record: mr, p: q });
    await record({ t: 'wr', collection: 'ballotBox', record: { id: id('bx'), ballotId, choice: pick(baseBallot.options) }, p: q });
  }
  if (chance(0.05)) await record({ t: 'wr', collection: 'ballotBox', record: { id: id('bx'), ballotId: `nope${index}`, choice: 'For' }, p });
  if (chance(0.05)) await record({ t: 'wr', collection: 'voteRoll', record: { id: id('vr'), unit: p.unit }, p: null });
  return { seed: startSeed, now: NOW, steps };
}

// ---- ballot writes: opening, editing, closing ------------------------------------------------------------------------------------------
async function lifecycle(index) {
  DB = {};
  NOW = Date.parse('2026-10-19T12:00:00.000Z') + Math.floor(rnd() * 3) * DAY;
  rs = (index * 40503 + 7) | 0 || 1;
  const startSeed = rs;
  const steps = [];
  let n = 0;
  const p = pick([{ roleId: 'super_admin', unit: '', name: 'Boss' }, { roleId: 'owner', unit: 'A-101', name: 'Asha Rao' }, { roleId: 'owner', unit: 'A-101', name: 'Asha Rao' }, { roleId: 'super_admin', unit: '', name: 'Boss' }, null]);
  const roll = [{ unit: 'A-101', owners: ['Asha Rao'], phones: { 'Asha Rao': '1234' }, phoneLast4: '1234' }, { unit: 'B-201', owners: ['Bimal Das'], phones: { 'Bimal Das': '5678' }, phoneLast4: '5678' }];
  const good = await ev.rollHash(roll);
  const mk = async (over = {}) => ({ id: 'b1', title: 'T', description: 'd', kind: 'Resolution', options: ['For', 'Against'], opensOn: '2026-10-19', closesOn: iso(NOW + pick([-1, 0, 1]) * DAY), quorumPct: 20, passPct: 50, roll, rollHash: good, status: 'Draft', ...over });
  const run = async (collection, record, existing) => {
    if (existing) { DB.ballots = [structuredClone(existing)]; } else DB.ballots = [];
    const old = existing ? structuredClone(existing) : null;
    let out;
    try {
      const r = await ev.evotingPreWrite({ collection, record: structuredClone(record), old, p });
      if (r.error) out = { error: r.error };
      else { const patch = r.patch || {}; out = { patch: strip(patch), removed: Object.keys(patch).filter((k) => patch[k] === undefined) }; const merged = { ...record, ...patch }; out.merged = strip(merged); }
    } catch (e) { out = { threw: String(e.message || e) }; }
    return out;
  };
  const setBox = async (rows) => { DB.ballotBox = structuredClone(rows); };
  // build the box (intact or damaged) for the ballot, then try the write
  const rows = []; let prev = ev.GENESIS;
  const votes = Math.floor(rnd() * 4);
  for (let i = 1; i <= votes; i++) { const choice = pick(['For', 'Against']); const receipt = `r${i}`; const h = await ev.chainHash(prev, i, receipt, choice); rows.push({ id: `x${i}`, ballotId: 'b1', choice, seq: i, prevHash: prev, receipt, hash: h }); prev = h; }
  if (rows.length && chance(0.25)) { const k = Math.floor(rnd() * rows.length); const kind = pick(['choice', 'seq', 'prev', 'hash']); if (kind === 'choice') rows[k].choice = 'Tampered'; if (kind === 'seq') rows[k].seq += 5; if (kind === 'prev') rows[k].prevHash = 'x'; if (kind === 'hash') rows[k].hash = 'y'; }
  if (chance(0.3)) rows.push({ id: 'xo', ballotId: 'other', choice: 'For', seq: 1, prevHash: ev.GENESIS, receipt: 'q', hash: 'whatever' });
  const kind = pick(['open', 'open', 'openBad', 'edit', 'close', 'close', 'closed', 'create', 'weird']);
  let record, existing = null;
  if (kind === 'open') { existing = await mk(); record = { ...existing, status: 'Open' }; }
  else if (kind === 'openBad') {
    existing = chance(0.5) ? await mk() : null;
    const base = await mk({ status: 'Open' });
    record = pick([{ ...base, rollHash: 'nope' }, { ...base, roll: [], rollHash: await ev.rollHash([]) }, { ...base, roll: U }, { ...base, options: ['One'] }, { ...base, options: U }, { ...base, roll: [{ ...roll[0], owners: ['X'] }] }, { ...base, rollHash: U }, { ...base, rollHash: 5 }]);
  }
  else if (kind === 'edit') {
    existing = await mk({ status: 'Open', openedAt: iso(NOW) });
    const key = pick(['title', 'description', 'kind', 'options', 'opensOn', 'closesOn', 'quorumPct', 'passPct', 'roll', 'rollHash', 'status', 'other']);
    record = { ...existing };
    if (key === 'other') record.notes = 'x'; else if (key === 'status') record.status = pick(['Open', 'Draft', 'Paused']);
    else if (key === 'options') record.options = ['For', 'Against', 'Abstain']; else if (key === 'roll') record.roll = []; else if (key === 'quorumPct') record.quorumPct = 21; else record[key] = `${existing[key]}!`;
  }
  else if (kind === 'close') { existing = await mk({ status: 'Open', openedAt: iso(NOW) }); record = { ...existing, status: 'Closed' }; await setBox(rows); }
  else if (kind === 'closed') { existing = await mk({ status: 'Closed' }); record = { ...existing, title: pick(['T', 'T2']), status: pick(['Closed', 'Open']) }; }
  else if (kind === 'create') { record = await mk({ status: pick(['Draft', 'Open', 'Closed']) }); }
  else { existing = chance(0.5) ? await mk({ status: pick(['Paused', U, 'weird']) }) : null; record = await mk({ status: pick(['Paused', U, 'Open', 'Closed', 'Draft']) }); }
  if (existing && chance(0.3)) existing = { ...existing, closesOn: pick([iso(NOW), iso(NOW + DAY), iso(NOW - DAY), U, 5]) };
  if (kind === 'close') DB.ballotBox = structuredClone(rows);
  const out = await run('ballots', record, existing);
  steps.push({ op: { t: 'life', existing, record: strip(record), box: kind === 'close' ? rows : [], p }, out });
  return { seed: startSeed, now: NOW, steps };
}

const sessions = [];
const N = Number(process.env.EVOTING_SESSIONS || 2500), M = Number(process.env.EVOTING_LIFECYCLES || 2500);
for (let i = 0; i < N; i++) sessions.push(await session(i + 1));
for (let i = 0; i < M; i++) sessions.push(await lifecycle(i + 1));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const ops = sessions.reduce((a, s) => a + s.steps.length, 0);
fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ sessions }), { level: 9 }));
console.log(`wrote ${sessions.length} sessions, ${ops} steps -> ${OUT}`);
