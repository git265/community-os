// The "golden" answers the Java amenity booking rules (com.communityos.amenities) are tested against.
//
//   TZ=Asia/Kolkata node --import ./register-hooks.mjs test/gen-amenity-golden.mjs    (from backend/contract-server; or: npm run gen:amenity)
//
// It builds many small random communities (amenities, bookings, unit credits, add-on items, dues ...) and asks the REAL JavaScript
// (src/lib/amenityServer.js: amenityPreWrite and amenityPostWrite) what it does with thousands of booking attempts and every booking action. The
// run uses a non-UTC time zone (India) on purpose: "10:00" on a booking is local time, so a Java port that quietly assumed UTC would be caught.
// AmenityConformanceCheck replays them in Java and names every place the answer differs.
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXED = Date.parse('2026-10-19T12:00:00.000Z');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(FIXED); }
  static now() { return FIXED; }
};
const realRandom = Math.random;

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/test/resources/amenity/golden.json.gz');
const { setServerAdapter } = await import(path.join(SRC, 'storage/index.js'));
const server = await import(path.join(SRC, 'amenityServer.js'));

// a seeded random generator: the same corpus every run
let seed = 20261019;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
Math.random = rnd;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const U = undefined;
const strip = (o) => JSON.parse(JSON.stringify(o));

// ---- the stand-in store the JavaScript runs against ----------------------------------------------------------------------------------
let DB = {};
const mem = {
  list: async (c) => structuredClone(DB[c] || []),
  get: async (c, id) => structuredClone((DB[c] || []).find((r) => r.id === id) || null),
  put: async (c, row) => { const rows = (DB[c] ||= []); const i = rows.findIndex((r) => r.id === row.id); if (i >= 0) rows[i] = structuredClone(row); else rows.push(structuredClone(row)); return row; },
  putMany: async (c, rows) => { for (const r of rows) await mem.put(c, r); return rows; },
  remove: async (c, id) => { DB[c] = (DB[c] || []).filter((r) => r.id !== id); },
};
setServerAdapter(() => mem);

// the payment check: a few known payments. Every call is recorded so Java must ask the same question.
let calls = [];
server.setPaymentVerifier(async (a) => {
  calls.push({ ref: a.ref, unit: a.unit, amount: a.amount, bookingId: a.bookingId });
  if (a.ref === 'PAY-OK') return '';
  if (a.ref === 'PAY-USED') return 'That payment has already been used for another booking.';
  if (a.ref === 'PAY-SMALL') return a.amount > 500 ? 'The payment is less than the booking total.' : '';
  if (a.ref === 'PAY-OTHER') return 'That payment was made for another unit.';
  return 'That payment was not found. Pay online first, then book.';
});

// ---- the random community ----------------------------------------------------------------------------------------------------------
const NAMES = ['Clubhouse', 'Tennis court', 'Pool', 'Party lawn'];
const UNITS = ['A-101', 'A-102', 'B-201', 'C-301'];
const DATES = ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-24', '2026-10-25', '2026-10-30', '2026-11-01', '2026-11-14', '2026-12-25', '2027-02-30', 'tomorrow', ''];
const SLOTS = ['06:00 - 07:00', '17:30 - 18:30', '17:30 - 18:30', '10:00 - 11:00', '18:00-19:00', '9:30-10:30', 'Full day', U, '25:00 - 26:00', 'abc'];
const MONEY = [U, 0, 100, 500, 1000, 1180, 1500, 2500, 3600, '1200', 999.99, 1000.5, 0.3];

function amenityType(name) {
  return { id: `AT-${name}`, name, active: pick([U, true, true, true, true, true, true, true, true, false]), bookingMode: pick(['Full day', 'Time slot', 'Time slot']), capacity: pick([U, 1, 1, 2, 3]),
    reservation: pick([U, 'Reservation required', 'Reservation required', 'Reservation required', 'Reservation required', 'Walk-in (no reservation)']), rateUnit: pick(['Per day / event', 'Per hour', 'Free', U]), rate: pick([U, 0, 500, 1500, 2500, '1200', 1000.5]),
    weekendRate: pick([U, U, 3000, '0']), gstApplicable: pick([U, true, true, false]), gstRate: pick([U, null, 0, 5, 12, 18]), gstMode: pick([U, 'Exclusive', 'Inclusive']), depositAmount: pick([U, 0, 1000, 2500]),
    hours: pick([U, '06:00 - 22:00', '9:30-18:00', '']), minNoticeHours: pick([U, 0, 2, 24, 48]), maxAdvanceDays: pick([U, 0, 30, 60]), blackoutDates: pick([U, [], ['2026-10-24'], ['2026-11-01', '2026-11-14']]),
    allowedUnitTypes: pick([U, [], ['Villa'], ['Apartment', 'Villa']]), maxPerDay: pick([U, 0, 1, 2]), maxPerMonth: pick([U, 0, 2, 4]), maxUpcoming: pick([U, 0, 1, 3]),
    overrideRoles: pick([U, [], ['facility_manager'], ['committee_amenities']]),
    cancellationRules: pick([U, [], [{ hoursBefore: 48, refundPct: 100 }, { hoursBefore: 0, refundPct: 25 }], [{ hoursBefore: '24', refundPct: '50' }, { hoursBefore: 72, refundPct: 100 }, { hoursBefore: 0, refundPct: 0 }]]) };
}
function extrasLines() {
  if (chance(0.6)) return '';
  const lines = [{ itemId: 'IT1', name: 'Chairs', qty: pick([1, 5, 20]), price: 10, amount: 50 }];
  if (chance(0.4)) lines.push({ itemId: 'IT2', name: 'Tables', qty: pick([1, 3]), price: 100, amount: 100 });
  return JSON.stringify(lines);
}
function booking(i) {
  const paid = chance(0.55);
  const fee = pick([0, 500, 1000, 1180, 2500]);
  const dep = pick([0, 0, 1000, 2500]);
  const credit = chance(0.2) ? pick([100, 500, 1000]) : 0;
  const date = pick(DATES), slot = pick(SLOTS), amenity = pick(NAMES);
  const b = { id: `B${i}`, shortId: `BKG-000${i + 1}`, amenity, date, slot, unit: pick(UNITS), status: pick(['Confirmed', 'Confirmed', 'Pending payment', 'Cancelled', 'Completed']),
    paymentStatus: paid ? 'Paid' : pick(['Pending', 'Not required', 'Cancelled', 'Refund due', 'Refunded']), paymentMode: pick(['UPI', 'Card', 'Cash', 'Cheque', 'Unit credit', U]), feeTotal: fee, depositAmount: dep, totalPayable: fee + dep,
    baseAmount: Math.round(fee / 1.18), gstAmount: fee - Math.round(fee / 1.18), gstRate: pick([0, 18, U]), creditApplied: credit, rate: pick([500, 1000, U]), extras: extrasLines(), policySnapshot: pick([U, [{ hoursBefore: 72, refundPct: 100 }, { hoursBefore: 24, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }]]),
    startAt: pick([U, '2026-10-20T17:30:00', '2026-10-21T17:30:00', '2026-10-22T17:30:00', `${date}T10:00:00`, `${date}T00:00:00`, '2026-10-20T10:00:00', '2026-10-19T18:00:00', '2026-10-30T06:00:00']),
    depositStatus: pick([U, 'None', 'Held', 'Held', 'Awaiting payment', 'Released']), refundStatus: pick([U, 'None', 'Refund due', 'Refund due', 'Credited to unit account', 'Refunded']), refundAmount: pick([0, 500, 1000, 2500, 590]),
    depositRefundStatus: pick([U, 'Due', 'Due', 'Credited to unit account', 'Paid']), depositRefundMode: pick([U, 'Cash', 'UPI', 'Cheque']), depositReturned: pick([0, 500, 1000, 2500]), retainedAmount: pick([0, 250]), notes: pick([U, 'bring chairs']) };
  return b;
}
function community() {
  const catalog = NAMES.filter(() => chance(0.85)).map(amenityType);
  if (!catalog.length) catalog.push(amenityType('Clubhouse'));
  const props = UNITS.map((u) => ({ id: `P-${u}`, unit: u, type: pick(['Villa', 'Apartment', U]) }));
  const items = [{ id: 'IT1', name: 'Chairs', price: 10, stock: pick([10, 30, 100]), amenity: pick([U, 'Clubhouse', 'Pool']), active: pick([U, true, false]), maxPerBooking: pick([U, 0, 25]) },
    { id: 'IT2', name: 'Tables', price: 100, stock: pick([2, 5]), active: pick([U, true]), maxPerBooking: pick([U, 4]) }].filter(() => chance(0.85));
  const bookings = Array.from({ length: 1 + Math.floor(rnd() * 7) }, (_, i) => booking(i));
  const credits = Array.from({ length: Math.floor(rnd() * 5) }, (_, i) => ({ id: `UC${i}`, unit: pick(UNITS), type: pick(['Credit', 'Credit', 'Debit']), amount: pick([100, 500, 1000, 250.5]) }));
  const dues = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => ({ id: `D${i}`, unit: pick(UNITS), status: pick(['Open', 'Open', 'Paid', 'Cancelled', 'Overdue']), amount: pick([0, 500, 2500, 12000, '3000']), dueDate: pick(['2026-06-01', '2026-09-30', '2026-10-18', '2026-12-01', U]) }));
  return strip({
    amenityTypes: catalog, amenitySettings: chance(0.9) ? [{ id: 'AS1', defaultGstRate: pick([U, 5, 18]), refundMode: pick([U, 'Credit to unit account', 'Original payment mode (manual)']), receiptAccount: pick([U, '', 'HDFC Current']) }] : [],
    amenities: bookings, unitCredits: credits, properties: props, amenityItems: items, dues,
    financeSettings: chance(0.8) ? [{ id: 'FS1', blockDefaulters: pick([true, true, false, U]), blockOverdueDays: pick([U, 0, 7, 30, 90]), blockOverdueAmount: pick([U, 0, 1000, 5000]) }] : [],
    bankAccounts: chance(0.6) ? [{ id: 'BA1', name: 'ICICI Savings' }] : [], ledger: chance(0.4) ? [{ id: 'LX', shortId: 'LED-0007', sourceId: pick(['amenity:B0:fee', 'amenity:B1:deposit', 'x']) }] : [],
  });
}

const PRINCIPALS = [
  { roleId: 'owner', role: { category: 'Resident', permissions: [] }, name: 'Asha' },
  { roleId: 'owner', role: { category: 'Resident', permissions: [] }, name: 'Asha' },
  { roleId: 'super_admin', role: { category: 'EC', permissions: ['*'] }, name: 'Boss' },
  { roleId: 'facility_manager', role: { category: 'Staff', permissions: ['MANAGE_AMENITIES'] }, name: 'Farid' },
  { roleId: 'committee_amenities', role: { category: 'EC', permissions: [] }, name: 'Chitra' },
  { roleId: 'security', role: { category: 'Staff', permissions: [] }, name: 'Guard' },
  { roleId: 'resident', role: { category: 'Resident', permissions: [] }, name: U },
];

// ---- attempts ---------------------------------------------------------------------------------------------------------------------
function newAttempt(w) {
  const am = pick(w.amenityTypes.length ? w.amenityTypes : [{ name: 'Nowhere' }]);
  const r = { id: pick([U, U, 'NEW1']), amenity: chance(0.95) ? am.name : 'Unknown', date: pick(DATES), slot: pick(SLOTS), unit: pick([...UNITS, U, '']), paymentMode: pick([U, 'UPI', 'UPI', 'Card', 'Net banking', 'Cash', 'Cheque', 'Bitcoin', '']),
    extras: pick([U, '', '{}', '{"IT1":5}', '{"IT1":500}', '{"IT1":3,"IT2":2}', '{"IT9":1}', '{bad json', 'null', '"5"', '[1]', '{"IT1":"4"}', '{"1":2,"IT1":1}', 5, { IT1: 2 }]), paymentRef: pick([U, 'PAY-OK', 'PAY-USED', 'PAY-SMALL', 'PAY-OTHER', 'nope']) };
  if (chance(0.2)) r.useCredit = true;
  if (chance(0.15)) { r.bookedFor = 'Association'; r.association = pick([U, '', '  Diwali committee ', 'Holi']); }
  if (chance(0.15)) { r.freeOfCharge = true; r.waiveReason = pick([U, '', 'Annual day', ' ']); }
  if (chance(0.1)) { r.paidAmount = 1; r.totalPayable = 1; r.status = 'Confirmed'; }   // the browser's own numbers must be ignored
  return r;
}
const ACTIONS = ['adjust_fee', 'cancel', 'cancel', 'receive_payment', 'mark_refund_paid', 'refund_to_credit', 'complete', 'settle_deposit', 'settle_deposit', 'mark_deposit_paid', 'bogus', 7];
function actionAttempt(w) {
  const old = strip(pick(w.amenities));
  const r = { ...old };
  const action = chance(0.9) ? pick(ACTIONS) : U;
  if (action !== U) r._action = action;
  if (chance(0.5)) r.cancelReason = pick(['', 'Rain', 'Moved']);
  if (chance(0.5)) r.refundTo = pick(['credit', 'original', '']);
  if (chance(0.4)) r.refundOverride = pick([U, '', null, 0, 250, '300', 99999, 'abc', -5]);
  if (chance(0.4)) r.waive = pick([true, false]);
  if (chance(0.5)) r.newFee = pick([U, '', null, 0, 800, '900', 1180.4, -1, 'abc']);
  if (chance(0.4)) r.adjustReason = pick(['', 'wrong price', ' ']);
  if (chance(0.5)) r.depositDeduction = pick([0, 300, 5000, 'abc', '200']);
  if (chance(0.5)) r.deductionReason = pick(['', 'broken <b>glass</b>&nbsp;pane', '<p> </p>', ' x ', U]);
  if (chance(0.3)) r.depositPhotos = pick([[], ['p1.jpg'], U, 'x']);
  if (chance(0.5)) r.payoutMode = pick(['', 'Cash', 'UPI', 'Cheque', 'Unit credit', 'Bitcoin']);
  if (chance(0.4)) r.paymentRef = pick(['', 'UTR123', '  ', 'CHQ1']);
  if (chance(0.3)) r.initiate = true;
  if (chance(0.3)) r.paymentMode = pick(['Cash', 'UPI']);
  if (!action && chance(0.7)) r[pick(['status', 'totalPayable', 'paymentStatus', 'notes', 'feeTotal'])] = pick(['x', 5, 'Confirmed']);
  return { record: strip(r), old };
}

// ---- run ----------------------------------------------------------------------------------------------------------------------------
const cases = [];
const kinds = new Map();
const tick = (k) => kinds.set(k, (kinds.get(k) || 0) + 1);
const TRACKED = ['ledger', 'unitCredits'];
const cleanRow = (r) => { const { id, ...rest } = r; return rest; };

for (let wi = 0; wi < 450; wi++) {
  const world = community();
  const probes = [];
  const posts = [];
  for (let i = 0; i < 40; i++) {
    const isNew = chance(0.5);
    const p = isNew || chance(0.3) ? pick(PRINCIPALS) : pick(PRINCIPALS.slice(2, 5));   // most actions are staff actions
    let record, old = null;
    if (isNew) record = strip(newAttempt(world)); else ({ record, old } = actionAttempt(world));
    DB = structuredClone(world); calls = [];
    let res;
    try { res = await server.amenityPreWrite({ record: structuredClone(record), old: old && structuredClone(old), isNew, p: p.name === U ? { ...p } : p }); } catch (e) { continue; }
    const expected = { error: res.error ?? null, action: res.action ?? null, record: res.record ? strip(res.record) : null };
    tick(res.error ? res.error.replace(/\d+/g, 'N').slice(0, 70) : `ok ${res.action || '(plain edit)'}`);
    probes.push({ principal: p, isNew, record, old, expected, calls });
    // what the booking posts once it is stored (as the stored record the storage layer hands over: stamped)
    if (res.record && res.action) {
      const next = strip({ ...res.record, id: res.record.id || old?.id || `N${wi}-${i}`, shortId: old?.shortId || `BKG-9${i}` });
      DB = structuredClone(world); calls = [];
      const before = Object.fromEntries(TRACKED.map((c) => [c, (DB[c] || []).length]));
      try { await server.amenityPostWrite({ old, next, action: res.action }); } catch (e) { /* the notifications may fail in this stand-in: the postings come first */ }
      const rows = Object.fromEntries(TRACKED.map((c) => [c, strip((DB[c] || []).slice(before[c]).map(cleanRow))]));
      posts.push({ next, action: res.action, expected: rows });
      tick(`post ${res.action}: ${rows.ledger.length} ledger, ${rows.unitCredits.length} credit`);
    }
  }
  cases.push({ world, probes, posts });
}
Math.random = realRandom;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify({ cases }))));
const total = cases.reduce((n, c) => n + c.probes.length, 0), posted = cases.reduce((n, c) => n + c.posts.length, 0);
console.log(`wrote ${total} booking decisions and ${posted} postings in ${cases.length} communities`);
for (const [k, v] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k);
