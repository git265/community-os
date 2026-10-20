// The "golden" answers the Java amenity messages and scheduler (AmenityNotifier, AmenityReports, AmenityScheduler) are tested against.
//
//   TZ=Asia/Kolkata node --import ./register-hooks.mjs test/gen-amenity-notify-golden.mjs    (from backend/contract-server; or: npm run gen:amenity-notify)
//
// It builds many small random communities (templates, recipients, users, bookings) and asks the REAL JavaScript (src/lib/amenityServer.js) what it queues and
// changes: the messages of every booking event, what a booking action posts AND tells, the daily and summary reports, and a pass of the scheduler (release
// unpaid, complete, remind, report) at times chosen to sit on the edges of the day in India (a Java port that read the clock in UTC would be caught).
// AmenityNotifyConformanceCheck replays them in Java and names every place the answer differs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let CURRENT = Date.parse('2026-10-19T12:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(CURRENT); }
  static now() { return CURRENT; }
};
const realRandom = Math.random;

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/test/resources/amenity-notify/golden.json.gz');
const { setServerAdapter } = await import(path.join(SRC, 'storage/index.js'));
const server = await import(path.join(SRC, 'amenityServer.js'));
const engine = await import(path.join(SRC, 'amenityEngine.js'));
// (the browser's window only after the modules are loaded: some of them take the presence of a window to mean they run in a page)
globalThis.window = { dispatchEvent() { return true; }, addEventListener() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

let seed = 20261020;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
Math.random = rnd;
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

const EVENTS = engine.EVENTS.map((e) => e.id);
const BOOKING = engine.BOOKING_EVENTS;
const NAMES = ['Clubhouse', 'Tennis court', 'Pool', 'Party lawn'];
const UNITS = ['A-101', 'A-102', 'B-201', 'C-301'];
const SLOTS = ['06:00 - 07:00', '17:30 - 18:30', '10:00 - 11:00', '09:30 - 10:30', '9:30 - 10:30', 'Full day', '18:00 - 19:00', 'Evening', U, 'Morning', 'afternoon', 'Zulu', 'zebra', 'Noon-1', 'noon 1', '_late', '10:00-11:00', '10:00 11:00', 'Noon', 'noon'];
const WORDS = ['Hello', 'Dear resident', 'Thanks', '— team', '·', 'Rules apply.', 'Pay at the office'];
const TOKENS = ['{{owner}}', '{{ booking_no }}', '{{AMENITY}}', '{{date}}', '{{slot}}', '{{unit}}', '{{fee}}', '{{gst}}', '{{total}}', '{{refund}}', '{{reason}}', '{{nope}}', '{{tax_breakdown}}', '{{payment_mode}}',
  '{{refund_pct}}', '{{community}}', '{{report}}', '{{report_period}}', '{{gstin}}', '{{rate}}', '{{pay_by}}', '{{ owner}}', '{{owner }}', '{owner}', '{{}}', '{{1x}}', '{{taxable}}', '{{gst_rate}}', '{{tax_name}}',
  '{{deposit}}', '{{deposit_returned}}', '{{retained}}', '{{payment_status}}'];
const body = () => Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => (chance(0.65) ? pick(TOKENS) : pick(WORDS))).join(pick(['\n', ' ', ' · ']));

function iso(ms) { return new RealDate(ms).toISOString(); }

function settingsRow() {
  const recips = () => pick([U, [], [{ channel: 'Email', target: 'sec@x.in', label: 'Secretary' }, { channel: 'WhatsApp', target: '+919800000001' }, { channel: 'SMS', target: '+919800000002', label: 'Guard' }],
    [{ channel: 'Email', target: '' }, { channel: 'WhatsApp', target: '+919800000003', label: '' }, { channel: 'Fax', target: 'x' }], 'nobody', [{ channel: 'WhatsApp', target: '+919800000004', label: 'FM' }, { channel: 'Email', target: 'fm@x.in' }]]);
  return { id: 'AS1', shortId: 'AMS-0001', defaultGstRate: pick([U, 18]), notifyOwner: pick([U, true, true, false]), notifyAdmin: pick([U, true, true, false]), adminRecipients: recips(), reportRecipients: recips(),
    inAppRoleIds: pick([U, [], ['facility_manager'], ['x', 'y']]), paymentDueHours: pick([U, 0, 1, 24, 48, 48, '12', 'abc', -5]), reminderOn: pick([U, true, true, false]), dailyReport: pick([U, true, true, false]),
    dailyReportTime: pick([U, '20:00', '06:00', '17:30', '23:59', '', 5]), summaryReport: pick([U, 'Off', 'Weekly', 'Weekly', 'Monthly', 'Monthly']), lastDailyRun: pick([U, U, '2026-10-19', '2026-10-18']), lastSummaryRun: pick([U, U, '2026-10-19', '2026-10-01']) };
}
function templatesFor() {
  const r = rnd();
  if (r < 0.1) return [];
  if (r < 0.55) return strip(engine.defaultTemplates()).map((t, i) => ({ ...t, shortId: `NTM-${String(i + 1).padStart(4, '0')}`, ...(chance(0.08) ? { enabled: false } : {}) }));
  return Array.from({ length: 6 + Math.floor(rnd() * 9) }, (_, i) => ({ id: `T${i}`, event: pick([...EVENTS, ...EVENTS, 'unknown']), channel: pick(['Email', 'SMS', 'WhatsApp', 'WhatsApp', 'Telegram']), audience: pick(['Owner', 'Admin', 'Owner', 'Admin', 'Everyone']),
    enabled: pick([U, U, true, false]), subject: pick([U, '', 'Hello {{owner}}', 'S {{booking_no}} {{report_period}}', '{{community}}']), body: pick([body(), body(), body(), U, '']) }));
}
function booking(i, now) {
  const t0 = new RealDate(now).toISOString().slice(0, 10);
  const day = (n) => { const x = new RealDate(`${t0}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const fee = pick([0, 500, 1000, 1180, 2500, 12345.5, '1200']);
  const base = pick([U, Math.round(fee / 1.18) || 0, 1000, 847.46, '500']);
  const dep = pick([0, 0, 1000, 2500]);
  const unit = pick(UNITS);
  const created = pick([now - 3600e3, now - 30 * 3600e3, now - 47 * 3600e3, now - 48 * 3600e3, now - 48 * 3600e3 - 1, now - 49 * 3600e3, now - 100 * 3600e3, now - 1000 * 3600e3, U]);
  const status = pick(['Confirmed', 'Confirmed', 'Pending payment', 'Pending payment', 'Cancelled', 'Completed']);
  const paymentStatus = status === 'Pending payment' ? pick(['Pending', 'Pending', 'Paid']) : pick(['Paid', 'Paid', 'Pending', 'Not required', 'Cancelled', 'Refund due', U]);
  const dayPaid = pick([t0, day(-1), day(-3), day(-10), U]);
  const b = {
    id: `B${i}`, shortId: pick([`BKG-000${i + 1}`, `BKG-000${i + 1}`, U]), amenity: pick([...NAMES, U, 7]), date: pick([day(-3), day(-1), day(0), day(0), day(1), day(1), day(2), day(9), U, 'tomorrow']), slot: pick(SLOTS), unit,
    status, paymentStatus, paymentMode: pick(['UPI', 'Card', 'Cash', 'Cheque', 'Unit credit', U, '']), feeTotal: fee, baseAmount: base, gstAmount: pick([U, 180, 152.54, 0, '90']), gstRate: pick([U, 0, 18, 5, 12, 28, '18', null]),
    gstMode: pick([U, 'Exclusive', 'Inclusive', 'Inclusive', null]), rate: pick([U, 500, 1000, 12.5]), depositAmount: dep, totalPayable: pick([fee + dep, U, 1180, 0, 2500]), creditApplied: pick([0, 0, 0, 100, 500, '250']),
    refundAmount: pick([0, 500, 1000, 2500, 590.5, U]), refundPct: pick([U, 0, 50, 100, null, '75']), retainedAmount: pick([0, 250, U]), depositReturned: pick([0, 500, 1000, 2500, U]), cancelReason: pick([U, '', 'Rain', 'Moved']),
    refundStatus: pick([U, 'None', 'Refund due', 'Credited to unit account', 'Refunded']), depositStatus: pick([U, 'None', 'Held', 'Held', 'Released']), refundPayoutMode: pick([U, 'Cash', 'UPI']), refundRef: pick([U, 'UTR1']),
    depositRefundStatus: pick([U, 'Due', 'Credited to unit account', 'Paid']), depositRefundMode: pick([U, 'Cash', 'UPI']), depositRefundRef: pick([U, 'R9']), depositDeduction: pick([U, 0, 300, 250.5]),
    depositDeductionReason: pick([U, '', 'broken <b>glass</b>&nbsp;pane', '  chipped   tile  ', 'plain']), paidAt: dayPaid && `${dayPaid}T08:00:00.000Z`, cancelledAt: chance(0.3) ? `${pick([t0, day(-1), day(-2)])}T05:00:00.000Z` : U,
    depositSettledAt: pick([U, t0, day(-1), `${day(-2)}T03:00:00.000Z`]), chargeWaived: pick([U, true, false]), waivedAmount: pick([U, 500, '300']), recordCreatedAt: created === U ? U : iso(created),
    reminderSent: pick([U, U, true, false]), recVersion: pick([U, 1, 3, '2']),
  };
  return strip(b);
}
function world(now) {
  const props = UNITS.map((u) => ({ id: `P-${u}`, unit: u, owner: pick([U, '', 'Mr Rao', 'Mrs Shah']), ownerPhone: pick([U, '', '+919811111111']) }));
  const users = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => ({ id: `U${i}`, name: pick(['Asha', 'Ravi', U, '', 123]), email: pick([U, '', 'a@x.in']), phone: pick([U, '', '+919822222222', '98']),
    status: pick([U, 'Active', 'Inactive']), units: pick([[pick(UNITS)], [pick(UNITS), pick(UNITS)], [], U, 'A-101,B-201', pick(UNITS)]) }));
  const merge = chance(0.8) ? [{ id: 'M0', token: '{{OTHER}}', defaultValue: 'x' }, { id: 'M1', token: '{{SOCIETY_NAME}}', defaultValue: pick(['La Paloma', 'Green Acres', '', U, 42]) }] : [{ id: 'M0', token: '{{OTHER}}', defaultValue: 'x' }];
  const out = chance(0.3) ? [{ id: 'O1', shortId: 'OUT-0007', event: 'x', status: 'Sent' }, { id: 'O2', shortId: 'OUT-0003', event: 'y', status: 'Sent' }] : [];
  return strip({
    amenitySettings: chance(0.9) ? [settingsRow()] : [], notificationTemplates: templatesFor(), users, properties: props, mergeFields: merge, notificationOutbox: out,
    amenities: Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => booking(i, now)), unitCredits: chance(0.3) ? [{ id: 'UC1', shortId: 'UCR-0004', unit: 'A-101', type: 'Credit', amount: 100 }] : [],
    bankAccounts: chance(0.5) ? [{ id: 'BA1', name: 'ICICI Savings' }] : [], ledger: [], notifications: [],
  });
}

const TIMES = [
  '2026-10-19T12:00:00.000Z',   // Monday, 17:30 in India
  '2026-10-19T14:45:00.000Z',   // 20:15 in India: after the report time
  '2026-10-19T14:30:00.000Z',   // 20:00 sharp
  '2026-10-19T14:29:59.000Z',   // one second before 20:00
  '2026-10-19T18:29:00.000Z',   // 23:59
  '2026-10-20T00:30:00.000Z',   // 06:00 on the 20th in India, still the 19th... no: the 20th in both
  '2026-10-25T20:00:00.000Z',   // Monday 26th 01:30 in India, the 25th in UTC
  '2026-10-31T19:00:00.000Z',   // Sunday 1 Nov 00:30 in India, 31 Oct in UTC
  '2026-11-01T10:00:00.000Z',   // 1 Nov in both
  '2026-11-02T03:00:00.000Z',   // Monday 08:30
  '2026-12-31T20:00:00.000Z',   // 1 Jan in India
];
const TRACK = ['ledger', 'unitCredits', 'notificationOutbox', 'notifications', 'notificationTemplates', 'amenitySettings', 'amenities'];
const cleanRow = (r) => { const { id, ...rest } = r; return rest; };
const snapshot = () => Object.fromEntries(TRACK.map((c) => [c, new Map((DB[c] || []).map((r) => [r.id, JSON.stringify(r)]))]));
/** What a call changed: rows that were there before and are different now (by id), and the rows added (in order, without their random id). */
function diff(before) {
  const changed = {}, created = {};
  for (const c of TRACK) {
    const rows = DB[c] || [];
    changed[c] = Object.fromEntries(rows.filter((r) => before[c].has(r.id) && before[c].get(r.id) !== JSON.stringify(r)).map((r) => [r.id, strip(r)]));
    created[c] = strip(rows.filter((r) => !before[c].has(r.id)).map(cleanRow));
  }
  return { changed, created };
}

const cases = [];
const kinds = new Map();
const tick = (k) => kinds.set(k, (kinds.get(k) || 0) + 1);
const ACTIONS = ['create', 'create', 'receive_payment', 'cancel', 'cancel', 'refund_to_credit', 'mark_refund_paid', 'settle_deposit', 'settle_deposit', 'mark_deposit_paid', 'complete', 'bogus'];
let crashes = 0;

for (let wi = 0; wi < 500; wi++) {
  const nowIso = pick(TIMES);
  CURRENT = Date.parse(nowIso);
  const w = world(CURRENT);
  const ops = [];
  const run = async (op, fn) => {
    DB = structuredClone(w);
    const before = snapshot();
    let ret = null;
    try { ret = await fn(); } catch (e) { crashes++; return; }   // (the JavaScript could not do it in this stand-in: nothing to compare)
    op.expected = { ret: ret === undefined ? null : strip(ret), ...diff(before) };
    ops.push(op);
  };
  const settingsOf = () => w.amenitySettings[0] || {};
  for (let i = 0; i < 10; i++) {
    const b = pick(w.amenities);
    const event = chance(0.9) ? pick(BOOKING) : pick(EVENTS);
    const extra = chance(0.2) ? { refund: pick(['₹5', '']) } : {};
    const reason = chance(0.4) ? pick(['', 'Deducted ₹300: glass', 'x']) : '';
    await run({ kind: 'notify', event, booking: b, reason, extra: strip(extra) }, () => server.amenityNotify(event, structuredClone(b), { settings: settingsOf() }, { reason, extra }));
    tick(`notify ${event}`);
  }
  for (let i = 0; i < 8; i++) {
    const next = structuredClone(pick(w.amenities));
    const action = pick(ACTIONS);
    await run({ kind: 'post', next, action }, () => server.amenityPostWrite({ old: null, next: structuredClone(next), action }));
    tick(`post ${action}`);
  }
  for (const kind of ['daily', 'daily', 'summary', 'summary']) {
    const opts = kind === 'summary' && chance(0.5) ? { from: pick(['2026-10-01', '2026-10-15', U]), to: pick(['2026-10-19', '2026-11-30', U]) } : {};
    await run({ kind: 'report', reportKind: kind, from: opts.from ?? null, to: opts.to ?? null }, () => server.sendReport(kind, opts));
    tick(`report ${kind}`);
  }
  for (let i = 0; i < 2; i++) {
    await run({ kind: 'run' }, async () => ({ ...(await server.runAmenityScheduler(new RealDate(CURRENT))) }));
    tick('run');
  }
  cases.push({ now: nowIso, world: w, ops });
}
Math.random = realRandom;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify({ cases }))));
const total = cases.reduce((n, c) => n + c.ops.length, 0);
console.log(`wrote ${total} operations in ${cases.length} communities (${crashes} skipped: the JavaScript could not run them here)`);
for (const [k, v] of [...kinds].sort()) console.log(String(v).padStart(6), k);
