// The "golden" answers the Java notifications, late fees, reminders and background jobs (com.communityos.notify / finance / reports / jobs) are tested against.
//
//   TZ=Asia/Kolkata node --import ./register-hooks.mjs test/gen-jobs-golden.mjs    (from backend/contract-server; or: npm run gen:jobs)
//
// It builds many small random communities and asks the REAL JavaScript what it writes and returns for:
//   ticket / approval / invoice messages (notifications.js), the messages after a write (notifyExtra.js), e-voting reminders,
//   late fees and recurring bills (finance/rules.js), payment reminders with the bill terms (dueReminders.js, billText.js, billTermsServer.js),
//   the GST input-credit check (finance/itc.js), utility types (utilityTypes.js) and the report schedules (reports/run.js, reports/catalog.js).
// JobsConformanceCheck replays them in Java and names every place the answer differs.
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
console.warn = () => {};   // the JavaScript logs a failed report or message and goes on: so does the replay

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../../../src/lib');
const OUT = path.resolve(here, '../../spring/src/test/resources/jobs/golden.json.gz');
const { setServerAdapter } = await import(path.join(SRC, 'storage/index.js'));
const community = await import(path.join(SRC, 'community.js'));
const notifications = await import(path.join(SRC, 'notifications.js'));
const extra = await import(path.join(SRC, 'notifyExtra.js'));
const rules = await import(path.join(SRC, 'finance/rules.js'));
const due = await import(path.join(SRC, 'dueReminders.js'));
const terms = await import(path.join(SRC, 'billTermsServer.js'));
const itc = await import(path.join(SRC, 'finance/itc.js'));
const util = await import(path.join(SRC, 'utilityTypes.js'));
const reports = await import(path.join(SRC, 'reports/run.js'));
globalThis.window = { dispatchEvent() { return true; }, addEventListener() {} };
globalThis.CustomEvent = class { constructor(t, o) { this.type = t; this.detail = o?.detail; } };

let seed = 20261021;
const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
Math.random = rnd;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const chance = (p) => rnd() < p;
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const U = undefined;
const strip = (o) => JSON.parse(JSON.stringify(o));
const some = (a, n) => Array.from({ length: n }, () => pick(a));

let DB = {};
const mem = {
  list: async (c) => structuredClone(DB[c] || []),
  get: async (c, id) => structuredClone((DB[c] || []).find((r) => r.id === id) || null),
  put: async (c, row) => { const rows = (DB[c] ||= []); const i = rows.findIndex((r) => r.id === row.id); if (i >= 0) rows[i] = structuredClone(row); else rows.push(structuredClone(row)); return row; },
  putMany: async (c, rows) => { for (const r of rows) await mem.put(c, r); return rows; },
  remove: async (c, id) => { DB[c] = (DB[c] || []).filter((r) => r.id !== id); },
};
setServerAdapter(() => mem);

// ---- the world ----------------------------------------------------------------------------------------------------------
const UNITS = ['A-9', 'A-10', 'A-101', 'B-2', 'B-201', 'Villa 12', 'Villa 3'];
const NAMES = ['Asha', 'Ravi', 'Meena', 'Kiran', 'Treasurer Tara', 'FM Farid', 'Helpdesk Hari', 'President Pia'];
const ROLES = [
  { id: 'owner', name: 'Owner', category: 'Resident' }, { id: 'tenant', name: 'Tenant', category: 'Resident' },
  { id: 'ec_member', name: 'EC member', category: 'EC' }, { id: 'treasurer', name: 'Treasurer', category: 'EC' }, { id: 'president', name: 'President', category: 'EC' },
  { id: 'facility_manager', name: 'Facility Manager', category: 'Staff' }, { id: 'handyman_mep', name: 'MEP', category: 'Staff' }, { id: 'helpdesk', name: 'Helpdesk', category: 'Staff' },
  { id: 'super_admin', name: 'Super Admin', category: 'EC' },
];
const CATS = ['Maintenance', 'Water', 'DG', 'Special levy', 'Sinking fund', 'Amenity booking', 'Late fee', 'Other', U];
const day = (t0, n) => { const x = new RealDate(`${t0}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function gstin(valid) {
  let s = `${int(10, 37)}${some('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''), 5).join('')}${int(1000, 9999)}${pick('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''))}${pick('123456789ABC'.split(''))}Z`;
  let sum = 0; for (let i = 0; i < 14; i += 1) { const p = CHARS.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(p / 36) + (p % 36); }
  const check = CHARS[(36 - (sum % 36)) % 36];
  return valid ? s + check : s + (check === 'A' ? 'B' : 'A');
}

function users() {
  return Array.from({ length: int(2, 9) }, (_, i) => ({
    id: chance(0.95) ? `U${i}` : U, name: pick(NAMES), roleId: pick(ROLES).id, extraRoleIds: pick([U, [], ['treasurer'], ['helpdesk', 'ec_member'], 'x']),
    units: pick([[pick(UNITS)], [pick(UNITS), pick(UNITS)], [], U, `${pick(UNITS)}, ${pick(UNITS)}`, pick(UNITS), '']), status: pick([U, 'Active', 'Active', 'Inactive']),
    email: pick([U, '', 'p@x.in', 'q@x.in']), phone: pick([U, '', '+919800000001', '98']),
  }));
}
function prefs(us) {
  return us.filter(() => chance(0.6)).map((u, i) => ({ id: `NP${i}`, userName: u.name, whatsapp: chance(0.5), sms: chance(0.4), email: pick([true, false, U]) }));
}
function notifSettings() {
  if (chance(0.3)) return [];
  const ev = {};
  for (const e of ['ticket_assigned', 'ticket_status', 'ticket_decision', 'approval', 'payment_reminder', 'ticket_chat', 'ticket_new', 'payment_made', 'ballot', 'ballot_result', 'poll', 'forum_topic', 'forum_reply', 'report']) {
    if (chance(0.5)) ev[e] = { whatsapp: pick([U, true, false]), sms: pick([U, true, false]), email: pick([U, true, false]), alsoRoles: pick([U, [], ['president'], ['treasurer', 'helpdesk'], 'x']) };
  }
  return [{ id: 'default', events: pick([ev, ev, ev, U]) }];
}
function dueRow(i, t0) {
  const amount = pick([1000, 2500, 3540.5, 0, 120, '800', 59.99, -10]);
  const status = pick(['Unpaid', 'Unpaid', 'Unpaid', 'Paid', 'Cancelled', 'Partly paid', U]);
  return strip({
    id: `D${i}`, shortId: pick([`DUE-${String(i + 1).padStart(4, '0')}`, `DUE-${String(i + 1).padStart(4, '0')}`, U]), unit: pick([...UNITS, U, '']), category: pick(CATS), amount,
    grossAmount: pick([U, U, 1200, 2500]), billedMonth: pick([U, 'Oct 2026', 'Sep 2026', '2026-08', 7]), dueDate: pick([day(t0, -100), day(t0, -40), day(t0, -32), day(t0, -31), day(t0, -10), day(t0, -1), t0, day(t0, 1), day(t0, 3), day(t0, 10), U, '2026-02-30', 'soon']),
    status, billTo: pick([U, 'Owner', 'Tenant']), billedTo: pick([U, '', 'Mr Rao']), tax: pick([U, 0, 90, 180, 33.33, 0.05, 101.01]), gstRate: pick([U, 0, 18, '18', 5, 12.5, 2.5]), gstMode: pick([U, 'Exclusive', 'Inclusive', null]),
    reminderSentAt: pick([U, U, new RealDate(CURRENT - 3 * 864e5).toISOString(), new RealDate(CURRENT - 7 * 864e5 + 30000).toISOString(), new RealDate(CURRENT - 8 * 864e5).toISOString(), 'garbage']),
    reminderCount: pick([U, 0, 1, 3, 4, 5, '2']), paidAt: status === 'Paid' ? pick([day(t0, -1), t0, day(t0, -3), `${day(t0, -2)}T09:00:00.000Z`]) : U, paymentMode: pick([U, 'UPI', 'Cash', 'Online']),
    recVersion: 1,
  });
}
function lateFeeRow(i, d, t0) {   // a late fee already charged on a bill
  return { id: `LF${i}`, shortId: `DUE-${String(900 + i).padStart(4, '0')}`, unit: d.unit, category: 'Late fee', amount: pick([50, 100, 25.5]), status: pick(['Unpaid', 'Paid']), lateFeeFor: d.id, lateFeeNo: pick([1, 2, '1']), dueDate: t0, recVersion: 1 };
}
function finance() {
  const rule = () => ({ id: pick([U, 'x1', 'x2']), appliesTo: pick([U, '*', 'Maintenance', 'Water', 'Special levy', '']), kind: pick([U, 'Fixed per month', 'Percent per month', 'odd']), value: pick([U, 0, 2, 1.5, 100, '50', 'abc']), grace: pick([U, 0, 5, 10, '3', -2, 2.5]), maxMonths: pick([U, 0, 1, 3, 12, 2.5]) });
  const rulesTxt = pick([U, '', '[]', JSON.stringify([rule()]), JSON.stringify([rule(), rule(), rule()]), 'not json', '{"a":1}', JSON.stringify([rule(), rule()])]);
  return [strip({
    id: 'FS1', lateFeeEnabled: pick([U, true, true, false, 'No']), lateFeeAuto: pick([U, true, true, false]), lateFeeRules: rulesTxt, lateFeeValue: pick([U, 0, 2, 100]), lateFeeKind: pick([U, 'Fixed per month', 'Percent per month']),
    lateFeeGraceDays: pick([U, 0, 7]), lateFeeMaxMonths: pick([U, 0, 6]), reminderEnabled: pick([U, true, false, '']), reminderEveryDays: pick([U, 7, 0, 3, '', 'abc']), reminderLeadDays: pick([U, 0, 3, 5, '']), reminderMax: pick([U, 4, 1, 0, 10]),
  })];
}
function tickets(t0) {
  return Array.from({ length: int(1, 6) }, (_, i) => strip({
    id: `T${i}`, ticketNumber: `TKT-${1051 + i}`, shortId: `TKT-${1051 + i}`, title: pick(['Leaking tap', 'Street light out', 'Lift noise', 'Pool pump']), scope: pick(['Unit', 'Unit', 'Community', U]), unit: pick([...UNITS, U]),
    location: pick([U, '', 'Clubhouse', 'Block A']), createdBy: pick([...NAMES, U, '']), createdByRole: pick([...ROLES.map((r) => r.id), U]), assignedTo: pick([...NAMES, U, '']),
    status: pick(['Open', 'Assigned', 'In progress', 'Closed', 'Completed', 'Cancelled']), category: pick([U, 'Plumbing', 'Electrical', 'Civil']), priority: pick([U, 'High', 'Low']),
    slaDueAt: pick([U, `${day(t0, -2)}T10:00:00.000Z`, `${day(t0, 3)}T10:00:00.000Z`]), recordCreatedAt: pick([`${day(t0, -1)}T08:00:00.000Z`, `${day(t0, -20)}T08:00:00.000Z`]), lastUpdatedAt: pick([`${t0}T08:00:00.000Z`, `${day(t0, -9)}T08:00:00.000Z`]),
    affectedUnits: pick([U, [], ['A-9'], ['A-9', 'B-2']]), taskType: pick([U, 'Repair', 'Purchase']), selectedQuotationId: pick([U, '', 'Q1']), financial: pick([U, true, false]),
    ecApproval: pick([U, 'Pending', 'Approved', 'Rejected']), treasurerApproval: pick([U, 'Pending', 'Approved', 'Rejected']), finalRequired: pick([U, true, false]), assetId: pick([U, U, 'E1', 'E2']),
  }));
}
function world(t0) {
  const us = users();
  const dues = Array.from({ length: int(1, 9) }, (_, i) => dueRow(i, t0));
  dues.filter(() => chance(0.25)).forEach((d, i) => dues.push(lateFeeRow(i, d, t0)));
  const tk = tickets(t0);
  const ballots = Array.from({ length: int(0, 3) }, (_, i) => strip({ id: `BL${i}`, title: pick(['AGM vote', 'Paint colour']), status: pick(['Open', 'Open', 'Closed', 'Draft']), closesOn: pick([t0, day(t0, 1), day(t0, 2), day(t0, 3), day(t0, -1), U, 'bad']),
    roll: pick([U, [], UNITS.slice(0, int(1, 6)).map((u) => ({ unit: u })), [{ unit: 'A-9' }, { unit: 'A-9' }, {}]]) }));
  return strip({
    users: us, roles: ROLES, notificationPrefs: prefs(us), notificationSettings: notifSettings(), notificationOutbox: chance(0.3) ? [{ id: 'O1', shortId: 'OUT-0007', event: 'x', status: 'Sent' }] : [],
    notifications: chance(0.3) && ballots[0] ? [{ id: 'N0', kind: 'ballot_reminder', ballotId: ballots[0].id }] : [],
    dues, financeSettings: chance(0.85) ? finance() : [], mergeFields: chance(0.8) ? [{ id: 'M1', token: '{{SOCIETY_NAME}}', defaultValue: pick(['La Paloma', '', U, 'Green Acres']) }] : [],
    noticeTemplates: pick([[], [{ id: 'NT1', shortId: 'NTP-0003', appliesTo: 'Payment reminder', headerText: pick([U, '', 'Reminder · {{BILL_NO}}', '{{SOCIETY_NAME}} dues']), body: pick([U, '', 'Hi {{UNIT}}, {{AMOUNT}} {{WHEN}} {{DAYS_OVERDUE}} {{UTILITY_TYPE}} {{MONTH}} {{DUE_DATE}} {{SOCIETY_NAME}} {{BILL_NO}}']) }],
      [{ id: 'NT2', shortId: 'NTP-0001', appliesTo: 'Water bill', name: 'Water bill' }]]),
    recurringBills: Array.from({ length: int(0, 3) }, (_, i) => strip({ id: `RB${i}`, description: pick(['Security AMC', 'Internet', U]), amount: pick([5000, '1200', 0, 899.5]), dayOfMonth: pick([U, 1, 10, 31, 0, 5.5, -3, '15']),
      utility: pick([U, 'Internet', 'Electricity']), location: pick([U, 'Clubhouse']), provider: pick([U, 'Airtel', null]), active: pick([U, true, false, 0]), lastMonth: pick([U, '2026-09', t0.slice(0, 7)]) })),
    ballots, voteRoll: ballots.flatMap((b) => UNITS.filter(() => chance(0.3)).map((u, i) => ({ id: `VR${b.id}${i}`, ballotId: b.id, unit: u }))),
    ledger: Array.from({ length: int(0, 5) }, (_, i) => strip({ id: `L${i}`, shortId: `LED-${String(i + 1).padStart(4, '0')}`, type: pick(['Debit', 'Debit', 'Credit']), gstAmount: pick([0, 180, '90', U]), reversalOf: pick([U, U, 'L9']),
      vendor: pick(['Acme', 'Bolt', U, '']), invoiceNo: pick([U, '', 'INV-11', 'INV-20', 'X-9X', '  ']), billNo: pick([U, 'B-7']), date: t0, itcStatus: pick([U, '', 'Not checked', 'Verified', 'Not found in GSTR-2B', 'Odd']), amount: 1000 })),
    vendors: [{ id: 'V1', name: 'Acme', gstin: pick([gstin(true), gstin(false), '', U, 'short']) }, { id: 'V2', name: 'Bolt', gstin: pick([gstin(true), gstin(true).toLowerCase(), ` ${gstin(true)} `]) }],
    taxSettings: chance(0.7) ? [strip({ id: 'TS1', registered: pick(['Yes', 'Yes', 'No', U]), itcAuto: pick([U, true, false]), itcLastRun: pick([U, `${t0}T01:00:00.000Z`, `${day(t0, -1)}T23:00:00.000Z`, new RealDate(CURRENT).toISOString()]) })] : [],
    utilityTypes: pick([[], [], [{ id: 'UT1', name: 'Water', label: 'Water', unitName: 'kL', icon: '💧', active: true }, { id: 'UT2', name: 'Gas', active: pick([U, false, true]) }]]),
    schema: chance(0.7) ? [
      { id: 'dues', fields: [{ key: 'category', options: pick([['Maintenance', 'Other'], ['Maintenance', 'Water', 'Announcement', 'Other'], 'x', U]) }, { key: 'amount' }] },
      { id: 'readings', fields: [{ key: 'utility', options: ['Water'] }] }, { id: 'noticeTemplates', fields: [{ key: 'appliesTo', options: ['Payment reminder', 'Announcement'] }] },
    ] : [],
    reportSchedules: Array.from({ length: int(0, 3) }, (_, i) => schedule(i)),
    amenities: Array.from({ length: int(0, 5) }, (_, i) => strip({ id: `AM${i}`, amenity: pick(['Clubhouse', 'Pool', U, 7]), unit: pick(UNITS), date: pick([t0, day(t0, 1), day(t0, -1), day(t0, 5), U]), slot: pick(['06:00 - 07:00', '17:30 - 18:30', U, 'Full day']),
      status: pick(['Confirmed', 'Cancelled', 'Pending payment']), paymentStatus: pick(['Paid', 'Pending', U]), baseAmount: pick([1000, U, '847.46']), gstAmount: pick([180, U]), feeTotal: pick([1180, 0, U]) })),
    plantLogs: Array.from({ length: int(0, 4) }, (_, i) => strip({ id: `PL${i}`, date: day(t0, -i), bhKl: pick([120, 80.5, U, null, 0]), wtpKl: pick([60, U]), stpKl: pick([40, '35']), saltUsed: pick([25, U]), chlorineUsed: pick([1.25, 2, U]), remarks: pick([U, 'ok', '']) })),
    tickets: tk,
    audits: Array.from({ length: int(0, 4) }, (_, i) => strip({ id: `AU${i}`, area: pick(['STP', 'Pool', 'Fire', U]), auditDate: pick([day(t0, -30), day(t0, -60), U]), result: pick(['Pass', 'Fail', U]), score: pick([U, 80, 0]), nextDue: pick([U, day(t0, -5), day(t0, -1), t0, day(t0, 1), day(t0, 20), day(t0, 90), 'bad']) })),
    equipment: Array.from({ length: int(0, 4) }, (_, i) => strip({ id: `E${i}`, name: pick(['Pump 1', 'Lights Rd 4', 'Cam 2']), type: pick(['Pump', 'Light', U]), area: pick([U, 'STP', 'Road 4']), status: pick(['Working', 'Needs attention', 'Under repair', 'Out of service', 'Standby', 'Retired', U, 'Odd']),
      quantity: pick([U, 1, 10, '4']), faulty: pick([U, 0, 1, 3, 20]) })),
    eventWork: Array.from({ length: int(0, 4) }, (_, i) => strip({ id: `EW${i}`, eventName: 'Diwali', title: pick(['Stage', 'Lights']), phase: pick(['Before', 'During']), neededOn: pick([day(t0, -1), t0, day(t0, 3), day(t0, 10), U]), status: pick(['Open', 'Done', 'Cancelled']),
      staffRequested: pick([U, 2, 5, '3']), staffConfirmed: pick([U, 0, 2]), staffType: pick([U, 'Electrician']), ownerRole: pick(['Facility Manager', 'MEP', U]) })),
    taskTypes: [{ id: 'TT1', name: 'Repair', ecApprovalStage: pick(['Yes', 'No', 'Optional']), treasurerStage: pick(['Yes', 'No']) }, { id: 'TT2', name: 'Purchase', ecApprovalStage: 'Yes', treasurerStage: 'Yes' }],
    approverSettings: pick([[], [{ id: 'AP1', roles: pick([['treasurer'], [], ['president', 'ec_member'], U]) }]]),
    forum: [{ id: 'F1', title: 'Parking', author: pick([U, 'Asha', '']), recordCreatedBy: pick([U, 'Ravi (Owner)', 'Meena']) }], forumPosts: [{ id: 'FP1', topicId: 'F1', author: pick([U, 'Kiran', 'Asha']), body: 'x' }],
    quotations: [], releases: [], ticketComments: [],
  });
}
function schedule(i) {
  const type = pick(['bookings', 'dues', 'collections', 'water', 'tasks', 'audits', 'infra', 'eventwork', 'custom', 'nope', U]);
  const custom = type === 'custom' ? pick([
    { source: 'tickets', columns: ['ticketNumber', 'title', 'status', 'affectedUnits', 'financial'], sortBy: pick([U, 'title', 'ticketNumber', 'status']), sortDir: pick([U, 'desc']), filters: pick([U, [], [{ field: 'status', op: pick(['is', 'is not', 'contains', 'empty', 'not empty']), value: pick(['Open', 'clo', '']) }]]) },
    JSON.stringify({ source: 'dues', groupBy: pick(['category', 'unit', 'status']), measure: pick([U, 'count', 'sum', 'avg']), measureField: pick([U, 'amount']), labels: { category: 'Kind' }, dateField: pick([U, 'dueDate']) }),
    { source: 'dues', columns: pick([U, ['unit', 'amount', 'dueDate']]), dates: ['dueDate'], numeric: ['amount'], filters: [{ field: 'amount', op: pick(['more than', 'less than']), value: pick([100, '1000']) }], limit: pick([U, 2]), title: pick([U, 'Big dues']) },
    'not json', U]) : U;
  return strip({
    id: chance(0.9) ? `RS${i}` : U, name: pick(['Daily dues', 'Weekly tasks', U]), active: pick([true, true, false, U]), reportType: type, custom, period: pick([U, 'today', 'last7', 'mtd', 'prevMonth', 'asof', 'next7', 'bogus']),
    frequency: pick(['Daily', 'Weekly', 'Monthly', U]), weekday: pick([U, 'Monday', 'Sunday', 'Tuesday']), monthDay: pick([U, 1, 19, 31, 20]), time: pick([U, '08:00', '17:00', '23:59', '00:00', 5]), lastRunKey: pick([U, '2026-10-18', '2026-10-19']),
    audience: pick(['Roles', 'People', 'All villas', 'Selected villas', U]), roleIds: pick([U, ['treasurer'], ['facility_manager', 'owner']]), people: pick([U, ['Asha', 'Ravi'], []]), units: pick([U, ['A-9', 'B-2'], ['Villa 12']]),
    extra: pick([U, '', 'sec@x.in', '+919811111111; ops@x.in', ' , 98111 abc']), channels: pick([U, [], ['In-app'], ['In-app', 'Email'], ['WhatsApp', 'SMS'], ['Email']]), format: pick([U, 'Summary', 'Detailed', 'Excel', 'CSV']),
    skipEmpty: pick([U, true, false]), showCols: pick([U, [], ['Unit', 'Amount (₹)'], ['Nope']]), showTax: pick([U, false, true]), showTotals: pick([U, true]), showSummary: pick([U, false]), intro: pick([U, 'Good morning']), footer: pick([U, '— FM']),
  });
}

const TIMES = ['2026-10-19T12:00:00.000Z', '2026-10-19T02:29:00.000Z', '2026-10-19T02:31:00.000Z', '2026-10-19T18:29:00.000Z', '2026-10-18T18:31:00.000Z', '2026-10-31T19:00:00.000Z', '2026-11-30T20:00:00.000Z', '2026-12-31T20:00:00.000Z', '2026-10-25T20:00:00.000Z'];
const TRACK = ['dues', 'notifications', 'notificationOutbox', 'assocBills', 'recurringBills', 'ledger', 'taxSettings', 'utilityTypes', 'schema', 'noticeTemplates', 'reportRuns', 'reportSchedules'];
const cleanRow = (r) => { const { id, ...rest } = r; return rest; };
// (rows without an id cannot be told apart: they are left out of the comparison on both sides)
const snapshot = () => Object.fromEntries(TRACK.map((c) => [c, new Map((DB[c] || []).filter((r) => r.id !== undefined).map((r) => [r.id, JSON.stringify(r)]))]));
function diff(before, auditBefore) {
  const changed = {}, created = {};
  for (const c of TRACK) {
    const rows = (DB[c] || []).filter((r) => r.id !== undefined);
    changed[c] = Object.fromEntries(rows.filter((r) => before[c].has(r.id) && before[c].get(r.id) !== JSON.stringify(r)).map((r) => [r.id, strip(r)]));
    created[c] = strip(rows.filter((r) => !before[c].has(r.id)).map(cleanRow));
  }
  const audit = (DB.audit || []).slice(auditBefore).map((a) => ({ who: a.who, what: a.what, action: a.action, summary: a.summary, unit: a.unit || '' }));
  return { changed, created, audit };
}
const actorOf = () => { const r = pick(ROLES); return { name: pick([...NAMES, 'Nobody']), roleId: r.id, unit: r.category === 'Resident' ? pick(UNITS) : '', role: r }; };

const cases = [];
const kinds = new Map();
const tick = (k) => kinds.set(k, (kinds.get(k) || 0) + 1);
let crashes = 0;
let slug = 0;

for (let wi = 0; wi < 700; wi++) {
  const nowIso = pick(TIMES);
  CURRENT = Date.parse(nowIso);
  const t0 = rules.todayIso();
  const w = world(t0);
  const ops = [];
  const run = async (op, fn) => {
    DB = structuredClone(w);
    community.setCommunity(`c${slug++}`);   // the bill-terms cache is per community: a fresh one for every operation
    const before = snapshot(); const auditBefore = (DB.audit || []).length;
    let ret = null;
    try { ret = await fn(); } catch (e) { crashes++; return; }
    op.expected = { ret: ret === undefined ? null : strip(ret), ...diff(before, auditBefore) };
    ops.push(op);
    tick(op.kind);
  };
  // tasks: what a save sends (secureStorage.js: notifyTicketChange + notifyApprovalNeeded, then notifyAfterWrite)
  for (let i = 0; i < 4; i++) {
    const old = chance(0.25) ? null : structuredClone(pick(w.tickets));
    const next = old ? { ...old, ...strip(pick(tickets(t0))), id: old.id, ticketNumber: old.ticketNumber } : strip(pick(tickets(t0)));
    if (old && chance(0.3)) next.status = old.status;
    const actor = actorOf();
    await run({ kind: 'ticket', old, next: strip(next), actor }, async () => {
      const roles = await mem.list('roles');
      await notifications.notifyTicketChange({ old, next, actor, users: await mem.list('users'), roles });
      await notifications.notifyApprovalNeeded({ old, next, actor, roles });
      await extra.notifyAfterWrite({ collection: 'tickets', old, next, actor });
      return null;
    });
  }
  // invoices
  for (let i = 0; i < 2; i++) {
    const inv = () => strip({ id: 'Q9', kind: pick(['Invoice', 'Invoice', 'Quotation']), ticketId: pick([...w.tickets.map((t) => t.id), 'TX']), vendor: pick([U, 'Acme']), amount: pick([U, 12500, 1234.5678, 'abc', 0, 2500000]),
      selected: pick([U, true, false]), approvalWaived: pick([U, false, true]), ecApproval: pick([U, 'Pending', 'Approved', 'Rejected']), finalApproval: pick([U, 'Pending', 'Approved', 'Rejected']), finalRequired: pick([U, false, true]) });
    const old = chance(0.3) ? null : inv(); const next = { ...inv(), id: 'Q9' };
    const actor = actorOf();
    await run({ kind: 'invoice', old, next, actor }, async () => { await notifications.notifyInvoiceChange({ old, next, actor, roles: await mem.list('roles') }); return null; });
  }
  // the other messages after a write
  for (let i = 0; i < 4; i++) {
    const actor = actorOf();
    const c = pick(['forum', 'forumPosts', 'ballots', 'ticketComments', 'releases', 'releases']);
    let old = null, next;
    if (c === 'forum') next = { id: 'F2', kind: pick(['Poll', 'Topic']), title: 'Gym hours', category: pick([U, 'General']) };
    else if (c === 'forumPosts') next = { id: 'FP2', topicId: pick(['F1', 'F9']), parentId: pick([U, 'FP1', 'FP9']), body: pick(['Agree <b>fully</b>   with   this', 'x'.repeat(130), '  ']) };
    else if (c === 'ballots') { old = { id: 'BL9', title: 'AGM', status: pick(['Open', 'Closed']) }; next = { ...old, status: pick(['Closed', 'Open']) }; }
    else if (c === 'ticketComments') next = { id: 'TC1', ticketId: pick([...w.tickets.map((t) => t.id), 'T99']), author: pick([...NAMES, U]), authorRoleId: pick([U, 'system', 'owner']), visibility: pick([U, 'Internal', 'Public']), body: 'Can you <i>check</i> today?' };
    else {
      const step = (s) => ({ name: 'S', approvers: pick([[{ kind: 'role', value: 'treasurer' }], [{ kind: 'group', value: 'EC members' }, { kind: 'role', value: 'nope' }], [{ kind: 'group', value: 'Final approvers' }], [{ kind: 'user', value: 'Asha' }]]), needed: pick([U, 1, 2, '2']), decisions: s });
      const plan = () => pick([U, '', 'bad', JSON.stringify({ steps: [step([]), step([])] }), JSON.stringify({ steps: [step([{ by: 'x', value: 'Approved' }]), step([])] }), JSON.stringify({ steps: [step([{ by: 'x', value: 'Approved' }]), step([{ by: 'y', value: 'Approved' }])] }), { steps: [step([{ by: 'x', value: 'Rejected' }])] }]);
      old = chance(0.3) ? null : strip({ id: 'R1', amount: 5000, vendor: 'Acme', plan: plan(), status: pick(['Pending', 'Approved', 'Paid']), requestedBy: pick([U, 'Asha']), recordCreatedBy: 'FM Farid (Facility Manager)' });
      next = strip({ id: 'R1', amount: pick([5000, 12345.678, U]), vendor: pick([U, 'Acme']), expenseId: pick([U, 'EX1']), ticketShortId: pick([U, 'TKT-1051']), plan: plan(), status: pick(['Pending', 'Approved', 'Paid']), requestedBy: pick([U, 'Asha']), recordCreatedBy: 'FM Farid (Facility Manager)' });
    }
    await run({ kind: 'afterWrite', collection: c, old, next: strip(next), actor }, async () => { await extra.notifyAfterWrite({ collection: c, old, next: strip(next), actor }); return null; });
  }
  // money and reminders
  {
    const asOf = pick([t0, day(t0, 30), day(t0, 400)]); const only = chance(0.3) ? pick(w.dues).id : null; const auto = chance(0.5);
    await run({ kind: 'lateFees', asOf, only, auto }, async () => { const r = await rules.applyLateFees({ asOf, only, auto, actor: 'Billing' }); return { created: r.created, total: r.total }; });
  }
  await run({ kind: 'autoLateFees' }, () => rules.runAutoLateFees());
  await run({ kind: 'recurring' }, () => rules.runRecurringBills({ now: new Date() }));
  await run({ kind: 'reminders', force: false }, () => due.runDueReminders({ now: new Date() }));
  if (chance(0.3)) await run({ kind: 'reminders', force: true }, () => due.runDueReminders({ now: new Date(), force: true }));
  for (let i = 0; i < 2; i++) { const d = pick(w.dues); await run({ kind: 'terms', due: d }, async () => terms.termsFor(d)); }
  await run({ kind: 'ballotReminders' }, () => extra.runBallotReminders(new Date()));
  await run({ kind: 'itc' }, async () => { const r = await itc.runAutoItc(); return r; });
  { const only = pick(['all', 'pending']); await run({ kind: 'itcChecks', only }, () => itc.runItcChecks({ only })); }
  await run({ kind: 'utilityTypes' }, async () => { await util.ensureUtilityTypes(); return null; });
  await run({ kind: 'reports' }, () => reports.runReportSchedules(new Date()));
  if (w.reportSchedules.length) {
    const s = pick(w.reportSchedules);
    await run({ kind: 'runSchedule', schedule: s }, async () => { const r = await reports.runSchedule(s, { now: new Date(), manual: true }); return { silent: r.silent, inApp: r.inApp, queued: r.queued, skipped: r.skipped, sentTo: r.sentTo }; });
  }
  cases.push({ now: nowIso, world: w, ops });
}
Math.random = realRandom;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(JSON.stringify({ cases }))));
const total = cases.reduce((n, c) => n + c.ops.length, 0);
console.log(`wrote ${total} operations in ${cases.length} communities (${crashes} skipped: the JavaScript could not run them here)`);
for (const [k, v] of [...kinds].sort()) console.log(String(v).padStart(6), k);
