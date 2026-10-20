// The "golden" answers the Java money guard (com.communityos.security.MoneyGuard) is tested against.
//
//   node --import ./register-hooks.mjs test/gen-moneyguard-golden.mjs        (from backend/contract-server; or: npm run gen:moneyguard)
//
// It builds many small random worlds (tasks, quotations / invoices, releases, ledger rows, with the awkward cases on purpose: missing ids,
// null amounts, amounts as text, half rupees, reversed payments) and asks the REAL JavaScript moneyPreWrite (src/lib/approval/moneyGuard.js)
// what it says to thousands of write attempts. MoneyGuardConformanceCheck replays them in Java and names every place the answer differs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/test/resources/moneyguard/golden.json.gz');
const { moneyPreWrite } = await import(path.join(SRC, 'approval/moneyGuard.js'));

// small seeded random generator: the same corpus every run
let seed = 20261019;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const U = undefined;

const AMOUNTS = [U, null, 0, 0.3, 1.005, 8.345, 0.615, 2.675, -0.4, 100, 250.5, 499.99, 500, 1000, 1000.4, 1000.5, 2500, '2500', 'abc', '', 5000, 12345.678, 123456, 1234567.5, 10000000];
const TICKET_IDS = ['T1', 'T2', 'T3'];
const DOC_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'];
const REL_IDS = ['R1', 'R2', 'R3', 'R4', 'R5'];
const LED_IDS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'];
const NUMS = ['TKT-1', 'TKT-2', 'TKT-3'];
const APPR = [U, 'Approved', 'Approved', 'Rejected', 'Pending'];

const strip = (o) => JSON.parse(JSON.stringify(o)); // undefined fields disappear, exactly what the wire carries

function ticket(i) {
  return { id: chance(0.95) ? TICKET_IDS[i] : U, ticketNumber: chance(0.9) ? NUMS[i] : pick([U, '', null]), status: pick([U, 'Open', 'In Progress', 'In Progress', 'Closed', 'Cancelled', 'Completed']),
    selectedQuotationId: pick([U, null, '', 'Q1', 'Q2', 'Q3', 'Q4', DOC_IDS[Math.floor(rnd() * 6)]]), ecApproval: pick(APPR), treasurerApproval: pick(APPR),
    finalRequired: pick([U, U, true, false]), financial: pick([U, true, true, false]), approvedAmount: pick(AMOUNTS) };
}
function doc() {
  return { id: chance(0.93) ? pick(DOC_IDS) : U, ticketId: chance(0.93) ? pick(TICKET_IDS) : U, kind: pick(['Quotation', 'Invoice', 'Invoice', U, 'Other']), selected: pick([U, U, true, false]), amount: pick(AMOUNTS),
    approvalWaived: pick([U, U, U, true, false]), ecApproval: pick(APPR), finalApproval: pick(APPR), finalRequired: pick([U, U, true, false]), correctionNote: pick([U, '', '  ', 'typo', ' ', ' x ']) };
}
function release() {
  return { id: chance(0.93) ? pick(REL_IDS) : U, ticketId: chance(0.95) ? pick(TICKET_IDS) : pick([U, null, '']), status: pick([U, 'Waiting approval', 'Approved', 'Approved', 'Paid', 'Rejected', 'Cancelled']), amount: pick(AMOUNTS), cancelReason: pick([U, '', ' ', 'wrong vendor']) };
}
function ledgerRow() {
  const r = { id: chance(0.93) ? pick(LED_IDS) : U, type: pick(['Debit', 'Debit', 'Debit', 'Credit', U]), amount: pick(AMOUNTS), tdsAmount: pick([U, U, null, 0, 50, 100.5, '25']), account: pick(['A', 'B', U]) };
  if (chance(0.15)) r.internal = true;
  if (chance(0.2)) r.reversalOf = pick([...LED_IDS, U, null, '']);
  if (chance(0.8)) { r.sourceType = pick(['release', 'invoice', 'task', 'other', U]); r.sourceId = pick([...REL_IDS, ...DOC_IDS, ...TICKET_IDS, U, null]); }
  if (chance(0.4)) r.taskRef = pick([...NUMS, '', null]);
  if (chance(0.1)) r.reconStatus = 'Matched';
  if (chance(0.3)) r.reason = pick(['', ' ', 'wrong payee', ' ﻿']);
  return r;
}
function world() {
  const n = (f, lo, hi) => Array.from({ length: lo + Math.floor(rnd() * (hi - lo + 1)) }, f);
  const tickets = [0, 1, 2].slice(0, 1 + Math.floor(rnd() * 3)).map(ticket);
  return strip({ tickets, quotations: n(doc, 0, 6), releases: n(release, 0, 5), ledger: n(ledgerRow, 0, 8) });
}

// a write attempt: take a row that exists (or build a new one), change a few fields
const MUTATE = {
  releases: () => ({ status: pick([U, 'Waiting approval', 'Approved', 'Paid', 'Rejected', 'Cancelled']), amount: pick(AMOUNTS), ticketId: pick([...TICKET_IDS, U, null, 'T9']), cancelReason: pick([U, '', 'because', ' \t ']), id: pick(['R1', 'R2', 'RX', U]) }),
  ledger: () => ({ type: pick(['Debit', 'Credit', U]), amount: pick(AMOUNTS), tdsAmount: pick([U, null, 0, 50, 100.5]), account: pick(['A', 'B', U]), taskRef: pick([...NUMS, '', null, 'TKT-9', U]), sourceType: pick(['release', 'invoice', 'task', 'other', U]),
    sourceId: pick([...REL_IDS, ...DOC_IDS, ...TICKET_IDS, 'ZZ', U, null]), reversalOf: pick([U, ...LED_IDS, 'LX']), reason: pick([U, '', '  ', 'duplicate', ' ']), internal: pick([U, true, false]), id: pick([...LED_IDS, 'LX', U]) }),
  quotations: () => ({ kind: pick(['Quotation', 'Invoice']), selected: pick([U, true, false]), ecApproval: pick(APPR), finalApproval: pick(APPR), finalRequired: pick([U, true, false]), approvalWaived: pick([U, true, false]), correctionNote: pick([U, '', '  ', 'typo', ' ']), amount: pick(AMOUNTS), ticketId: pick([...TICKET_IDS, U]) }),
  tickets: () => ({ status: pick([U, 'Open', 'In Progress', 'Closed', 'Cancelled']), ecApproval: pick(APPR), treasurerApproval: pick(APPR), finalRequired: pick([U, true, false]), financial: pick([U, true, false]), approvedAmount: pick(AMOUNTS), selectedQuotationId: pick([U, null, 'Q1', 'Q2', 'Q3', 'Q4']) }),
};
const FRESH = { releases: release, ledger: ledgerRow, quotations: doc, tickets: () => ticket(0) };

function probe(w, collection) {
  const rows = w[collection];
  const op = pick(['create', 'update', 'update', 'update', 'delete']);
  const base = rows.length ? strip(pick(rows)) : null;
  if (op === 'create' || !base) {
    const record = strip({ ...FRESH[collection](), ...(chance(0.6) ? MUTATE[collection]() : {}) });
    return { collection, op: 'create', record, old: null };
  }
  if (op === 'delete') return { collection, op, record: base, old: base };
  const k = 1 + Math.floor(rnd() * 3);
  let record = { ...base };
  for (let i = 0; i < k; i++) { const m = MUTATE[collection](); const key = pick(Object.keys(m)); record[key] = m[key]; }
  return { collection, op, record: strip(record), old: base };
}

// A coherent world: tasks that really are approved, invoices that belong to them, releases and payments that link up. The random worlds above
// rarely line up this neatly, so the "already paid", "past the approved amount" and "release is for" branches would hardly ever run.
const AMT = [1.005, 8.345, 100, 200, 300, 500, 600, 800, 1000, 1000.4, 1000.6, 1200, 1500];
function coherentWorld() {
  const a = () => pick(AMT);
  const tickets = [
    { id: 'T1', ticketNumber: 'TKT-1', status: pick(['Open', 'In Progress', 'In Progress', 'Cancelled', 'Closed']), financial: true, selectedQuotationId: 'Q1', ecApproval: 'Approved', treasurerApproval: pick(['Approved', 'Approved', U]), finalRequired: pick([U, U, false]), approvedAmount: pick([U, U, 1000, 1500]) },
    { id: 'T2', ticketNumber: 'TKT-2', status: 'In Progress', financial: pick([true, false]), selectedQuotationId: pick(['Q4', U]), ecApproval: pick(['Approved', U]), treasurerApproval: pick(['Approved', U]) },
  ];
  const docs = [
    { id: 'Q1', ticketId: 'T1', kind: 'Quotation', amount: 1000 },
    { id: 'Q2', ticketId: 'T1', kind: 'Invoice', amount: a(), ecApproval: 'Approved', finalApproval: pick(['Approved', U]), selected: pick([U, true]), approvalWaived: pick([U, U, true]) },
    { id: 'Q3', ticketId: 'T1', kind: 'Invoice', amount: a(), ecApproval: pick(['Approved', U]), finalApproval: U },
    { id: 'Q4', ticketId: 'T2', kind: 'Quotation', amount: a() },
  ].filter(() => chance(0.85));
  const releases = [
    { id: 'R1', ticketId: 'T1', status: pick(['Approved', 'Waiting approval', 'Paid', 'Cancelled']), amount: a() },
    { id: 'R2', ticketId: 'T1', status: pick(['Approved', 'Waiting approval', 'Rejected']), amount: a() },
    { id: 'R3', ticketId: 'T2', status: 'Approved', amount: a() },
  ].filter(() => chance(0.85));
  const ledger = [
    { id: 'L1', type: 'Debit', sourceType: 'release', sourceId: 'R1', taskRef: 'TKT-1', amount: a(), tdsAmount: pick([U, 50]), account: 'A' },
    { id: 'L2', type: 'Debit', sourceType: 'invoice', sourceId: 'Q2', taskRef: 'TKT-1', amount: a(), account: 'A' },
    { id: 'L3', type: 'Debit', sourceType: 'task', sourceId: 'T1', taskRef: 'TKT-1', amount: a(), account: 'B', reconStatus: pick([U, 'Matched']) },
    { id: 'L4', type: 'Credit', reversalOf: 'L2', sourceType: 'invoice', sourceId: 'Q2', amount: a(), account: pick(['A', 'B']), reason: pick(['dup', ''])},
    { id: 'L5', type: 'Debit', taskRef: 'TKT-2', amount: a(), account: 'A' },
    { id: 'L6', type: 'Debit', internal: true, sourceType: 'task', sourceId: 'T1', amount: a(), account: 'A' },
  ].filter(() => chance(0.55));
  return strip({ tickets, quotations: docs, releases, ledger });
}
const COHERENT_MUTATE = {
  releases: () => ({ status: pick(['Waiting approval', 'Approved', 'Paid', 'Cancelled']), amount: a2(), cancelReason: pick([U, 'because']), id: pick(['R1', 'R2', 'R9']), ticketId: pick(['T1', 'T2']) }),
  ledger: () => ({ amount: a2(), sourceType: pick(['release', 'invoice', 'task']), sourceId: pick(['R1', 'R2', 'R3', 'Q2', 'Q3', 'T1', 'T2']), taskRef: pick(['TKT-1', 'TKT-2', U]), type: 'Debit', tdsAmount: pick([U, 50]), reversalOf: pick([U, U, 'L1', 'L2', 'L3', 'L5']), reason: pick(['', 'oops']), account: pick(['A', 'B']), id: pick(['L1', 'L2', 'L3', 'L7', U]) }),
  quotations: () => ({ ecApproval: pick(['Approved', U, 'Rejected']), finalApproval: pick(['Approved', U]), finalRequired: pick([U, false]), approvalWaived: pick([U, true]), correctionNote: pick([U, 'fix']), kind: pick(['Invoice', 'Quotation']) }),
  tickets: () => ({ status: pick(['In Progress', 'Closed', 'Cancelled']), approvedAmount: pick([U, 100, 500, 800, 1000, 1500]), ecApproval: pick(['Approved', U]), treasurerApproval: pick(['Approved', U]), selectedQuotationId: pick(['Q1', 'Q2', U]) }),
};
const a2 = () => pick(AMT);
function coherentProbe(w, collection) {
  const rows = w[collection];
  const op = pick(['create', 'create', 'update', 'update', 'delete']);
  const base = rows.length ? strip(pick(rows)) : null;
  if (op === 'create' || !base) {
    const fresh = { releases: () => ({ ticketId: pick(['T1', 'T2']), status: pick(['Approved', 'Waiting approval']), amount: a2() }), ledger: () => ({ type: 'Debit' }), quotations: () => ({ ticketId: 'T1', kind: 'Invoice' }), tickets: () => ({ id: 'T3' }) }[collection]();
    return { collection, op: 'create', record: strip({ ...fresh, ...COHERENT_MUTATE[collection]() }), old: null };
  }
  if (op === 'delete') return { collection, op, record: base, old: base };
  const record = { ...base };
  const m = COHERENT_MUTATE[collection]();
  for (const key of Object.keys(m).filter(() => chance(0.45))) record[key] = m[key];
  return { collection, op, record: strip(record), old: base };
}

const cases = [];
const answers = new Map();
for (let wi = 0; wi < 400; wi++) {
  const w = world();
  const list = async (c) => strip(w[c] || []);
  const probes = [];
  for (const collection of ['releases', 'ledger', 'quotations', 'tickets']) for (let i = 0; i < 40; i++) {
    const p = probe(w, collection);
    let expected;
    try { expected = await moneyPreWrite({ collection, record: p.record, old: p.old, op: p.op, list }); } catch (e) { continue; } // the JS crashed (a malformed row): the server would answer 500, not a decision
    answers.set(expected, (answers.get(expected) || 0) + 1);
    probes.push({ ...p, expected });
  }
  cases.push({ world: w, probes });
}
for (let wi = 0; wi < 500; wi++) {
  const w = coherentWorld();
  const list = async (c) => strip(w[c] || []);
  const probes = [];
  for (const collection of ['releases', 'ledger', 'quotations', 'tickets']) for (let i = 0; i < 40; i++) {
    const p = coherentProbe(w, collection);
    let expected;
    try { expected = await moneyPreWrite({ collection, record: p.record, old: p.old, op: p.op, list }); } catch (e) { continue; }
    answers.set(expected, (answers.get(expected) || 0) + 1);
    probes.push({ ...p, expected });
  }
  cases.push({ world: w, probes });
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify({ cases }))));
const total = cases.reduce((n, c) => n + c.probes.length, 0);
const blocked = [...answers.entries()].filter(([k]) => k).reduce((n, [, v]) => n + v, 0);
console.log(`wrote ${total} cases in ${cases.length} worlds; ${blocked} refused, ${total - blocked} allowed; ${answers.size} different answers`);
const shapes = new Map();
for (const [k, v] of answers) { const g = k.replace(/₹[\d,]+/g, '₹N').replace(/\d+ releases?/g, 'N release'); shapes.set(g, (shapes.get(g) || 0) + v); }
for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k || '(allowed)');
