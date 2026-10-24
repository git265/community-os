import { DEFAULT_UTILITY_TYPES } from '../utilityTypes.js';
import { uuid } from '../uuid.js';
import { isApiMode, storage, COLLECTIONS } from '../storage/index.js';
import { shortPrefix } from '../storage/secureStorage.js';
import { gateSeed } from '../gate/seed.js';
import { mergeReferenceData } from './refData.js';
import { getCommunity } from '../community.js';
import { DEFAULT_RULES } from '../inventoryImport.js';
import laPaloma from './laPaloma.json';
import { categorize, BANK_ACCOUNT_NAMES } from '../bank/analysis.js';
import { totalsOf } from '../culturalServer.js';
import { CULTURAL_HISTORY } from './culturalHistory.js';
import PLANT_LOG_ROWS from './plantLogs.json';
import { quote, tiersOf, startAtOf, defaultTemplates, priceLabel } from '../amenityEngine.js';
import { STARTERS, checklistRow, periodOf, previousPeriod, freshItems, isoDay } from '../plannedWorks.js';

const cd = (id, eventId, donor, unit, amount, towards, status, o = {}) => ({ id, eventId, donor, unit, kind: 'Donation', towards, amount, date: '2026-09-05', mode: 'UPI', reference: status === 'Received' ? `UPI${id}8841` : '', status, receiptNo: o.receiptNo || '', anonymous: false, note: '', ...o });
const CULT_DON = [
  cd('cd1', 'ce1', 'Ananya Mehta', 'Villa 135', 5000, 'General', 'Received', { receiptNo: 'VC26-0001' }),
  cd('cd2', 'ce1', 'Ravi Kumar', 'Villa 48', 11000, 'Idol & decoration', 'Received', { receiptNo: 'VC26-0002', mode: 'Cash' }),
  cd('cd3', 'ce1', 'Sunita Rao', 'Villa 77', 2500, 'Prasadam & food', 'Received', { receiptNo: 'VC26-0003' }),
  cd('cd4', 'ce1', 'Anonymous', 'Villa 12', 51000, 'Cultural programmes', 'Received', { receiptNo: 'VC26-0004', mode: 'Cheque', reference: 'CHQ 004512', anonymous: true }),
  cd('cd5', 'ce1', 'Meera Rao', 'Villa 212', 7500, 'General', 'Received', { receiptNo: 'VC26-0005' }),
  cd('cd6', 'ce1', 'Sri Ganesh Hardware', '', 15000, 'Sound & lights', 'Received', { receiptNo: 'VC26-0006', kind: 'Sponsorship', mode: 'Cheque', reference: 'CHQ 118820' }),
  cd('cd7', 'ce2', 'Ananya Mehta', 'Villa 135', 3000, 'Cultural programmes', 'Pledged', { date: '2026-10-10', reference: '' }),
  cd('cd9', 'ce2', 'Ravi Kumar', 'Villa 48', 25000, 'Seva offering', 'Pledged', { kind: 'Sponsorship', offeringId: 'co4', note: 'Stage lighting & sound sponsor', phone: '+919845012345', members: 'Family of 4', sankalpam: 'In loving memory of parents', date: '2026-10-09' }),
  cd('cd10', 'ce1', 'Sunita Rao', 'Villa 77', 30000, 'Seva offering', 'Received', { kind: 'Sponsorship', offeringId: 'co6', receiptNo: 'VC26-0007', note: 'Decoration · Day 1' }),
  cd('cd8', 'ce2', 'Ravi Kumar', 'Villa 48', 5000, 'Prasadam & food', 'Received', { receiptNo: 'DCE26-0001', date: '2026-10-08' }),
];
const ce = (id, eventId, item, category, vendor, amount, date, status, paidBy = 'Treasurer · UPI') => ({ id, eventId, item, category, vendor, amount, date, status, paidBy, note: '', attachments: [], fund: eventId === 'ce1' ? 'Ganesh' : 'Cultural', ...(status === 'Pending approval' ? { ecApproval: 'Pending' } : { ecApproval: 'Approved', ecApprovedBy: 'President', ecApprovedAt: date, finalRequired: true, approvedBy: 'Treasurer', approvedAt: date }) });
const CULT_EXP = [
  ce('cx1', 'ce1', 'Eco-friendly Ganesha idol (4 ft)', 'Idol & decoration', 'Kala Mandir Artisans', 28000, '2026-09-10', 'Paid'),
  ce('cx2', 'ce1', 'Flowers & mandap decoration', 'Idol & decoration', 'Flower Mart', 21500, '2026-09-13', 'Paid'),
  ce('cx3', 'ce1', 'Pandit dakshina & pooja samagri', 'Pooja & rituals', 'Pandit Srinivas', 12000, '2026-09-14', 'Paid', 'Cash'),
  ce('cx4', 'ce1', 'Sound & lights (11 days)', 'Sound & lights', 'Sri Ganesh Hardware', 24000, '2026-09-24', 'Paid'),
  ce('cx5', 'ce2', 'Rangoli colours & diyas', 'Idol & decoration', 'Festival Store', 6200, '2026-10-09', 'Pending approval'),
];
// Demo attendance: a week of punches for a few staff (positions are around the demo site below).
const DEMO_SITE = { lat: 17.44, lng: 78.3489 };
const att = (id, name, roleName, n, tin, tout, shiftType, late = 0, outside = false) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const at = (t) => new Date(`${date}T${t}:00`).toISOString();
  const jit = (k) => +(k * 0.00012).toFixed(6);
  return { id, staffName: name, roleName, date, clockIn: at(tin), clockOut: at(tout), hours: Math.round(((new Date(`${date}T${tout}:00`) - new Date(`${date}T${tin}:00`)) / 3600000) * 100) / 100, shiftType, lateMin: late, source: 'Self',
    inLat: +(DEMO_SITE.lat + jit(1)).toFixed(6), inLng: +(DEMO_SITE.lng + jit(2)).toFixed(6), inAcc: 18, inSite: 'Inside site', inDist: 25,
    outLat: outside ? +(DEMO_SITE.lat + 0.01).toFixed(6) : +(DEMO_SITE.lat + jit(2)).toFixed(6), outLng: DEMO_SITE.lng, outAcc: 22, outSite: outside ? 'Outside site' : 'Inside site', outDist: outside ? 1110 : 30, note: '' };
};
const ATT_ROWS = [];
[['Ramesh Kumar', 'Handyman · Plumbing', 'Morning', '06:02', '14:05'], ['Suresh Nair', 'Handyman · Electrical', 'Morning', '06:10', '14:00'], ['Manoj Yadav', 'Handyman · General', 'Morning', '06:00', '14:30'], ['Sunita Devi', 'Handyman · General', 'Morning', '06:05', '14:02']].forEach(([nm, rl, sh, a, b], i) => {
  [1, 2, 3, 4, 5].forEach((n, k) => ATT_ROWS.push(att(`at${i}_${n}`, nm, rl, n, k === 2 && i === 1 ? '06:48' : a, b, sh, k === 2 && i === 1 ? 33 : 0, k === 4 && i === 2)));
});
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };


const CANCEL_DEFAULT = [{ hoursBefore: 72, refundPct: 100 }, { hoursBefore: 24, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }];
const AMENITY_BASE = { overrideRoles: ['president', 'general_secretary', 'facility_manager', 'committee_amenities'], active: true, minNoticeHours: 2, maxAdvanceDays: 90, cancellationRules: CANCEL_DEFAULT, gstMode: 'Exclusive', gstRate: 18, gstApplicable: false, depositAmount: 0, weekendRate: 0 };
const AMENITY_CATALOG = [
  { id: 'at1', name: 'Clubhouse', facility: 'Clubhouse', icon: '🏛', ...AMENITY_BASE, rate: 2500, rateUnit: 'Per day / event', gstApplicable: true, depositAmount: 5000, weekendRate: 3500, minNoticeHours: 48, capacity: 1, hours: '06:00–23:00', bookingMode: 'Full day', rules: '<ul><li>No outside catering without prior approval.</li><li>Deposit refunded within 7 days if no damage.</li></ul>' },
  { id: 'at2', name: 'Pool', facility: 'Swimming pool', icon: '🏊', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', capacity: 1, hours: '06:00–20:00', bookingMode: 'Time slot', rules: '<ul><li>Children under 12 must be accompanied by an adult.</li><li>No glass containers poolside.</li></ul>' },
  { id: 'at3', name: 'Tennis Court', facility: 'Sports courts', icon: '🎾', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 200, rateUnit: 'Per hour', capacity: 1, hours: '06:00–21:00', bookingMode: 'Time slot', rules: '<ul><li>Non-marking shoes only.</li><li>Maximum 2-hour booking per unit per day.</li></ul>' },
  { id: 'at4', name: 'Pickleball Court', facility: 'Sports courts', icon: '🏓', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 150, rateUnit: 'Per hour', capacity: 2, hours: '06:00–22:00', bookingMode: 'Time slot', rules: '<ul><li>Shared court — up to 2 bookings per slot.</li><li>Please vacate promptly at slot end.</li></ul>' },
  { id: 'at5', name: 'Gym', facility: 'Clubhouse', icon: '🏋', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', freeLabel: 'Member access', capacity: 1, hours: '05:00–22:00', bookingMode: 'Full day', rules: '<ul><li>Wipe down equipment after use.</li><li>No personal trainers without registration.</li></ul>' },
  { id: 'at6', name: 'Party Hall - Banquet 1', facility: 'Clubhouse', icon: '🎉', ...AMENITY_BASE, rate: 5000, rateUnit: 'Per day / event', gstApplicable: true, depositAmount: 10000, weekendRate: 7500, minNoticeHours: 72, capacity: 1, hours: '06:00–23:00', bookingMode: 'Full day', cancellationRules: [{ hoursBefore: 168, refundPct: 100 }, { hoursBefore: 72, refundPct: 50 }, { hoursBefore: 0, refundPct: 0 }], rules: '<ul><li>Music must end by 22:00.</li><li>Refundable security deposit required at booking.</li></ul>' },
  { id: 'at7', name: 'Party Hall - Banquet 2', facility: 'Clubhouse', icon: '🎊', ...AMENITY_BASE, rate: 5000, rateUnit: 'Per day / event', gstApplicable: true, depositAmount: 10000, weekendRate: 7500, minNoticeHours: 72, capacity: 1, hours: '06:00–23:00', bookingMode: 'Full day', rules: '<ul><li>Music off by 22:00.</li><li>Caterers register at the gate in advance.</li><li>Hall to be left clean; the deposit is refunded after inspection.</li></ul>' },
  { id: 'at8', name: 'Yoga Room', facility: 'Clubhouse', icon: '🧘', ...AMENITY_BASE, rate: 0, rateUnit: 'Free', capacity: 1, hours: '05:30–21:00', bookingMode: 'Time slot', maxPerMonth: 12, rules: '<ul><li>Book the room for your class or group.</li><li>Leave mats stacked and the AC off.</li></ul>' },
  { id: 'at9', name: 'Badminton Court', facility: 'Clubhouse', icon: '🏸', ...AMENITY_BASE, rate: 100, rateUnit: 'Per hour', capacity: 2, hours: '06:00–22:00', bookingMode: 'Time slot', maxPerDay: 1, rules: '<ul><li>Non-marking shoes only.</li><li>One hour a day per unit when courts are busy.</li></ul>' },
  { id: 'at10', name: 'Squash Court', facility: 'Clubhouse', icon: '🥎', ...AMENITY_BASE, rate: 100, rateUnit: 'Per hour', capacity: 1, hours: '06:00–22:00', bookingMode: 'Time slot', maxPerDay: 1, rules: '<ul><li>Eye protection is compulsory.</li><li>Close the glass door after play.</li></ul>' },
  { id: 'at11', name: 'Sports Room', facility: 'Clubhouse', icon: '🏓', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', capacity: 1, hours: '06:00–22:00', bookingMode: 'Time slot', rules: '<ul><li>Table tennis, carrom and indoor games. Return equipment after use.</li></ul>' },
  { id: 'at12', name: 'Baseball Court', facility: 'Sports courts', icon: '⚾', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', capacity: 1, hours: '06:00–21:00', bookingMode: 'Time slot', rules: '<ul><li>First come, first served. Share the court.</li></ul>' },
  { id: 'at13', name: "Children's Park", facility: "Children's park", icon: '🛝', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', capacity: 1, hours: '06:00–20:00', bookingMode: 'Time slot', rules: '<ul><li>Children below 8 with an adult.</li></ul>' },
  { id: 'at14', name: 'Cricket Box', facility: 'Sports courts', icon: '🏏', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', capacity: 1, hours: '06:00–22:00', bookingMode: 'Time slot', rules: '<ul><li>Tennis ball only. Floodlights switch off at 22:00.</li></ul>' },
  { id: 'at15', name: 'Sand Volleyball Court', facility: 'Sports courts', icon: '🏐', ...AMENITY_BASE, reservation: 'Walk-in (no reservation)', rate: 0, rateUnit: 'Free', capacity: 1, hours: '06:00–21:00', bookingMode: 'Time slot', rules: '<ul><li>First come, first served.</li></ul>' },
  { id: 'at16', name: 'Chairs & Tables Hire', facility: 'Clubhouse', icon: '🪑', ...AMENITY_BASE, reservation: 'Items only (no space)', rate: 0, rateUnit: 'Free', freeLabel: 'Pay per item', capacity: 1, hours: '06:00–23:00', bookingMode: 'Full day', rules: '<ul><li>Hire chairs, tables and cloths for a function at home. Collect from the clubhouse store and return the next morning.</li></ul>' },
].map((a) => ({ ...a, price: priceLabel(a) }));

const AMENITY_SETTINGS_ROW = {
  id: 'ams1', gstin: '36AABCL1234F1ZZ', defaultGstRate: 18, receiptAccount: 'Maintenance', refundMode: 'Credit to unit account', paymentDueHours: 48,
  notifyOwner: true, notifyAdmin: true, reminderOn: true, dailyReport: true, dailyReportTime: '20:00', summaryReport: 'Weekly',
  adminRecipients: [{ channel: 'Email', target: 'facilities@lapaloma.example', label: 'Facility desk' }, { channel: 'WhatsApp', target: '+91 98220 10010', label: 'Amenities committee' }],
  reportRecipients: [{ channel: 'WhatsApp', target: 'La Paloma Amenities group', label: 'WhatsApp group' }, { channel: 'Email', target: 'ec@lapaloma.example', label: 'EC mailing list' }],
  inAppRoleIds: ['facility_manager', 'committee_amenities'],
};

/** A demo booking with its price worked out by the same engine the server uses. */
function demoBooking(id, amenityName, unit, date, slot, { mode = 'UPI', paid = true, status = 'Confirmed', cancel = null } = {}) {
  const am = AMENITY_CATALOG.find((a) => a.name === amenityName);
  const q = quote(am, date, AMENITY_SETTINGS_ROW);
  const slotV = am.bookingMode === 'Full day' ? 'Full day' : slot;
  const isPaid = paid && q.total > 0;
  return {
    id, amenity: amenityName, unit, date, slot: slotV, status, paymentMode: q.total > 0 ? mode : '', rate: q.rate, rateUnit: q.rateUnit, qty: 1, baseAmount: q.base, gstRate: q.gstRate, gstAmount: q.gst, gstMode: q.gstMode,
    feeTotal: q.fee, depositAmount: q.deposit, totalPayable: q.total, paymentStatus: q.total <= 0 ? 'Not required' : isPaid ? 'Paid' : 'Pending', paidAmount: isPaid ? q.total : 0, paidAt: isPaid ? date : '',
    depositStatus: q.deposit > 0 ? (isPaid ? 'Held' : 'Awaiting payment') : 'None', refundStatus: 'None', refundAmount: 0, startAt: startAtOf(date, slotV, am), policySnapshot: tiersOf(am), bookedBy: unit,
    ...(cancel || {}),
  };
}
const AMENITY_BOOKINGS = [
  demoBooking('am1', 'Party Hall - Banquet 1', 'Villa 135', '2026-09-07', 'Full day', { status: 'Completed' }),
  demoBooking('am2', 'Tennis Court', 'A-1204', '2026-09-07', '17:00–18:00', { mode: 'Cash', status: 'Completed' }),
  demoBooking('am3', 'Clubhouse', 'Villa 212', '2026-09-07', 'Full day', { mode: 'Cash', paid: false, status: 'Cancelled', cancel: { paymentStatus: 'Cancelled', cancelledAt: '2026-09-05T10:00:00.000Z', cancelReason: 'Payment not received within 48 hours' } }),
  demoBooking('am4', 'Tennis Court', 'Villa 135', '2026-09-07', '10:00–11:00', { mode: 'Card', status: 'Completed' }),
  demoBooking('am5', 'Party Hall - Banquet 1', 'Villa 135', plusDays(12), 'Full day'),
  demoBooking('am6', 'Tennis Court', 'A-1204', plusDays(1), '17:00–18:00', { mode: 'UPI' }),
  demoBooking('am7', 'Clubhouse', 'Villa 212', plusDays(6), 'Full day', { mode: 'Cash', paid: false, status: 'Pending payment' }),
  demoBooking('am8', 'Pool', 'Villa 135', plusDays(2), '17:00–18:00'),
];


// Infrastructure map demo: positions are in PLAN PIXELS on the La Paloma site plan (4000 x 3413). They are illustrative -
// the committee redraws them to the real poles, pipes and cameras.
const shp = (o) => JSON.stringify(o);
const PT = (x, y, dir) => shp({ t: 'point', c: [x, y], ...(dir !== undefined ? { dir } : {}) });
const LN = (...c) => shp({ t: 'line', c });
const ZN = (...c) => shp({ t: 'zone', c });
const PLAN_ID = 'plan_laPaloma';
const ON_PLAN = { planId: PLAN_ID };
const INFRA_SHAPES = {
  eq1: PT(90, 1450), eq2: PT(130, 1450), eq3: PT(170, 1450), eq4: PT(2930, 2470), eq5: PT(3000, 2470), eq6: PT(2760, 2500), eq7: PT(3040, 2300), eq8: PT(2440, 2700),
  eq11: LN([2528, 320], [2528, 2240], [2448, 2660]), eq12: LN([1290, 1450], [3480, 1450]),
};

// Planned works: the starter checklists, running since about six months ago, with their recent rounds - most done, one with a task Not OK,
// a weekly and a monthly round in progress, and two that were missed (the DG run test last week, the pumps last month).
function plannedSeed() {
  const startsOn = plusDays(-180);
  const lists = STARTERS.map((st, i) => ({ id: `pmc${i + 1}`, ...checklistRow(st, startsOn) }));
  const rounds = []; let n = 0;
  const at = (day, hh) => new Date(`${day}T${hh}:00`).toISOString();
  const round = (c, p, status, mark = () => 'Done', doneBy = 'Ramesh K') => {
    const items = freshItems(c).map((x, i) => ({ ...x, ...mark(x, i) }));
    const done = status === 'Done';
    const day = p.dueOn > isoDay(new Date()) ? isoDay(new Date()) : p.dueOn;
    rounds.push({ id: `pmr${++n}`, checklistId: c.id, period: p.key, dueOn: p.dueOn, status, items: JSON.stringify(items), notes: '', completedAt: done ? at(day, '11:20') : null, doneBy });
  };
  const ok = () => ({ result: 'Done', remark: '' });
  const L = Object.fromEntries(lists.map((c) => [c.name, c]));
  // WTP weekly: the last four weeks done (one with the blower pressure low), this week half done
  const w = L['WTP weekly works']; let p = periodOf(w);
  round(w, p, 'In progress', (x, i) => (i < 3 ? ok() : { result: '' }));
  for (let k = 0; k < 4; k++) { p = previousPeriod(w, p); round(w, p, 'Done', (x, i) => (k === 1 && i === 1 ? { result: 'Not OK', remark: 'Blower 2 pressure low (0.3 bar) - belt slipping' } : i === 4 && k === 2 ? { result: 'N/A', remark: 'Standby blower under repair' } : ok())); }
  // DG weekly: the week before last done, last week missed
  const dg = L['DG set weekly run test']; round(dg, previousPeriod(dg, previousPeriod(dg, periodOf(dg))), 'Done', ok, 'Suresh M');
  // monthly: last month done (the pumps missed it); STP this month in progress
  for (const name of ['WTP monthly works', 'STP monthly works', 'DG set monthly checks', 'Electrical panels monthly checks']) {
    const c = L[name]; round(c, previousPeriod(c, periodOf(c)), 'Done', ok, /DG|Electrical/.test(name) ? 'Suresh M' : 'Ramesh K');
  }
  const stp = L['STP monthly works']; round(stp, periodOf(stp), 'In progress', (x, i) => (i < 4 ? ok() : { result: '' }));
  // the pool yesterday; the tanks' first half-year
  const pool = L['Swimming pool daily checks']; round(pool, previousPeriod(pool, periodOf(pool)), 'Done', (x, i) => (i === 0 ? { result: 'Done', remark: 'Cl 1.8 ppm, pH 7.4' } : ok()), 'Anil P');
  const tanks = L['Water tanks half-yearly cleaning']; const h1 = previousPeriod(tanks, periodOf(tanks));
  if (h1.dueOn >= startsOn) round(tanks, h1, 'Done', ok, 'Anil P');
  return { lists, rounds };
}
const PLANNED = plannedSeed();

const SEED = {
  [COLLECTIONS.COMMUNITY_CONFIG]: [{ id: 'cfg1', region: 'IN', legalName: 'La Paloma Residents’ Welfare Association', address: 'La Paloma Villas, Outer Ring Road, Hyderabad 500081', registrationNo: 'REG/HYD/2019/0412', taxRegistered: 'Yes', taxId: '36AABCL1234F1ZZ', panNo: 'AABCL1234F', website: 'lapaloma.example', receiptThanks: 'Received with thanks', payInstructions: 'Pay by UPI: lapaloma@bank\nOr bank transfer to La Paloma RWA, A/c 0000 0000 0000, IFSC DEMO0000001.\nOffice: 9 am – 6 pm, Mon–Sat.', statementNote: 'Please report any mismatch to the office within 7 days.', contactPhone: '+91 98200 00000', contactEmail: 'office@lapaloma.example', signatory: 'Treasurer', receiptFooter: 'This is a computer-generated receipt and does not require a signature.', propertyTypes: ['Villa', 'Apartment'] }],
  [COLLECTIONS.BLOCKS]: [
    { id: 'blk1', name: 'Maple Enclave', code: 'ME', kind: 'Villa lane / cluster', plannedUnits: 60, active: true, notes: '' },
    { id: 'blk2', name: 'Palm District', code: 'PD', kind: 'Villa lane / cluster', plannedUnits: 90, active: true, notes: '' },
    { id: 'blk3', name: 'Tower A', code: 'A', kind: 'Tower', plannedUnits: 48, active: true, notes: '' },
    { id: 'blk4', name: 'Tower C', code: 'C', kind: 'Tower', plannedUnits: 48, active: true, notes: '' },
  ],
  [COLLECTIONS.FACILITIES]: [
    { id: 'fac1', name: 'Clubhouse', kind: 'Clubhouse', block: '', active: true, notes: '' },
    { id: 'fac2', name: 'Swimming pool', kind: 'Swimming pool', block: '', active: true, notes: '' },
    { id: 'fac3', name: 'Tennis court', kind: 'Sports court', block: '', active: true, notes: '' },
    { id: 'fac4', name: 'Common area', kind: 'Common area', block: '', active: true, notes: '' },
    { id: 'fac5', name: 'STP', kind: 'STP', block: '', active: true, notes: '' },
    { id: 'fac6', name: 'WTP', kind: 'WTP', block: '', active: true, notes: '' },
    { id: 'fac7', name: 'Street lights', kind: 'Street lights', block: '', active: true, notes: '' },
    { id: 'fac8', name: 'Borewell / pumps', kind: 'Borewell / pumps', block: '', active: true, notes: '' },
    { id: 'fac9', name: 'DG room', kind: 'DG room', block: '', active: true, notes: '' },
    { id: 'fac10', name: 'Main gate / security', kind: 'Gate / security', block: '', active: true, notes: '' },
  ],
  [COLLECTIONS.PROPERTIES]: [
    { id: 'p1', unit: 'Villa 135', type: 'Villa', zone: 'Maple Enclave', owner: 'Ananya Mehta', ownerPhone: '+91 98220 10001', ownerEmail: 'ananya.mehta@example.com', tenant: '', tenantPhone: '', people: [{ id: 'pp1', relation: 'Additional owner', name: 'Rohan Mehta', phone: '+91 98220 10002', email: 'rohan.mehta@example.com' }], occupancy: 'Owner occupied', areaSqft: 3200, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 2, domesticStaffCount: 1, possessionDate: '2021-03-15', outstanding: 0 },
    { id: 'p2', unit: 'A-1204', type: 'Apartment', zone: 'Tower A', owner: 'Vikram Shah', ownerPhone: '+91 98220 10003', tenant: 'Kavita Rao', tenantPhone: '+91 98220 10006', people: [], occupancy: 'Tenant occupied', areaSqft: 1450, bedrooms: 3, parking: 1, residentsCount: 3, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2019-11-02', outstanding: 4820 },
    { id: 'p3', unit: 'Villa 212', type: 'Villa', zone: 'Palm District', owner: 'Neha Kapoor', ownerPhone: '+91 98220 10004', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 2900, bedrooms: 4, parking: 2, residentsCount: 5, vehiclesCount: 3, domesticStaffCount: 2, possessionDate: '2020-07-20', outstanding: 12400 },
    { id: 'p4', unit: 'C-0807', type: 'Apartment', zone: 'Tower C', owner: 'H. R. Iyer', ownerPhone: '+91 98220 10005', tenant: '', tenantPhone: '', people: [], occupancy: 'Vacant', areaSqft: 1200, bedrooms: 2, parking: 1, residentsCount: 0, vehiclesCount: 0, domesticStaffCount: 0, possessionDate: '2022-01-10', outstanding: 0 },
    // more owners, so a ballot has a real voter roll (one unit has no registered owner yet: it is listed as unable to vote)
    { id: 'p5', unit: 'Villa 101', type: 'Villa', zone: 'Maple Enclave', owner: 'Suresh Pillai', ownerPhone: '+91 98220 10101', ownerEmail: 'suresh.pillai@example.com', tenant: '', tenantPhone: '', people: [{ id: 'ppp50', relation: 'Additional owner', name: 'Latha Pillai', phone: '+91 98220 10102', email: '' }], occupancy: 'Owner occupied', areaSqft: 3100, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-01-15', outstanding: 0 },
    { id: 'p6', unit: 'Villa 102', type: 'Villa', zone: 'Maple Enclave', owner: 'Farah Khan', ownerPhone: '+91 98220 10103', ownerEmail: 'farah.khan@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 3100, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-02-15', outstanding: 0 },
    { id: 'p7', unit: 'Villa 118', type: 'Villa', zone: 'Maple Enclave', owner: 'Gurpreet Singh', ownerPhone: '+91 98220 10104', ownerEmail: 'gurpreet.singh@example.com', tenant: 'Imran Qureshi', tenantPhone: '+91 98220 10110', people: [], occupancy: 'Tenant occupied', areaSqft: 3300, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-03-15', outstanding: 0 },
    { id: 'p8', unit: 'Villa 140', type: 'Villa', zone: 'Maple Enclave', owner: 'Deepa Menon', ownerPhone: '+91 98220 10105', ownerEmail: 'deepa.menon@example.com', tenant: '', tenantPhone: '', people: [{ id: 'ppp80', relation: 'Additional owner', name: 'Arvind Menon', phone: '+91 98220 10106', email: '' }], occupancy: 'Owner occupied', areaSqft: 3200, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-04-15', outstanding: 0 },
    { id: 'p9', unit: 'Villa 205', type: 'Villa', zone: 'Palm District', owner: 'Rahul Bose', ownerPhone: '+91 98220 10107', ownerEmail: 'rahul.bose@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 2900, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-05-15', outstanding: 0 },
    { id: 'p10', unit: 'Villa 209', type: 'Villa', zone: 'Palm District', owner: 'Sunita Reddy', ownerPhone: '+91 98220 10108', ownerEmail: 'sunita.reddy@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Vacant', areaSqft: 2900, bedrooms: 4, parking: 2, residentsCount: 0, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-06-15', outstanding: 0 },
    { id: 'p11', unit: 'A-0302', type: 'Apartment', zone: 'Tower A', owner: 'Karan Malhotra', ownerPhone: '+91 98220 10109', ownerEmail: 'karan.malhotra@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 1450, bedrooms: 3, parking: 1, residentsCount: 4, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-07-15', outstanding: 0 },
    { id: 'p12', unit: 'C-1101', type: 'Apartment', zone: 'Tower C', owner: '', ownerPhone: '', ownerEmail: '', tenant: '', tenantPhone: '', people: [], occupancy: 'Vacant', areaSqft: 1200, bedrooms: 3, parking: 1, residentsCount: 0, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-08-15', outstanding: 0 },
    // the donors and bookers the sample data's cultural and amenity records name live here
    { id: 'p13', unit: 'Villa 12', type: 'Villa', zone: 'Maple Enclave', owner: 'Meera Joshi', ownerPhone: '+91 98220 10112', ownerEmail: 'meera.joshi@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 2800, bedrooms: 3, parking: 2, residentsCount: 3, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2020-11-10', outstanding: 0 },
    { id: 'p14', unit: 'Villa 48', type: 'Villa', zone: 'Maple Enclave', owner: 'Ravi Kumar', ownerPhone: '+91 98450 12345', ownerEmail: 'ravi.kumar@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 3000, bedrooms: 4, parking: 2, residentsCount: 4, vehiclesCount: 2, domesticStaffCount: 1, possessionDate: '2020-12-05', outstanding: 0 },
    { id: 'p15', unit: 'Villa 77', type: 'Villa', zone: 'Maple Enclave', owner: 'Sunita Rao', ownerPhone: '+91 98220 10111', ownerEmail: 'sunita.rao@example.com', tenant: '', tenantPhone: '', people: [], occupancy: 'Owner occupied', areaSqft: 2800, bedrooms: 3, parking: 1, residentsCount: 2, vehiclesCount: 1, domesticStaffCount: 0, possessionDate: '2021-02-20', outstanding: 0 },
  ],
  [COLLECTIONS.TICKETS]: [
    { id: 't1', ticketNumber: 'TKT-1051', taskType: 'Resident Maintenance', title: 'Kitchen sink leak', description: 'Water pooling under the kitchen sink since this morning.', unit: 'Villa 135', category: 'Plumbing', priority: 'High', status: 'Open', assignedTo: '', slaDueAt: plusDays(0), preferredTime: '', hasPhotos: true, awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Ananya Mehta', createdByRole: 'owner', createdAt: '05 Oct 2026' },
    { id: 't2', ticketNumber: 'TKT-1052', taskType: 'Resident Maintenance', title: 'Lift not working', description: 'Tower A lift stuck between floors 3 and 4.', unit: 'A-1204', category: 'Electrical', priority: 'Critical', status: 'Assigned', assignedTo: 'Suresh Nair', slaDueAt: plusDays(0), preferredTime: '', hasPhotos: false, awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Vikram Shah', createdByRole: 'resident', createdAt: '05 Oct 2026' },
    { id: 't3', ticketNumber: 'TKT-1053', taskType: 'Resident Maintenance', title: 'Garden gate lock broken', description: 'Side gate latch is bent and won’t catch.', unit: 'Villa 212', category: 'Carpentry', priority: 'Medium', status: 'On Hold', assignedTo: 'Manoj Yadav', slaDueAt: plusDays(1), preferredTime: 'After 5pm', hasPhotos: true, awaitingParts: true, materialsCost: 1800, paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Neha Kapoor', createdByRole: 'owner', createdAt: '04 Oct 2026' },
    { id: 't4', ticketNumber: 'TKT-1050', taskType: 'Resident Maintenance', title: 'Lobby deep clean', description: 'Monthly deep-clean request for the C block lobby.', unit: 'C-0807', category: 'Housekeeping', priority: 'Low', status: 'Closed', assignedTo: 'Sunita Devi', slaDueAt: '', preferredTime: '', hasPhotos: false, awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 5, createdBy: 'H. R. Iyer', createdByRole: 'owner', createdAt: '02 Sep 2026' },
    { id: 't5', ticketNumber: 'TKT-1054', taskType: 'Resident Maintenance', title: 'Common area sprinkler stuck on', description: 'Sprinkler near the clubhouse lawn has been running for hours.', unit: '', scope: 'Community', location: 'Clubhouse lawn', category: 'Gardening', priority: 'Medium', status: 'Open', assignedTo: '', slaDueAt: plusDays(0), preferredTime: '', hasPhotos: false, awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Facility Manager', createdByRole: 'facility_manager', createdAt: '06 Oct 2026' },
    { id: 't6', ticketNumber: 'TKT-1055', taskType: 'Purchase', title: 'Replace clubhouse AC compressor', description: 'Clubhouse AHU compressor has failed; needs replacement unit sourced and fitted.', unit: '', scope: 'Community', location: 'Clubhouse', category: 'MEP', priority: 'High', status: 'In Progress', assignedTo: 'Rohit Verma', slaDueAt: plusDays(5), preferredTime: '', hasPhotos: false, awaitingParts: false, materialsCost: 0, financial: true, selectedQuotationId: 'q1', approvedAmount: 185000, ecApproval: 'Approved', ecApprovedBy: 'Arjun Nair', ecApprovedAt: '2026-09-27', treasurerApproval: 'Approved', treasurerApprovedBy: 'Gautam Shah', treasurerApprovedAt: '2026-09-29', approvalStage: 'Quotation', paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Gautam Shah', createdByRole: 'treasurer', createdAt: '28 Sep 2026' },
    { id: 't7', ticketNumber: 'TKT-1056', taskType: 'EC Maintenance', title: 'Pool deck tile repair', description: 'Cracked tiles near the pool steps flagged by the Amenities Committee.', unit: '', scope: 'Community', location: 'Swimming pool deck', category: 'General', priority: 'Medium', status: 'Assigned', assignedTo: 'Rohit Verma', slaDueAt: plusDays(7), preferredTime: '', hasPhotos: true, awaitingParts: false, materialsCost: 0, financial: true, selectedQuotationId: 'q4', approvedAmount: 86000, approvalStage: 'Quotation', ecApproval: 'Pending', treasurerApproval: 'Pending', paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Amenities Committee', createdByRole: 'committee_amenities', createdAt: '30 Sep 2026' },
    { id: 't30', ticketNumber: 'TKT-1057', taskType: 'EC Maintenance', title: 'Borewell 2: motor not delivering water', description: 'Submersible motor pulled out; rewinding or replacement to be decided.<p><i>Raised from the Infrastructure map for Borewell submersible 2.</i></p>', unit: '', category: 'Plumbing', priority: 'High', status: 'In Progress', assignedTo: 'Rohit Verma', slaDueAt: plusDays(5), preferredTime: '', scope: 'Community', location: 'Borewell / Borewell submersible 2', hasPhotos: false, awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 0, createdBy: 'Facility Manager', createdByRole: 'facility_manager', createdAt: '02 Oct 2026', assetId: 'eq7', assetName: 'Borewell submersible 2' },
  ],
  [COLLECTIONS.TASK_TYPES]: [
    { id: 'tt_resident', residentDefault: true, name: 'Resident Maintenance', icon: '🔧', creatorScope: 'Resident', assignmentMode: 'Role queue (staff accepts)', quotationStage: 'No', ecApprovalStage: 'No', treasurerStage: 'No', invoiceStage: 'No', paymentStage: 'No', residentVisible: true },
    { id: 'tt_ecmaint', name: 'EC Maintenance', icon: '🛠', creatorScope: 'EC / Staff', assignmentMode: 'Direct assign', quotationStage: 'Optional', ecApprovalStage: 'Optional', treasurerStage: 'Optional', invoiceStage: 'Optional', paymentStage: 'Optional', residentVisible: false },
    { id: 'tt_purchase', name: 'Purchase', icon: '🧾', creatorScope: 'EC / Staff', assignmentMode: 'Direct assign', quotationStage: 'Optional', ecApprovalStage: 'Yes', treasurerStage: 'Yes', invoiceStage: 'Yes', paymentStage: 'Yes', residentVisible: false },
    { id: 'tt_capital', name: 'Capital Project', icon: '🏗', creatorScope: 'EC / Staff', assignmentMode: 'Direct assign', quotationStage: 'Optional', ecApprovalStage: 'Yes', treasurerStage: 'Yes', invoiceStage: 'Yes', paymentStage: 'Yes', residentVisible: false },
    { id: 'tt_emergency', name: 'Emergency', icon: '🚨', creatorScope: 'EC / Staff', assignmentMode: 'Direct assign', quotationStage: 'Optional', ecApprovalStage: 'Optional', treasurerStage: 'Optional', invoiceStage: 'Optional', paymentStage: 'Optional', residentVisible: false },
    { id: 'tt_pest', name: 'Pest Control', icon: '🐜', creatorScope: 'Anyone', assignmentMode: 'Role queue (staff accepts)', quotationStage: 'No', ecApprovalStage: 'No', treasurerStage: 'No', invoiceStage: 'No', paymentStage: 'No', residentVisible: true },
  ],
  [COLLECTIONS.TICKET_COMMENTS]: [
    { id: 'tc1', ticketId: 't1', author: 'Ananya Mehta', authorRoleId: 'owner', visibility: 'Public', body: 'Water is leaking below the wash basin.', createdAt: '2026-10-05T09:12:00.000Z' },
    { id: 'tc2', ticketId: 't1', author: 'Facility Manager', authorRoleId: 'facility_manager', visibility: 'Internal', body: 'Queued for Plumbing - low priority parts in stock.', createdAt: '2026-10-05T09:20:00.000Z' },
    { id: 'tc3', ticketId: 't3', author: 'Manoj Yadav', authorRoleId: 'handyman_general', visibility: 'Public', body: 'Hardware ordered, will fit the new latch tomorrow afternoon.', createdAt: '2026-10-04T15:40:00.000Z' },
    { id: 'tc4', ticketId: 't3', author: 'Facility Manager', authorRoleId: 'facility_manager', visibility: 'Internal', body: 'Vendor confirmed hardware delivery for tomorrow morning.', createdAt: '2026-10-04T16:05:00.000Z' },
    { id: 'tc5', ticketId: 't4', author: 'H. R. Iyer', authorRoleId: 'owner', visibility: 'Public', body: 'Looks great, thank you!', createdAt: '2026-09-02T18:00:00.000Z' },
    { id: 'tc6', ticketId: 't6', author: 'Gautam Shah', authorRoleId: 'treasurer', visibility: 'Internal', body: 'Quotation approved against the Sinking fund - go ahead with the replacement.', createdAt: '2026-09-29T11:00:00.000Z' },
  ],
  [COLLECTIONS.WISHES]: [
    { id: 'w1', shortId: 'WSH-0001', title: 'Benches along the walking track', description: '<p>The track is popular in the evenings but there is nowhere to sit. Three or four benches near the park end would help seniors especially.</p>', category: 'Landscape', location: 'Walking track', unit: 'Villa 135', raisedBy: 'Owner', status: 'Under review', votes: ['Villa 135', 'Villa 212', 'A-1204', 'C-0807'], createdAt: '02 Oct 2026', createdStamp: '2026-10-02T09:00:00.000Z' },
    { id: 'w2', shortId: 'WSH-0002', title: 'Speed bumps near Gate 2', description: '<p>Cars come in fast from the main road. Two speed bumps before the first villa row.</p>', category: 'Security', location: 'Gate 2', unit: 'Villa 212', raisedBy: 'Owner', status: 'Submitted', votes: ['Villa 212', 'Villa 135'], createdAt: '08 Oct 2026', createdStamp: '2026-10-08T09:00:00.000Z' },
    { id: 'w3', shortId: 'WSH-0003', title: 'Second treadmill for the gym', description: '', category: 'Amenities', location: 'Clubhouse gym', unit: '', raisedBy: 'Secretary', status: 'Planned', votes: ['A-1204'], estimate: 85000, createdAt: '25 Sep 2026', createdStamp: '2026-09-25T09:00:00.000Z' },
  ],
  [COLLECTIONS.QUICK_PHRASES]: [
    { id: 'qp1', phrase: 'Send a plumber', category: 'Plumbing' },
    { id: 'qp2', phrase: 'No power in my villa', category: 'Electrical' },
    { id: 'qp9', phrase: 'No water in my villa', category: 'Plumbing' },
    { id: 'qp3', phrase: 'AC / MEP issue', category: 'MEP' },
    { id: 'qp4', phrase: 'Broken lock / door', category: 'Carpentry' },
    { id: 'qp5', phrase: 'Housekeeping request', category: 'Housekeeping' },
    { id: 'qp6', phrase: 'Garden / landscaping issue', category: 'Gardening' },
    { id: 'qp7', phrase: 'Security concern', category: 'Security' },
    { id: 'qp8', phrase: 'General helpdesk query', category: 'Helpdesk' },
  ],
  [COLLECTIONS.HANDYMEN]: [
    { id: 'h1', name: 'Ramesh Kumar', trade: 'Plumbing', shift: 'Morning', phone: '+91 98450 11221', clockedIn: true },
    { id: 'h2', name: 'Iqbal Ahmed', trade: 'Plumbing', shift: 'Afternoon', phone: '+91 98450 11222', clockedIn: false },
    { id: 'h3', name: 'Suresh Nair', trade: 'Electrical', shift: 'Morning', phone: '+91 98450 11223', clockedIn: true },
    { id: 'h4', name: 'Manoj Yadav', trade: 'Carpentry', shift: 'Morning', phone: '+91 98450 11224', clockedIn: true },
    { id: 'h5', name: 'Sunita Devi', trade: 'Housekeeping', shift: 'Morning', phone: '+91 98450 11225', clockedIn: true },
    { id: 'h6', name: 'Bhola Ram', trade: 'Gardening', shift: 'Morning', phone: '+91 98450 11226', clockedIn: true },
    { id: 'h7', name: 'Farhan Sheikh', trade: 'MEP', shift: 'Morning', phone: '+91 98450 11227', clockedIn: true },
    { id: 'h8', name: 'Devendra Singh', trade: 'Security', shift: 'Morning', phone: '+91 98450 11228', clockedIn: true },
    { id: 'h9', name: 'Lokesh Pillai', trade: 'General', shift: 'Afternoon', phone: '+91 98450 11229', clockedIn: false },
  ],
  [COLLECTIONS.TRADE_AVAILABILITY]: [
    { id: 'ta1', trade: 'Plumbing', available: 7, assigned: 11, offShift: 2, slaPct: 97.8 },
    { id: 'ta2', trade: 'Electrical', available: 6, assigned: 9, offShift: 1, slaPct: 95.2 },
    { id: 'ta3', trade: 'Carpentry', available: 4, assigned: 8, offShift: 2, slaPct: 92.4 },
    { id: 'ta4', trade: 'Gardening', available: 9, assigned: 5, offShift: 5, slaPct: 96.1 },
  ],
  [COLLECTIONS.DUES]: [
    { id: 'd1', unit: 'A-1204', category: 'Maintenance', amount: 4820, billedMonth: 'Sep 2026', dueDate: '2026-09-10', status: 'Unpaid', paymentMode: '' },
    { id: 'd2', unit: 'Villa 212', category: 'DG', amount: 1864, billedMonth: 'Aug 2026', dueDate: '2026-08-31', status: 'Overdue', paymentMode: '', readingId: 'r-d2', previousReading: 1210, currentReading: 1322, unitsConsumed: 112, ratePerUnit: 14, fixedCharge: 250, tax: 46, notice: 'Dear owner of Villa 212,\n\nDG power bill for Aug 2026\nMeter: 1210 → 1322 = 112 units\nRate: ₹14 per unit · Fixed charge ₹250 · Tax ₹46\nAmount payable: ₹1864 by 31 Aug 2026.\n\nThank you,\nManagement' },
    { id: 'd3', unit: 'Villa 135', category: 'DG', amount: 1864, billedMonth: 'Aug 2026', dueDate: '2026-08-31', status: 'Paid', paymentMode: 'UPI', readingId: 'r-d3', previousReading: 880, currentReading: 992, unitsConsumed: 112, ratePerUnit: 14, fixedCharge: 250, tax: 46, notice: 'Dear owner of Villa 135,\n\nDG power bill for Aug 2026\nMeter: 880 → 992 = 112 units\nRate: ₹14 per unit · Fixed charge ₹250 · Tax ₹46\nAmount payable: ₹1864 by 31 Aug 2026.\n\nThank you,\nManagement' },
    { id: 'd4', unit: 'Villa 135', category: 'Water', amount: 722, billedMonth: 'Aug 2026', dueDate: '2026-08-31', status: 'Paid', paymentMode: 'UPI', readingId: 'r-d4', previousReading: 162, currentReading: 198, unitsConsumed: 36, ratePerUnit: 18, fixedCharge: 60, tax: 14, notice: 'Dear owner of Villa 135,\n\nWater bill for Aug 2026\nMeter: 162 → 198 = 36 kL\nRate: ₹18 per unit · Fixed charge ₹60 · Tax ₹14\nAmount payable: ₹722 by 31 Aug 2026.\n\nThank you,\nManagement' },
    { id: 'd5', unit: 'Villa 135', category: 'Maintenance', amount: 5000, billedMonth: 'Apr 2026', dueDate: '2026-04-10', status: 'Paid', paymentMode: 'Net banking' },
    { id: 'd6', unit: 'A-1204', category: 'Maintenance', amount: 4820, billedMonth: 'Apr 2026', dueDate: '2026-04-10', status: 'Unpaid', paymentMode: '' },
    { id: 'd7', unit: 'Villa 135', category: 'Maintenance', amount: 5000, billedMonth: 'May 2026', dueDate: '2026-05-10', status: 'Paid', paymentMode: 'Card' },
    { id: 'd8', unit: 'Villa 212', category: 'Maintenance', amount: 5200, billedMonth: 'May 2026', dueDate: '2026-05-10', status: 'Paid', paymentMode: 'Cheque' },
    { id: 'd9', unit: 'A-1204', category: 'Maintenance', amount: 4820, billedMonth: 'Jun 2026', dueDate: '2026-06-10', status: 'Paid', paymentMode: 'UPI' },
    { id: 'd10', unit: 'C-0807', category: 'Maintenance', amount: 3600, billedMonth: 'Jun 2026', dueDate: '2026-06-10', status: 'Unpaid', paymentMode: '' },
    { id: 'd11', unit: 'Villa 135', category: 'Maintenance', amount: 5000, billedMonth: 'Jul 2026', dueDate: '2026-07-10', status: 'Paid', paymentMode: 'UPI' },
    { id: 'd12', unit: 'Villa 212', category: 'Maintenance', amount: 5200, billedMonth: 'Jul 2026', dueDate: '2026-07-10', status: 'Paid', paymentMode: 'Cash' },
    { id: 'd13', unit: 'Villa 135', category: 'Water', amount: 658, billedMonth: 'Sep 2026', dueDate: '2026-10-20', status: 'Unpaid', paymentMode: '', readingId: 'r1', previousReading: 198, currentReading: 230, unitsConsumed: 32, ratePerUnit: 18, fixedCharge: 60, tax: 22, notice: 'Dear resident,\n\nYour Water bill of ₹658 for Sep 2026 is now due by 2026-10-20.\n\nThank you,\nCedar Grove Residences Management', photos: [] },
  ],
  [COLLECTIONS.FUNDS]: [
    { id: 'f1', name: 'Maintenance', kind: 'Operating', balance: 0, annualBudget: 0 },
    { id: 'f2', name: 'Corpus', kind: 'Corpus', balance: 0, annualBudget: 0 },
    { id: 'f3', name: 'Sinking', kind: 'Sinking', balance: 0, annualBudget: 0 },
    { id: 'f4', name: 'Electricity/Water/Tax', kind: 'Operating', balance: 0, annualBudget: 0 },
    { id: 'f5', name: 'Cultural', kind: 'Restricted', balance: 0, annualBudget: 0 },
    { id: 'f6', name: 'Ganesh', kind: 'Restricted', balance: 0, annualBudget: 0 },
  ],
  [COLLECTIONS.BILLING_TEMPLATES]: [
    { id: 'bt1', type: 'DG', ratePerUnit: 6.25, fixedCharge: 120, tax: 69 },
    { id: 'bt2', type: 'Water', ratePerUnit: 18, fixedCharge: 60, tax: 22 },
  ],
  [COLLECTIONS.LEDGER]: [
    { id: 'lo1', date: '2026-08-14', account: 'Maintenance', description: 'Amenity booking AMB-0001 - fee (taxable ₹2,500 + GST ₹450)', category: 'Amenity', type: 'Credit', amount: 2950, unit: 'Villa 12', baseAmount: 2500, gstRate: 18, gstAmount: 450 },
    { id: 'lo2', date: '2026-09-06', account: 'Maintenance', description: 'Amenity booking AMB-0002 - fee (taxable ₹1,200 + GST ₹216)', category: 'Amenity', type: 'Credit', amount: 1416, unit: 'Villa 48', baseAmount: 1200, gstRate: 18, gstAmount: 216 },
    { id: 'lo3', date: '2026-09-27', account: 'Maintenance', description: 'Amenity booking AMB-0003 - fee (taxable ₹5,000 + GST ₹900)', category: 'Amenity', type: 'Credit', amount: 5900, unit: 'Villa 101', baseAmount: 5000, gstRate: 18, gstAmount: 900 },
    { id: 'l1', date: '2026-09-01', account: 'Electricity/Water/Tax', description: 'DG diesel top-up', category: 'DG', type: 'Debit', amount: 42000, vendor: 'ARC Facility Management', baseAmount: 35593.22, gstRate: 18, gstAmount: 6406.78, invoiceNo: 'ARC/0921' },
    { id: 'l2', date: '2026-09-03', account: 'Maintenance', description: 'September maintenance collections', type: 'Credit', amount: 480000, vendor: '' },
    { id: 'l3', date: '2026-08-28', account: 'Sinking', description: 'Pool deck renovation — phase 1', category: 'Amenities', type: 'Debit', amount: 1200000, vendor: 'ARC Facility Management', baseAmount: 1016949.15, gstRate: 18, gstAmount: 183050.85, invoiceNo: 'ARC/0815' },
    { id: 'l4', date: '2026-09-15', account: 'Maintenance', description: 'Lift AMC — Q3 instalment', category: 'MEP', type: 'Debit', amount: 96000, vendor: 'Otis Lift Services', baseAmount: 81355.93, gstRate: 18, gstAmount: 14644.07, invoiceNo: 'OLS-3391' },
    { id: 'l5', date: '2026-09-18', account: 'Maintenance', description: 'Replaced 12 corridor MCBs and lights', category: 'Electrical', type: 'Debit', amount: 7400, vendor: 'Sri Ganesh Electricals', baseAmount: 6271.19, gstRate: 18, gstAmount: 1128.81, invoiceNo: 'SGE-118' },
    { id: 'l6', date: '2026-04-04', account: 'Maintenance', description: 'April maintenance collections', type: 'Credit', amount: 455000, vendor: '' },
    { id: 'l7', date: '2026-04-20', account: 'Maintenance', description: 'Housekeeping contract — April', category: 'Housekeeping', type: 'Debit', amount: 118000, vendor: 'ARC Facility Management', baseAmount: 100000, gstRate: 18, gstAmount: 18000, invoiceNo: 'ARC/0412' },
    { id: 'l8', date: '2026-05-05', account: 'Maintenance', description: 'May maintenance collections', type: 'Credit', amount: 462000, vendor: '' },
    { id: 'l9', date: '2026-05-22', account: 'Maintenance', description: 'Security guard payroll — May', category: 'Security', type: 'Debit', amount: 236000, vendor: 'SecureFirst', baseAmount: 200000, gstRate: 18, gstAmount: 36000, invoiceNo: 'SF-2205' },
    { id: 'l10', date: '2026-06-04', account: 'Maintenance', description: 'June maintenance collections', type: 'Credit', amount: 470000, vendor: '' },
    { id: 'l11', date: '2026-06-18', account: 'Maintenance', description: 'Garden supplies and pruning', category: 'Gardening', type: 'Debit', amount: 29500, vendor: 'Sri Ganesh Electricals', baseAmount: 25000, gstRate: 18, gstAmount: 4500, invoiceNo: 'SGE-097' },
    { id: 'l12', date: '2026-07-03', account: 'Maintenance', description: 'July maintenance collections', type: 'Credit', amount: 468000, vendor: '' },
    { id: 'l13', date: '2026-07-14', account: 'Corpus', description: 'Corpus contributions — new owners', type: 'Credit', amount: 300000, vendor: '' },
    { id: 'l14', date: '2026-07-25', account: 'Maintenance', description: 'Security guard payroll — July', category: 'Security', type: 'Debit', amount: 236000, vendor: 'SecureFirst', baseAmount: 200000, gstRate: 18, gstAmount: 36000, invoiceNo: 'SF-2207' },
    { id: 'l15', date: '2026-08-04', account: 'Maintenance', description: 'August maintenance collections', type: 'Credit', amount: 472000, vendor: '' },
    { id: 'l17', date: '2026-08-31', account: 'Electricity/Water/Tax', description: 'DG bill · Aug 2026 · Villa 135', category: 'DG', type: 'Credit', amount: 1864, vendor: '', sourceId: 'due:d3', sourceType: 'due', module: 'Utilities', unit: 'Villa 135', mode: 'UPI', reconStatus: 'Unreconciled' },
    { id: 'l18', date: '2026-08-31', account: 'Electricity/Water/Tax', description: 'Water bill · Aug 2026 · Villa 135', category: 'Water', type: 'Credit', amount: 722, vendor: '', sourceId: 'due:d4', sourceType: 'due', module: 'Utilities', unit: 'Villa 135', mode: 'UPI', reconStatus: 'Unreconciled' },
    { id: 'l16', date: '2026-08-19', account: 'Maintenance', description: 'Pest control — quarterly', category: 'Housekeeping', type: 'Debit', amount: 21240, vendor: 'GreenShield Pest Control', baseAmount: 18000, gstRate: 18, gstAmount: 3240, invoiceNo: 'GS-441' },
  ],
  [COLLECTIONS.TAX_SETTINGS]: [{ id: 'default', registered: 'No', annualTurnover: 0, registrationThreshold: 2000000, limitPerMonth: 7500, note: '', itcAuto: true }],
  [COLLECTIONS.TAX_COMPONENTS]: [
    { id: 'tc1', category: 'Maintenance', mode: 'Counts toward limit', gstRate: 18, account: 'Maintenance', reason: 'Default. Confirm with your CA.' },
    { id: 'tc2', category: 'Sinking fund', mode: 'Counts toward limit', gstRate: 18, account: 'Sinking', reason: 'Default. Confirm with your CA whether it counts.' },
    { id: 'tc3', category: 'Corpus fund', mode: 'Counts toward limit', gstRate: 18, account: 'Corpus', reason: 'Default. Confirm with your CA whether it counts.' },
    { id: 'tc4', category: 'Special levy', mode: 'Counts toward limit', gstRate: 18, account: 'Sinking', reason: 'Default. Confirm with your CA.' },
    { id: 'tc5', category: 'DG', mode: 'Excluded (pass-through)', gstRate: 0, account: 'Electricity/Water/Tax', reason: 'Billed at actual cost. Confirm with your CA.' },
    { id: 'tc6', category: 'Water', mode: 'Excluded (pass-through)', gstRate: 0, account: 'Electricity/Water/Tax', reason: 'Billed at actual cost. Confirm with your CA.' },
    { id: 'tc7', category: 'Amenity booking', mode: 'Taxed separately', gstRate: 18, account: 'Maintenance', reason: 'Amenity fees carry their own GST.' },
    { id: 'tc8', category: 'Late fee', mode: 'Counts toward limit', gstRate: 18, account: 'Maintenance', reason: 'Default. Confirm with your CA.' },
    { id: 'tc9', category: 'Adjustment', mode: 'Excluded (pass-through)', gstRate: 0, account: 'Maintenance', reason: 'Corrections only.' },
    { id: 'tc10', category: 'Other', mode: 'Counts toward limit', gstRate: 18, account: 'Maintenance', reason: 'Default. Confirm with your CA.' },
  ],
  [COLLECTIONS.PAYMENT_ROUTING]: [
    { id: 'pr1', module: 'Maintenance', account: 'Maintenance' }, { id: 'pr2', module: 'Cultural', account: 'Cultural' }, { id: 'pr3', module: 'Utilities', account: 'Electricity/Water/Tax' },
    { id: 'pr4', module: 'Amenities', account: 'Maintenance' }, { id: 'pr5', module: 'Dues', account: 'Maintenance' }, { id: 'pr6', module: 'Capex / projects', account: 'Sinking' },
  ],
  [COLLECTIONS.AUDITS]: [
    { id: 'au1', area: 'STP (sewage treatment)', auditDate: '2026-04-12', auditor: 'EcoTest Labs', auditorVendorId: 'v5', result: 'Pass with observations', score: 82, frequencyMonths: 6, nextDue: '2026-10-12', visibility: 'Published', findings: '<p>Outlet BOD slightly high in the April sample; blower 2 noisy.</p>', actions: '<p>Service blower 2 and re-test outlet BOD within 30 days.</p>',
      parameters: [{ name: 'pH', value: '7.4', unit: '', min: '6.5', max: '8.5' }, { name: 'BOD', value: '24', unit: 'mg/L', min: '', max: '30' }, { name: 'COD', value: '210', unit: 'mg/L', min: '', max: '250' }, { name: 'TSS', value: '38', unit: 'mg/L', min: '', max: '30' }], report: [] },
    { id: 'au2', area: 'STP (sewage treatment)', auditDate: '2025-10-08', auditor: 'EcoTest Labs', auditorVendorId: 'v5', result: 'Pass', score: 91, frequencyMonths: 6, nextDue: '2026-04-08', visibility: 'Published', findings: '<p>All parameters within limits.</p>', actions: '',
      parameters: [{ name: 'pH', value: '7.2', unit: '', min: '6.5', max: '8.5' }, { name: 'BOD', value: '18', unit: 'mg/L', min: '', max: '30' }, { name: 'COD', value: '176', unit: 'mg/L', min: '', max: '250' }, { name: 'TSS', value: '22', unit: 'mg/L', min: '', max: '30' }], report: [] },
    { id: 'au3', area: 'Swimming pool water', auditDate: '2026-08-20', auditor: 'AquaSafe Services', auditorVendorId: 'v6', result: 'Pass', score: 94, frequencyMonths: 3, nextDue: '2026-11-20', visibility: 'Published', findings: '<p>Water clarity and sanitiser levels are good.</p>', actions: '',
      parameters: [{ name: 'Free chlorine', value: '1.4', unit: 'ppm', min: '1', max: '3' }, { name: 'pH', value: '7.5', unit: '', min: '7.2', max: '7.8' }, { name: 'Total alkalinity', value: '95', unit: 'ppm', min: '80', max: '120' }], report: [] },
    { id: 'au4', area: 'Swimming pool water', auditDate: '2026-05-21', auditor: 'AquaSafe Services', auditorVendorId: 'v6', result: 'Pass with observations', score: 79, frequencyMonths: 3, nextDue: '2026-08-21', visibility: 'Published', findings: '<p>Free chlorine low on the day of testing; dosing pump recalibrated.</p>', actions: '<p>Recalibrate chlorine dosing pump.</p>',
      parameters: [{ name: 'Free chlorine', value: '0.6', unit: 'ppm', min: '1', max: '3' }, { name: 'pH', value: '7.6', unit: '', min: '7.2', max: '7.8' }, { name: 'Total alkalinity', value: '88', unit: 'ppm', min: '80', max: '120' }], report: [] },
    { id: 'au5', area: 'WTP (water treatment)', auditDate: '2026-02-10', auditor: 'EcoTest Labs', auditorVendorId: 'v5', result: 'Pass', score: 88, frequencyMonths: 6, nextDue: '2026-08-10', visibility: 'Internal', findings: '<p>Filter media due for replacement next year.</p>', actions: '', parameters: [{ name: 'TDS', value: '320', unit: 'mg/L', min: '', max: '500' }, { name: 'Turbidity', value: '0.8', unit: 'NTU', min: '', max: '1' }], report: [] },
    { id: 'au6', area: 'Fire safety', auditDate: '2026-06-15', auditor: 'Fire Safety Consultants', auditorVendorId: 'v7', result: 'Pass', score: 96, frequencyMonths: 12, nextDue: '2027-06-15', visibility: 'Internal', findings: '<p>Extinguishers and hydrant pressure tested.</p>', actions: '', parameters: [], report: [] },
  ],
  [COLLECTIONS.SERVICE_CONTACTS]: [
    { id: 'sc1', name: 'Ramu Plumbing Works', category: 'Plumber', phone: '+91 98450 31122', area: 'Near Gate 2', rate: '₹400 per visit', notes: 'Fixes leaks the same day. Brings his own parts.', addedBy: 'Ananya Mehta', addedByUnit: 'Villa 135', status: 'Active' },
    { id: 'sc2', name: 'Sheela Devi', category: 'Cook', phone: '+91 98450 44567', area: 'Lives in the community', rate: '₹6,000 a month', notes: 'South Indian and North Indian; mornings only.', addedBy: 'Neha Kapoor', addedByUnit: 'Villa 212', status: 'Active' },
    { id: 'sc3', name: 'Imran Khan', category: 'Driver', phone: '+91 98450 77889', area: 'Airport runs too', rate: '₹250 per hour', notes: 'Punctual, own sedan and SUV.', addedBy: 'Vikram Shah', addedByUnit: 'A-1204', status: 'Active' },
    { id: 'sc4', name: 'Coolbreeze AC Care', category: 'AC technician', phone: '+91 98450 90011', area: 'All villas', rate: '₹700 per service', notes: 'Annual contracts available.', addedBy: 'H. R. Iyer', addedByUnit: 'C-0807', status: 'Active' },
  ],
  [COLLECTIONS.CONTACT_REVIEWS]: [
    { id: 'cr1', contactId: 'sc1', rating: 5, comment: 'Came within an hour and fixed the sink leak.', recommend: 'Yes', author: 'Ananya Mehta', unit: 'Villa 135', createdAt: '2026-09-02T10:00:00.000Z' },
    { id: 'cr2', contactId: 'sc1', rating: 4, comment: 'Good work, a little late.', recommend: 'Yes', author: 'Vikram Shah', unit: 'A-1204', createdAt: '2026-09-20T10:00:00.000Z' },
    { id: 'cr3', contactId: 'sc2', rating: 5, comment: 'Excellent cook, very clean kitchen habits.', recommend: 'Yes', author: 'Neha Kapoor', unit: 'Villa 212', createdAt: '2026-08-11T10:00:00.000Z' },
    { id: 'cr4', contactId: 'sc3', rating: 3, comment: 'Fine, but charged extra for waiting.', recommend: 'Yes', author: 'Ananya Mehta', unit: 'Villa 135', createdAt: '2026-09-10T10:00:00.000Z' },
  ],
  [COLLECTIONS.VENDOR_COMMENTS]: [
    { id: 'vc1', vendorId: 'v3', author: 'Rohit Verma', authorRoleId: 'facility_manager', body: '<p>Lift 4 tripped twice last week - raised with Otis, technician visiting Thursday.</p>', createdAt: '2026-10-02T10:15:00.000Z' },
    { id: 'vc2', vendorId: 'v1', author: 'Arjun Nair', authorRoleId: 'president', body: '<p>Please share the revised manpower roster before the next EC meeting.</p>', createdAt: '2026-10-01T16:40:00.000Z' },
  ],
  [COLLECTIONS.INVENTORY_RULES]: DEFAULT_RULES.map((r, i) => ({ id: `ir${i + 1}`, matchOn: 'Item description', active: true, ...r })),
  [COLLECTIONS.INVENTORY]: [
    { id: 'iv1', item: 'LED tube light 18W', category: 'Electrical', quantity: 46, uom: 'Nos', minStock: 20, stockStatus: 'In stock', location: 'Main store', vendor: 'Sri Ganesh Electricals', lastRestocked: '2026-09-18', notes: '', attachments: [] },
    { id: 'iv2', item: 'MCB 16A single pole', category: 'Electrical', quantity: 6, uom: 'Nos', minStock: 10, stockStatus: 'Low', location: 'Main store', vendor: 'Sri Ganesh Electricals', lastRestocked: '2026-09-18', notes: 'Used for corridor DB replacements', attachments: [] },
    { id: 'iv3', item: 'CPVC elbow 1 inch', category: 'Plumbing', quantity: 40, uom: 'Nos', minStock: 15, stockStatus: 'In stock', location: 'Main store', vendor: 'ARC Facility Management', lastRestocked: '2026-08-30', notes: '', attachments: [] },
    { id: 'iv4', item: 'Pool chlorine granules', category: 'Amenities', quantity: 0, uom: 'Kg', minStock: 25, stockStatus: 'Out of stock', location: 'Clubhouse', vendor: '', lastRestocked: '2026-08-05', notes: 'Order before the weekend', attachments: [] },
    { id: 'iv5', item: 'Floor cleaner concentrate', category: 'Housekeeping', quantity: 18, uom: 'Litres', minStock: 10, stockStatus: 'In stock', location: 'Main store', vendor: 'ARC Facility Management', lastRestocked: '2026-09-25', notes: '', attachments: [] },
    { id: 'iv6', item: 'Sprinkler nozzle', category: 'Gardening', quantity: 12, uom: 'Nos', minStock: 12, stockStatus: 'In stock', location: 'Main store', vendor: '', lastRestocked: '2026-07-14', notes: '', attachments: [] },
    { id: 'iv7', item: 'Mechanical seal 25 mm (STP pump)', category: 'MEP', location: 'STP', quantity: 2, uom: 'Nos', minStock: 2, stockStatus: 'Low', vendor: 'ARC Facility Management', lastRestocked: '2026-07-12', notes: 'Fits inlet pump 1', attachments: [] },
    { id: 'iv8', item: 'Blower V-belt B-62', category: 'MEP', location: 'STP', quantity: 4, uom: 'Nos', minStock: 2, stockStatus: 'In stock', vendor: '', lastRestocked: '2026-08-20', notes: '', attachments: [] },
    { id: 'iv9', item: 'Chlorine dosing pump diaphragm', category: 'MEP', location: 'WTP', quantity: 1, uom: 'Nos', minStock: 1, stockStatus: 'Low', vendor: '', lastRestocked: '2026-06-30', notes: '', attachments: [] },
    { id: 'iv10', item: 'Pool filter sand', category: 'Amenities', location: 'Clubhouse', quantity: 10, uom: 'Boxes', minStock: 4, stockStatus: 'In stock', vendor: '', lastRestocked: '2026-09-05', notes: '', attachments: [] },
    { id: 'iv11', item: 'Shuttle cock tubes', category: 'Amenities', location: 'Clubhouse', quantity: 3, uom: 'Boxes', minStock: 3, stockStatus: 'Low', vendor: '', lastRestocked: '2026-08-12', notes: '', attachments: [] },
  ],
  [COLLECTIONS.READINGS]: [
    { id: 'r1', unit: 'Villa 135', utility: 'Water', month: '2026-09', readingDate: '2026-09-30', previousReading: 198, currentReading: 230, unitsConsumed: 32, photos: [], notes: '', status: 'Published', publishedAt: '2026-10-02', dueId: 'd13' },
    { id: 'r2', unit: 'Villa 135', utility: 'DG', month: '2026-09', readingDate: '2026-09-30', previousReading: 14288, currentReading: 14556, unitsConsumed: 268, photos: [], notes: '', status: 'Draft', publishedAt: '', dueId: '' },
    { id: 'r3', unit: 'Villa 212', utility: 'Water', month: '2026-09', readingDate: '2026-09-30', previousReading: 310, currentReading: 361, unitsConsumed: 51, photos: [], notes: 'Meter face dirty - photo retaken', status: 'Draft', publishedAt: '', dueId: '' },
  ],
  [COLLECTIONS.WORKFORCE]: [
    { id: 'w1', team: 'Maintenance', onDuty: 38, total: 42 },
    { id: 'w2', team: 'Security', onDuty: 71, total: 76 },
    { id: 'w3', team: 'Housekeeping', onDuty: 55, total: 60 },
    { id: 'w4', team: 'Landscape', onDuty: 19, total: 22 },
  ],
  [COLLECTIONS.EVENT_WORK]: [
    { id: 'ew1', shortId: 'EWK-0001', eventKind: 'Cultural event', eventId: 'ce2', eventName: 'Diwali Cultural Evening 2026', eventDate: plusDays(27), title: 'Stage, sound and lighting set-up', details: 'Party Hall - Banquet 1 stage, 4 speakers, string lights along the lawn.', phase: 'Before the event', neededOn: plusDays(26), startTime: '10:00', endTime: '17:00', staffType: 'Sound / lights', staffRequested: 3, staffConfirmed: 2, ownerRole: 'MEP', ownerName: '', status: 'In progress', notes: '' },
    { id: 'ew2', shortId: 'EWK-0002', eventKind: 'Cultural event', eventId: 'ce2', eventName: 'Diwali Cultural Evening 2026', eventDate: plusDays(27), title: 'Deep clean the Party Hall - Banquet 1 and washrooms', details: '', phase: 'Before the event', neededOn: plusDays(26), startTime: '08:00', endTime: '12:00', staffType: 'Housekeeping', staffRequested: 4, staffConfirmed: 4, ownerRole: 'Facility Manager', ownerName: '', status: 'Not started', notes: '' },
    { id: 'ew3', shortId: 'EWK-0003', eventKind: 'Cultural event', eventId: 'ce2', eventName: 'Diwali Cultural Evening 2026', eventDate: plusDays(27), title: 'Power back-up on standby (DG and electrician)', details: 'Electrician on site through the evening in case of a trip.', phase: 'During the event', neededOn: plusDays(27), startTime: '17:00', endTime: '22:00', staffType: 'Electrician', staffRequested: 1, staffConfirmed: 0, ownerRole: 'MEP', ownerName: '', status: 'Not started', notes: '' },
    { id: 'ew4', shortId: 'EWK-0004', eventKind: 'Cultural event', eventId: 'ce2', eventName: 'Diwali Cultural Evening 2026', eventDate: plusDays(27), title: 'Crowd and parking marshals', details: '', phase: 'During the event', neededOn: plusDays(27), startTime: '17:00', endTime: '22:00', staffType: 'Security', staffRequested: 4, staffConfirmed: 2, ownerRole: 'Facility Manager', ownerName: '', status: 'In progress', notes: '' },
    { id: 'ew5', shortId: 'EWK-0005', eventKind: 'Cultural event', eventId: 'ce2', eventName: 'Diwali Cultural Evening 2026', eventDate: plusDays(27), title: 'Clear stage, collect waste, sweep the lawn', details: '', phase: 'After the event', neededOn: plusDays(28), startTime: '07:00', endTime: '11:00', staffType: 'Housekeeping', staffRequested: 5, staffConfirmed: 0, ownerRole: 'Facility Manager', ownerName: '', status: 'Not started', notes: '' },
    { id: 'ew6', shortId: 'EWK-0006', eventKind: 'Cultural event', eventId: 'ce2', eventName: 'Diwali Cultural Evening 2026', eventDate: plusDays(27), title: 'Take down lights and return sound equipment', details: '', phase: 'After the event', neededOn: plusDays(28), startTime: '09:00', endTime: '13:00', staffType: 'Sound / lights', staffRequested: 2, staffConfirmed: 0, ownerRole: 'MEP', ownerName: '', status: 'Not started', notes: '' },
  ],
  [COLLECTIONS.CHECKLISTS]: PLANNED.lists,
  [COLLECTIONS.CHECKLIST_ROUNDS]: PLANNED.rounds,
  [COLLECTIONS.REPORT_SCHEDULES]: [
    { id: 'rs1', shortId: 'RPS-0001', name: 'Daily bookings', reportType: 'bookings', period: 'today_tomorrow', format: 'Detailed', frequency: 'Daily', time: '07:30', weekday: 'Monday', monthDay: 1, channels: ['In-app', 'Email'], audience: 'Roles', roleIds: ['facility_manager', 'committee_amenities'], units: [], people: [], extra: '', skipEmpty: false, active: true, lastRunKey: '' },
    { id: 'rs2', shortId: 'RPS-0002', name: 'Weekly dues to the committee', reportType: 'dues', period: 'asof', format: 'Summary', frequency: 'Weekly', time: '09:00', weekday: 'Monday', monthDay: 1, channels: ['In-app', 'Email'], audience: 'Roles', roleIds: ['treasurer'], units: [], people: [], extra: '', skipEmpty: false, active: true, lastRunKey: '' },
    { id: 'rs3', shortId: 'RPS-0003', name: 'Staff on duty now (example)', reportType: 'custom', custom: "{\"source\": \"attendance\", \"title\": \"Staff on duty now\", \"labels\": {\"staffName\": \"Staff member\", \"roleName\": \"Role\", \"date\": \"Date\", \"clockIn\": \"Clock in (time)\", \"clockOut\": \"Clock out (time)\", \"hours\": \"hours\"}, \"dates\": [\"date\"], \"numeric\": [\"hours\"], \"dateField\": \"date\", \"columns\": [\"staffName\", \"roleName\", \"clockIn\"], \"filters\": [{\"field\": \"clockOut\", \"op\": \"empty\", \"value\": \"\"}], \"sortBy\": \"staffName\", \"sortDir\": \"asc\", \"groupBy\": \"\", \"measure\": \"count\", \"measureField\": \"\"}", period: 'today', format: 'Detailed', frequency: 'Daily', time: '09:00', weekday: 'Monday', monthDay: 1, channels: ['In-app'], audience: 'Roles', roleIds: ['facility_manager'], units: [], people: [], extra: '', skipEmpty: false, active: false, lastRunKey: '' },
    { id: 'rs4', shortId: 'RPS-0004', name: 'Attendance by staff this month (example)', reportType: 'custom', custom: "{\"source\": \"attendance\", \"title\": \"Attendance by staff\", \"labels\": {\"staffName\": \"Staff member\", \"roleName\": \"Role\", \"date\": \"Date\", \"clockIn\": \"Clock in (time)\", \"clockOut\": \"Clock out (time)\", \"hours\": \"hours\"}, \"dates\": [\"date\"], \"numeric\": [\"hours\"], \"dateField\": \"date\", \"columns\": [], \"filters\": [], \"sortBy\": \"\", \"sortDir\": \"asc\", \"groupBy\": \"staffName\", \"measure\": \"sum\", \"measureField\": \"hours\"}", period: 'mtd', format: 'Detailed', frequency: 'Monthly', time: '09:00', weekday: 'Monday', monthDay: 1, channels: ['In-app'], audience: 'Roles', roleIds: ['facility_manager'], units: [], people: [], extra: '', skipEmpty: false, active: false, lastRunKey: '' },
  ],
  [COLLECTIONS.AMENITY_TYPES]: AMENITY_CATALOG,
  [COLLECTIONS.AMENITIES]: AMENITY_BOOKINGS,
  [COLLECTIONS.UTILITY_TYPES]: DEFAULT_UTILITY_TYPES.map((u, i) => ({ ...u, shortId: `UTY-000${i + 1}` })),
  [COLLECTIONS.AMENITY_SETTINGS]: [AMENITY_SETTINGS_ROW],
  [COLLECTIONS.NOTIFICATION_TEMPLATES]: defaultTemplates(),
  [COLLECTIONS.UNIT_CREDITS]: [
    { id: 'uc1', unit: 'Villa 135', type: 'Credit', amount: 1500, reason: 'Refund for cancelled booking (Tennis Court)', bookingNo: '', date: plusDays(-20) },
  ],
  ...gateSeed(COLLECTIONS),
  [COLLECTIONS.INCIDENTS]: [
    { id: 'in1', title: 'Vehicle scrape at Gate 2', gate: 'Gate 2', description: 'Minor scrape between two vehicles at the gate barrier. Photos attached, no injury.', reportedAt: 'Today, 09:21', assignedCommittee: '', status: 'EC review' },
  ],
  [COLLECTIONS.VENDORS]: [
    { id: 'v1', name: 'ARC Facility Management', category: 'Facilities Management', contractType: 'Contract', service: 'Integrated FM: amenities, electrical, plumbing, MEP, landscaping, housekeeping, cultural events', contactPhone: '+91 98200 11223', contactEmail: 'ops@arc-fm.example', address: 'ARC House, 4th Cross, Industrial Layout, Bengaluru 560095', contractEnds: '2027-03-31', description: '<p><b>Scope:</b> one integrated facilities contract covering amenities, electrical, plumbing, MEP, landscaping, housekeeping and cultural-event set-up.</p><ul><li>Monthly retainer billed on the 1st</li><li>Spares and out-of-scope jobs are quoted separately and need EC approval</li><li>Security is <b>not</b> part of this contract (see SecureFirst)</li></ul>', attachments: [] },
    { id: 'v2', name: 'SecureFirst', category: 'Security', contractType: 'Contract', service: 'Security staff', contactPhone: '+91 98200 77889', contactEmail: 'contracts@securefirst.example', address: '', contractEnds: '2027-06-30', description: '<p>Guards for Gates 1-3 and the night patrol, 24x7. Separate contract from the facilities contract.</p>', attachments: [] },
    { id: 'v3', gstin: '29AAACO1234A1Z2', name: 'Otis Lift Services', category: 'Lift / AMC', contractType: 'AMC', service: 'Annual maintenance of the 6 tower lifts', contactPhone: '+91 98200 55012', contactEmail: 'amc@otis-lifts.example', address: 'Service Centre, Whitefield Road, Bengaluru', contractEnds: '2027-02-28', description: '<p><b>AMC</b> - quarterly instalments, 4 preventive visits a year, breakdown call-out within 4 hours. Parts beyond the AMC schedule are chargeable.</p>', attachments: [] },
    { id: 'v4', name: 'Sri Ganesh Electricals', category: 'Maintenance', contractType: 'Local / no contract', service: 'Ad-hoc electrical repairs and fittings', contactPhone: '+91 98860 44120', contactEmail: '', address: 'Shop 12, Main Market, near Gate 3', contractEnds: '', description: '<p>Local shop used for small, quick jobs (lights, switches, MCBs). No contract - paid per job; ask for a bill every time.</p>', attachments: [] },
    { id: 'v5', name: 'EcoTest Labs', category: 'Audit / inspection agency', contractType: 'Local / no contract', service: 'STP and WTP water-quality sampling and lab testing', contactPhone: '+91 98860 31010', contactEmail: '', address: '', contractEnds: '', description: '', attachments: [] },
    { id: 'v6', name: 'AquaSafe Services', category: 'Audit / inspection agency', contractType: 'Local / no contract', service: 'Swimming pool water testing', contactPhone: '+91 98860 31020', contactEmail: '', address: '', contractEnds: '', description: '', attachments: [] },
    { id: 'v7', name: 'Fire Safety Consultants', category: 'Audit / inspection agency', contractType: 'Local / no contract', service: 'Fire safety inspection and hydrant testing', contactPhone: '+91 98860 31030', contactEmail: '', address: '', contractEnds: '', description: '', attachments: [] },
  ],
  [COLLECTIONS.AMENITY_ITEMS]: [
    { id: 'ai1', shortId: 'AIT-0001', name: 'Plastic chairs', amenity: '', stock: 200, price: 5, perLabel: 'per chair', maxPerBooking: 150, active: true },
    { id: 'ai2', shortId: 'AIT-0002', name: 'Folding tables', amenity: '', stock: 30, price: 100, perLabel: 'per table', maxPerBooking: 20, active: true },
    { id: 'ai3', shortId: 'AIT-0003', name: 'Table cloths', amenity: '', stock: 40, price: 20, perLabel: 'per cloth', maxPerBooking: 40, active: true },
  ],
  [COLLECTIONS.VENDOR_SERVICES]: [
    { id: 'vs1', vendorName: 'ARC Facility Management', service: 'Landscaping', signedWorkers: 4, contractors: 2, shift: 'Day 7:00 to 16:00, 6 days' },
    { id: 'vs2', vendorName: 'ARC Facility Management', service: 'Housekeeping', signedWorkers: 8, shift: 'Day 7:00 to 16:00, 7 days' },
    { id: 'vs3', vendorName: 'ARC Facility Management', service: 'Electrical', signedWorkers: 2, shift: 'Day 8:00 to 17:00 and on call' },
    { id: 'vs4', vendorName: 'ARC Facility Management', service: 'MEP / plant operation', signedWorkers: 3, shift: 'Day and night shifts' },
    { id: 'vs5', vendorName: 'SecureFirst', service: 'Security', signedWorkers: 12, contractors: 2, shift: '3 shifts, 24 x 7' },
  ],
  [COLLECTIONS.USERS]: [
    { id: 'u1', name: 'Arjun Nair', phone: '+91 98220 20001', email: 'arjun.nair@example.com', status: 'Active', roleId: 'president', extraRoleIds: [], units: [] },
    { id: 'u2', name: 'Meera Rao', phone: '+91 98220 20002', email: 'meera.rao@example.com', status: 'Active', roleId: 'general_secretary', extraRoleIds: [], units: [] },
    { id: 'u3', name: 'Gautam Shah', phone: '+91 98220 20003', email: 'gautam.shah@example.com', status: 'Active', roleId: 'treasurer', extraRoleIds: [], units: [] },
    { id: 'u4', name: 'Ananya Mehta', phone: '+91 98220 10001', email: 'ananya.mehta@example.com', status: 'Active', roleId: 'owner', extraRoleIds: ['committee_amenities'], units: ['Villa 135'] },
    { id: 'u5', name: 'Vikram Shah', phone: '+91 98220 10003', email: 'vikram.shah@example.com', status: 'Active', roleId: 'owner', extraRoleIds: [], units: ['A-1204'] },
    { id: 'u6', name: 'Neha Kapoor', phone: '+91 98220 10004', email: 'neha.kapoor@example.com', status: 'Active', roleId: 'owner', extraRoleIds: [], units: ['Villa 212'] },
    { id: 'u7', name: 'H. R. Iyer', phone: '+91 98220 10005', email: 'hr.iyer@example.com', status: 'Active', roleId: 'owner', extraRoleIds: [], units: ['C-0807'] },
    { id: 'u15', name: 'Rohan Mehta', phone: '+91 98220 10002', email: 'rohan.mehta@example.com', status: 'Active', roleId: 'owner', extraRoleIds: [], units: ['Villa 135'], portalSource: 'property' },
    { id: 'u16', name: 'Kavita Rao', phone: '+91 98220 10006', email: 'kavita.rao@example.com', status: 'Active', roleId: 'resident', extraRoleIds: [], units: ['A-1204'], portalSource: 'property' },
    { id: 'u8', name: 'Rohit Verma', phone: '+91 98450 30001', email: 'fm@example.com', status: 'Active', roleId: 'facility_manager', extraRoleIds: [], units: [] },
    { id: 'u9', name: 'Ramesh Kumar', phone: '+91 98450 11221', email: '', status: 'Active', roleId: 'handyman_plumbing', extraRoleIds: [], units: [] },
    { id: 'u10', name: 'Suresh Nair', phone: '+91 98450 11223', email: '', status: 'Active', roleId: 'handyman_electrical', extraRoleIds: [], units: [] },
    { id: 'u11', name: 'Farhan Sheikh', phone: '+91 98450 11227', email: '', status: 'Active', roleId: 'handyman_mep', extraRoleIds: [], units: [] },
    { id: 'u12', name: 'Devendra Singh', phone: '+91 98450 11228', email: '', status: 'Active', roleId: 'handyman_security', extraRoleIds: [], units: [] },
    { id: 'u14', name: 'Priya Desai', phone: '+91 98450 30002', email: 'helpdesk@example.com', status: 'Active', roleId: 'helpdesk', extraRoleIds: [], units: [] },
    { id: 'u13', name: 'Lokesh Pillai', phone: '+91 98450 11229', email: '', status: 'Inactive', roleId: 'handyman_general', extraRoleIds: [], units: [] },
  ],
  [COLLECTIONS.CATEGORY_MAP]: [
    { id: 'cm1', subCategories: ['Leakage', 'Tap / fixture', 'Drain blockage', 'Water tank / motor'], category: 'Plumbing', vendor: 'ARC Facility Management', coordinator: ['facility_manager', 'handyman_mep'], notes: '' },
    { id: 'cm2', subCategories: ['Lighting', 'Switches / wiring', 'Power outage', 'Street lights'], category: 'Electrical', vendor: 'ARC Facility Management', coordinator: ['facility_manager', 'handyman_mep'], notes: '' },
    { id: 'cm3', subCategories: ['DG set', 'Pumps / motors', 'STP / WTP', 'Lift'], category: 'MEP', vendor: 'ARC Facility Management', coordinator: ['handyman_mep'], notes: 'DG, AHUs, pumps' },
    { id: 'cm4', category: 'Carpentry', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: '' },
    { id: 'cm5', subCategories: ['Common area cleaning', 'Garbage / waste', 'Pest control'], category: 'Housekeeping', assetLink: 'Hidden', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: '' },
    { id: 'cm6', category: 'Gardening', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: '' },
    { id: 'cm7', category: 'Landscape', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: '' },
    { id: 'cm8', category: 'Amenities', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: 'Clubhouse, pool, courts' },
    { id: 'cm9', category: 'Cultural', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: 'Events set-up' },
    { id: 'cm10', subCategories: ['Gate / access', 'Patrolling', 'CCTV'], category: 'Security', vendor: 'SecureFirst', coordinator: ['facility_manager'], notes: 'Separate security contract' },
    { id: 'cm11', category: 'General', vendor: 'ARC Facility Management', coordinator: ['facility_manager'], notes: '' },
  ],
  [COLLECTIONS.APPROVER_SETTINGS]: [
    { id: 'aps1', name: 'Final approval', roles: ['treasurer', 'president'] },
  ],
  [COLLECTIONS.QUOTATIONS]: [
    { id: 'q1', kind: 'Quotation', ticketId: 't6', vendor: 'ARC Facility Management', amount: 185000, quoteDate: '2026-09-22', note: 'Supply + fit 10TR compressor, 1 yr warranty', attachments: [] },
    { id: 'q2', kind: 'Quotation', ticketId: 't6', vendor: 'CoolAir Systems', amount: 198000, quoteDate: '2026-09-23', note: 'Same spec, 6 months warranty', attachments: [] },
    { id: 'q3', kind: 'Quotation', ticketId: 't6', vendor: 'Hitech HVAC', amount: 214000, quoteDate: '2026-09-24', note: 'Premium brand compressor', attachments: [] },
    { id: 'q4', kind: 'Quotation', ticketId: 't7', vendor: 'ARC Facility Management', amount: 86000, quoteDate: '2026-10-02', note: 'Replace 40 sq m anti-skid tiles', attachments: [] },
    { id: 'i1', kind: 'Invoice', ticketId: 't6', vendor: 'ARC Facility Management', amount: 185000, gstMode: 'Included', gstRate: 18, baseAmount: 156779.66, gstAmount: 28220.34, quoteDate: '2026-10-03', note: 'Compressor supply + fitting', ecApproval: 'Approved', ecApprovedBy: 'Arjun Nair', ecApprovedAt: '2026-10-04', finalApproval: 'Approved', finalApprovedBy: 'Gautam Shah', finalApprovedAt: '2026-10-05', attachments: [] },
    { id: 'i2', kind: 'Invoice', ticketId: 't6', vendor: 'ARC Facility Management', amount: 14160, gstMode: 'Included', gstRate: 18, baseAmount: 12000, gstAmount: 2160, quoteDate: '2026-10-06', note: 'Gas refill + commissioning', ecApproval: 'Pending', finalApproval: 'Pending', attachments: [] },
    { id: 'q5', kind: 'Quotation', ticketId: 't7', vendor: 'BlueWave Pool Services', amount: 94500, quoteDate: '2026-10-03', note: 'Includes grouting + sealing', attachments: [] },
  ],
  [COLLECTIONS.BROADCASTS]: [
    { id: 'b1', type: 'Notice', audience: 'All residents', subject: 'Water supply maintenance — 6 September, 10:00–13:00', message: 'Water supply will be interrupted in Maple Enclave and Towers A–C.', sentAt: '2026-09-06', status: 'Sent', recipients: 4, viewed: 3, pushDelivered: 4, requiresSignature: false, reminderFrequency: 'None', signedBy: '' },
  ],
  // e-voting: drafts ready to open (opening freezes the voter roll: every unit with a registered owner)
  [COLLECTIONS.BALLOTS]: [
    { id: 'bal1', title: 'Approve the 2027-28 maintenance budget', description: '<p>The budget presented in the general body meeting (in Documents). Approval raises the maintenance fee by 6% from April.</p>', kind: 'Resolution', options: ['For', 'Against', 'Abstain'], opensOn: plusDays(1), closesOn: plusDays(8), quorumPct: 51, passPct: 50, status: 'Draft' },
    { id: 'bal2', title: 'Colour for the Tower A repainting', description: '<p>Samples are on the notice board at the Tower A lobby.</p>', kind: 'Choose one', options: ['Ivory and grey', 'Sand and terracotta', 'White and teal'], opensOn: plusDays(2), closesOn: plusDays(12), quorumPct: 30, passPct: 0, status: 'Draft' },
  ],
  [COLLECTIONS.NOTICE_TEMPLATES]: [
    { id: 'nt2', name: 'DG bill', appliesTo: 'DG bill', logo: '⚡', headerText: '{{SOCIETY_NAME}} · DG power bill', body: 'Dear owner of {{UNIT}},\n\nDG power bill for {{MONTH}}\nMeter: {{PREVIOUS_READING}} → {{CURRENT_READING}} = {{UNITS_CONSUMED}} units\nRate: ₹{{RATE}} per unit · Fixed charge ₹{{FIXED_CHARGE}} · Tax ₹{{TAX}}\nAmount payable: ₹{{AMOUNT}} by {{DUE_DATE}}.\n\nThank you,\n{{SOCIETY_NAME}} Management' },
    { id: 'nt3', name: 'Water bill', appliesTo: 'Water bill', logo: '💧', headerText: '{{SOCIETY_NAME}} · Water bill', body: 'Dear owner of {{UNIT}},\n\nWater bill for {{MONTH}}\nMeter: {{PREVIOUS_READING}} → {{CURRENT_READING}} = {{UNITS_CONSUMED}} kL\nRate: ₹{{RATE}} per unit · Fixed charge ₹{{FIXED_CHARGE}} · Tax ₹{{TAX}}\nAmount payable: ₹{{AMOUNT}} by {{DUE_DATE}}.\n\nThank you,\n{{SOCIETY_NAME}} Management' },
    { id: 'nt4', name: 'Maintenance fee', appliesTo: 'Maintenance fee', logo: '🏠', headerText: '{{SOCIETY_NAME}} · Maintenance fee', body: 'Dear owner of {{UNIT}},\n\nThe maintenance fee for {{MONTH}} is {{AMOUNT}}, payable by {{DUE_DATE}}.\nPlease pay it from the portal (Billing & Finance → Dues) or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management' },
    { id: 'nt5', name: 'Payment reminder', appliesTo: 'Payment reminder', logo: '🔔', headerText: '{{UTILITY_TYPE}} payment reminder · {{BILL_NO}}', body: 'Dear owner of {{UNIT}},\n\nThis is a reminder that your {{UTILITY_TYPE}} bill {{BILL_NO}} of {{AMOUNT}} for {{MONTH}} is {{WHEN}} (payable by {{DUE_DATE}}).\nPlease pay it from the portal or at the office.\n\nThank you,\n{{SOCIETY_NAME}} Management' },
    // announcement templates (Communications → New announcement → Notice template): fill in the blanks, the preview shows the notice
    { id: 'nt6', name: 'Water supply interruption', appliesTo: 'Announcement', logo: '💧', headerText: 'Water supply interruption · {{DATE}}', body: 'Dear residents,\n\nWater supply to {{AREA}} will be interrupted on {{DATE}} from {{TIME}} for {{REASON}}. Please store enough water beforehand.\n\nFor questions call {{CONTACT}}.\n\nThank you,\n{{SOCIETY_NAME}} Management' },
    { id: 'nt7', name: 'Power / DG maintenance', appliesTo: 'Announcement', logo: '⚡', headerText: 'Power shutdown for maintenance · {{DATE}}', body: 'Dear residents,\n\nThere will be a planned power shutdown in {{AREA}} on {{DATE}}, {{TIME}}, for {{REASON}}. The DG will not run during this work. Lifts in the affected towers will be stopped.\n\nFor questions call {{CONTACT}}.\n\n{{SOCIETY_NAME}} Management' },
    { id: 'nt8', name: 'General body meeting', appliesTo: 'Announcement', logo: '🏛', headerText: 'Notice of the general body meeting · {{DATE}}', body: 'Dear members,\n\nThe general body meeting of {{SOCIETY_NAME}} will be held on {{DATE}} at {{TIME}} at {{PLACE}}.\n\nAgenda: {{AGENDA}}\n\nOne owner per unit may vote. If you cannot attend, you may send a proxy in writing to the secretary before the meeting.\n\nBy order of the Executive Committee' },
    { id: 'nt9', name: 'Festival celebration', appliesTo: 'Announcement', logo: '🎉', headerText: '{{EVENT}} celebrations · {{DATE}}', body: 'Dear residents,\n\nYou and your family are invited to the {{EVENT}} celebrations on {{DATE}} from {{TIME}} at {{PLACE}}.\n\nVolunteers and sponsors can sign up under Cultural. Please keep the common areas clean and park only in marked bays.\n\nWith warm wishes,\nCultural Committee, {{SOCIETY_NAME}}' },
    { id: 'nt10', name: 'Pest control drive', appliesTo: 'Announcement', logo: '🪲', headerText: 'Pest control in {{AREA}} · {{DATE}}', body: 'Dear residents,\n\nPest control (anti-termite and general) will be done in {{AREA}} on {{DATE}}, {{TIME}}. Please keep children and pets away from treated areas for 4 hours. Treatment inside a villa or flat can be booked as a maintenance request.\n\nFor questions call {{CONTACT}}.\n\n{{SOCIETY_NAME}} Management' },
    { id: 'nt11', name: 'Maintenance fee revision', appliesTo: 'Announcement', logo: '🏠', headerText: 'Revised maintenance fee from {{MONTH}}', body: 'Dear owners,\n\nAs approved in the general body meeting, the maintenance fee changes from {{MONTH}} to {{AMOUNT}} per month ({{REASON}}). The first bill at the new rate is payable by {{DUE_DATE}}.\n\nThe approved budget is in Documents.\n\nTreasurer, {{SOCIETY_NAME}}' },
    // bill templates beyond the defaults
    { id: 'nt12', name: 'Payment reminder - final', appliesTo: 'Payment reminder', logo: '⚠', headerText: 'Final reminder · {{UTILITY_TYPE}} bill {{BILL_NO}}', body: 'Dear owner of {{UNIT}},\n\nYour {{UTILITY_TYPE}} bill {{BILL_NO}} of {{AMOUNT}} for {{MONTH}} is {{WHEN}}. Please pay it today from the portal (Billing & Finance → Dues) to avoid late fees and a hold on amenity bookings.\n\nIf you have already paid, please ignore this message.\n\nTreasurer, {{SOCIETY_NAME}}' },
    { id: 'nt1', appliesTo: 'Any', name: 'Utility bill notice', logo: '🏠', headerText: '{{SOCIETY_NAME}}', body: 'Dear resident,\n\nYour {{UTILITY_TYPE}} bill of ₹{{AMOUNT}} for {{MONTH}} is now due by {{DUE_DATE}}.\n\nThank you,\n{{SOCIETY_NAME}} Management' },
  ],
  [COLLECTIONS.MERGE_FIELDS]: [
    { id: 'mf1', token: '{{SOCIETY_NAME}}', label: 'Society name', defaultValue: 'La Paloma Owners Association' },
    { id: 'mf2', token: '{{UTILITY_TYPE}}', label: 'Utility type', defaultValue: 'DG' },
    { id: 'mf3', token: '{{AMOUNT}}', label: 'Amount', defaultValue: '' },
    { id: 'mf4', token: '{{MONTH}}', label: 'Billing month', defaultValue: '' },
    { id: 'mf5', token: '{{DUE_DATE}}', label: 'Due date', defaultValue: '' },
    { id: 'mf6', token: '{{UNIT}}', label: 'Villa / unit', defaultValue: '' },
    { id: 'mf7', token: '{{PREVIOUS_READING}}', label: 'Previous reading', defaultValue: '' },
    { id: 'mf8', token: '{{CURRENT_READING}}', label: 'Current reading', defaultValue: '' },
    { id: 'mf9', token: '{{UNITS_CONSUMED}}', label: 'Units consumed', defaultValue: '' },
    { id: 'mf10', token: '{{RATE}}', label: 'Rate per unit', defaultValue: '' },
    { id: 'mf11', token: '{{FIXED_CHARGE}}', label: 'Fixed charge', defaultValue: '' },
    { id: 'mf13', token: '{{BILL_NO}}', label: 'Bill number', defaultValue: '' },
    { id: 'mf20', token: '{{DATE}}', label: 'Date', defaultValue: '' },
    { id: 'mf21', token: '{{TIME}}', label: 'Time', defaultValue: '' },
    { id: 'mf22', token: '{{AREA}}', label: 'Area / blocks affected', defaultValue: 'all blocks' },
    { id: 'mf23', token: '{{PLACE}}', label: 'Place', defaultValue: 'the clubhouse' },
    { id: 'mf24', token: '{{REASON}}', label: 'Reason', defaultValue: '' },
    { id: 'mf25', token: '{{CONTACT}}', label: 'Contact', defaultValue: 'the facility desk' },
    { id: 'mf26', token: '{{EVENT}}', label: 'Event', defaultValue: '' },
    { id: 'mf27', token: '{{AGENDA}}', label: 'Agenda', defaultValue: '' },
    { id: 'mf14', token: '{{WHEN}}', label: 'Overdue by / coming up', defaultValue: '' },
    { id: 'mf12', token: '{{TAX}}', label: 'Tax', defaultValue: '' },
  ],
  [COLLECTIONS.FORUM]: [
    { id: 'fo1', title: 'Weekend cultural festival volunteers', category: 'Cultural Committee', kind: 'Discussion', replies: 2, pinned: true, status: 'Open' },
    { id: 'fo2', title: 'EV charging policy — quick poll', category: 'General', kind: 'Poll', replies: 0, pinned: false, status: 'Open', pollOptions: [{ label: 'Support', votes: 82 }, { label: 'Against', votes: 21 }, { label: 'Need more info', votes: 23 }] },
    { id: 'fo3', title: 'Dog park opening hours', category: 'Amenities', kind: 'Discussion', replies: 1, pinned: false, status: 'Open' },
  ],
  [COLLECTIONS.FORUM_POSTS]: [
    { id: 'fp1', topicId: 'fo1', parentId: '', author: 'Meera Rao', authorRoleId: 'general_secretary', body: "Signing up the Cultural Committee for setup on Friday evening — anyone free to help?", createdAt: '2026-09-05T18:20:00.000Z', reactions: 3 },
    { id: 'fp2', topicId: 'fo1', parentId: 'fp1', author: 'Ananya Mehta', authorRoleId: 'owner', body: "I can help with setup after 6pm!", createdAt: '2026-09-05T19:02:00.000Z', reactions: 1 },
    { id: 'fp3', topicId: 'fo3', parentId: '', author: 'Vikram Shah', authorRoleId: 'resident', body: 'Could we extend evening hours to 9pm during the week?', createdAt: '2026-09-04T20:10:00.000Z', reactions: 2 },
  ],
  [COLLECTIONS.MEETINGS]: [
    { id: 'm1', title: 'EC monthly meeting', committee: 'Executive Committee', date: '2026-10-22', startTime: '19:00', endTime: '20:30', location: 'Clubhouse Board Room', agenda: '<ol><li>September financial review</li><li>Pool service contract renewal</li><li>EV charging policy resolution</li><li>Security incident follow-up</li></ol>', minutes: '', status: 'Scheduled' },
    { id: 'm2', title: 'EC monthly meeting', committee: 'Executive Committee', date: '2026-09-10', startTime: '19:00', endTime: '20:15', location: 'Clubhouse Board Room', agenda: '<ol><li>August financial review</li><li>Amenities booking policy</li></ol>', minutes: '<p>Budget variance noted. Amenities policy approved unanimously.</p>', status: 'Completed' },
  ],
  [COLLECTIONS.EC_ROLES]: [
    { id: 'ec1', roleTitle: 'President', personName: 'Arjun Nair' },
    { id: 'ec2', roleTitle: 'General Secretary', personName: 'Meera Rao' },
    { id: 'ec3', roleTitle: 'Treasurer', personName: 'Gautam Shah' },
    { id: 'ec4', roleTitle: 'Landscape Committee Chair', personName: '' },
  ],
  [COLLECTIONS.SUBCOMMITTEES]: [
    { id: 'sc1', name: 'Electrical', memberCount: 5 },
    { id: 'sc2', name: 'Landscape', memberCount: 4 },
    { id: 'sc3', name: 'Security', memberCount: 6 },
    { id: 'sc4', name: 'Amenities', memberCount: 5 },
  ],
  [COLLECTIONS.APPROVALS]: [
    { id: 'ap1', title: 'Pool contract renewal', approvedCount: 2, requiredCount: 3, status: 'Pending' },
    { id: 'ap2', title: 'Capital expense ₹4.8L', approvedCount: 1, requiredCount: 3, status: 'Pending' },
    { id: 'ap3', title: 'Festival budget', approvedCount: 3, requiredCount: 3, status: 'Approved' },
  ],
  // ---- La Paloma Treasurer workbook ("A/c Entries"): Account Summary, Budget FY27 and the bank statements ----
  [COLLECTIONS.DEPOSITS]: [
    { id: 'dp_ba1_f', account: 'Maintenance', type: 'Fixed deposit', amount: 11500000, status: 'Active', startDate: '2026-09-25' },
    { id: 'dp_ba2_s', account: 'Electricity/Water/Tax', type: 'Sweep-in deposit', amount: 1805000, status: 'Active', startDate: '2026-09-25' },
    { id: 'dp_ba3_s', account: 'Sinking', type: 'Sweep-in deposit', amount: 10462000, status: 'Active', startDate: '2026-09-25' },
    { id: 'dp_ba4_s', account: 'Corpus', type: 'Sweep-in deposit', amount: 1609000, status: 'Active', startDate: '2026-09-25' },
    { id: 'dp_ba4_f', account: 'Corpus', type: 'Fixed deposit', amount: 23000000, status: 'Active', startDate: '2026-09-25' },
    { id: 'dp_ba5_s', account: 'Cultural', type: 'Sweep-in deposit', amount: 585000, status: 'Active', startDate: '2026-09-25' },
  ],
  [COLLECTIONS.BANK_ACCOUNTS]: [
    { id: 'ba1', name: 'Maintenance', last4: '7951', balance: 209000, asOf: '2026-09-25' },
    { id: 'ba2', name: 'Electricity/Water/Tax', last4: '1889', balance: 354000, asOf: '2026-09-25' },
    { id: 'ba3', name: 'Sinking', last4: '4742', balance: 316000, asOf: '2026-09-25' },
    { id: 'ba4', name: 'Corpus', last4: '1408', balance: 294000, asOf: '2026-09-25' },
    { id: 'ba5', name: 'Cultural', last4: '4573', balance: 717000, asOf: '2026-09-25' },
    { id: 'ba6', name: 'Ganesh', last4: '9032', balance: 17000, asOf: '2026-09-25' },
  ],
  [COLLECTIONS.FIXED_EXPENSES]: [
    { id: 'fx1', vendor: 'TSSPDCL (electricity department)', name: 'Electricity', avg: 120000, months: 5, heads: 'Electricity' },
    { id: 'fx2', name: 'ARC wages', avg: 1400000, months: 5, heads: 'ARC wages' },
    { id: 'fx3', name: 'Diesel', avg: 50000, months: 5, heads: 'Diesel' },
    { id: 'fx4', vendor: 'SecureFirst', vendorService: 'Security', name: 'Security', avg: 550000, months: 5, heads: 'Security' },
    { id: 'fx5', vendor: 'Income Tax Department', name: 'TDS', avg: 40000, months: 5, heads: 'TDS' },
    { id: 'fx6', name: 'Operations (garbage, waste, Gandipet, salary, pest control)', avg: 160000, months: 5, heads: 'Operations' },
    { id: 'fx7', name: 'Miscellaneous', avg: 100000, months: 5, heads: '' },
    { id: 'fx8', vendor: 'Bhagiratha / HMWSSB (water department)', name: 'Bhagiratha', avg: 120000, months: 5, heads: 'Bhagiratha (water)' },
    { id: 'fx9', name: 'Petty expense', avg: 40000, months: 5, heads: 'Petty expense' },
  ],
  [COLLECTIONS.BUDGET_LINES]: [
    { id: 'bu1', fy: 'FY27', kind: 'Income', name: 'Maintenance', forecast: 31800000, other: 0, heads: 'Maintenance dues', notes: '<p>212 villas × 1.5</p>' },
    { id: 'bu2', fy: 'FY27', kind: 'Income', name: 'Clubhouse income', forecast: 1600000, other: 0, heads: 'Clubhouse', notes: '' },
    { id: 'bu3', fy: 'FY27', kind: 'Income', name: 'Interest income', forecast: 3000000, other: 0, heads: 'Interest', notes: '<p>All accounts</p>' },
    { id: 'bu4', fy: 'FY27', kind: 'Income', name: 'Rental income', forecast: 50000, other: 0, heads: 'Rental', notes: '' },
    { id: 'bu5', fy: 'FY27', kind: 'Income', name: 'Water bills (estimated)', forecast: 400000, other: 0, heads: 'Water bills', notes: '' },
    { id: 'bu6', fy: 'FY27', kind: 'Income', name: 'DG bills (estimated)', forecast: 400000, other: 0, heads: 'DG bills', notes: '' },
    { id: 'bu7', fy: 'FY27', kind: 'Expense', name: '12 months fixed expense', forecast: 30960000, other: 0, heads: 'ARC wages,Security,Electricity,Bhagiratha (water),Diesel,Operations,Petty expense,TDS', notes: '<p>Appendix 1: 12 × 25.8</p>' },
    { id: 'bu8', fy: 'FY27', kind: 'Expense', name: 'SportsFest', forecast: 100000, other: 0, heads: '', notes: '' },
    { id: 'bu9', fy: 'FY27', kind: 'Expense', name: 'Republic / Independence Day / others', forecast: 100000, other: 100000, heads: '', notes: '' },
    { id: 'bu10', fy: 'FY27', kind: 'Expense', name: 'Yearly AMC', forecast: 890000, other: 0, heads: 'AMC & infrastructure', notes: '<p>Appendix 2</p>' },
    { id: 'bu11', fy: 'FY27', kind: 'Expense', name: 'STP cleaning', forecast: 200000, other: 200000, heads: '', notes: '' },
    { id: 'bu12', fy: 'FY27', kind: 'Expense', name: 'Big surprises this year', forecast: 1050000, other: 0, heads: 'Repairs & improvements', notes: '<p>Appendix 3: diesel 3, speed breakers 1.9, DG 1.5, STP work 3, motor repair 1.1</p>' },
    { id: 'bu13', fy: 'FY27', kind: 'Expense', name: 'Legal / accountancy', forecast: 200000, other: 0, heads: 'Legal & accounting', notes: '' },
    { id: 'bu14', fy: 'FY27', kind: 'Expense', name: 'Income tax', forecast: 1400000, other: 0, heads: 'Income tax', notes: '' },
    { id: 'bu15', fy: 'FY27', kind: 'Expense', name: 'GST', forecast: 1300000, other: 0, heads: 'GST', notes: '' },
  ],
  [COLLECTIONS.PLANT_LOGS]: PLANT_LOG_ROWS.map((r) => ({ id: `pl-${r.date}`, ...r, ...(r.bhClose != null ? { bhKl: Math.round((r.bhClose - r.bhOpen) * 10) } : {}), ...(r.wtpClose != null ? { wtpKl: r.wtpClose - r.wtpOpen } : {}), ...(r.stpClose != null ? { stpKl: r.stpClose - r.stpOpen } : {}) })),
  [COLLECTIONS.DG_FUEL_LOGS]: [
    { id: 'dg1', date: '2026-06-05', generator: 'DG 1 (125 kVA)', hoursReading: 1812.0, kwhReading: 28950, litres: 400, rate: 91.8, amount: 36720, supplier: '', billNo: 'FS/2600', notes: '' },
    { id: 'dg2', date: '2026-06-24', generator: 'DG 1 (125 kVA)', hoursReading: 1830.5, kwhReading: 30330, litres: 385, rate: 92.4, amount: 35574, supplier: '', billNo: 'FS/2607', notes: '' },
    { id: 'dg3', date: '2026-07-14', generator: 'DG 1 (125 kVA)', hoursReading: 1851.0, kwhReading: 31905, litres: 430, rate: 93.1, amount: 40033, supplier: '', billNo: 'FS/2614', notes: '' },
    { id: 'dg4', date: '2026-08-02', generator: 'DG 1 (125 kVA)', hoursReading: 1872.5, kwhReading: 33690, litres: 520, rate: 93.1, amount: 48412, supplier: '', billNo: 'FS/2621', notes: '' },
    { id: 'dg5', date: '2026-08-26', generator: 'DG 1 (125 kVA)', hoursReading: 1893.0, kwhReading: 35390, litres: 440, rate: 94.0, amount: 41360, supplier: '', billNo: 'FS/2628', notes: '' },
    { id: 'dg6', date: '2026-09-18', generator: 'DG 1 (125 kVA)', hoursReading: 1913.5, kwhReading: 37060, litres: 455, rate: 94.6, amount: 43043, supplier: '', billNo: 'FS/2635', notes: '' },
  ],
  [COLLECTIONS.ASSOC_BILLS]: [
    { id: 'ab1', utility: 'Water', location: 'Whole community', provider: 'Metro Water Board', accountNo: 'MWB-77120', period: '2026-08', billDate: '2026-09-03', dueDate: '2026-09-20', quantity: 1840, amount: 41200, paidOn: '2026-09-15' },
    { id: 'ab2', utility: 'Water', location: 'Whole community', provider: 'Metro Water Board', accountNo: 'MWB-77120', period: '2026-09', billDate: '2026-10-03', dueDate: '2026-10-20', quantity: 1912, amount: 43850 },
    { id: 'ab3', utility: 'Water', location: 'Clubhouse', provider: 'Sri Sai Water Tankers', accountNo: '', period: '2026-09', billDate: '2026-10-01', dueDate: '2026-10-15', quantity: 12, amount: 9600 },
    { id: 'ab4', utility: 'Internet / telecom', location: 'Gate / security', provider: 'Fibernet Broadband', accountNo: 'FB-20933', period: '2026-10', billDate: '2026-10-05', dueDate: '2026-10-25', amount: 2360 },
  ],
  [COLLECTIONS.ELECTRICITY_BILLS]: [
    { id: 'eb1', service: 'Clubhouse', serviceNo: 'TS-1100-2041', period: '2026-08', billDate: '2026-09-02', dueDate: '2026-09-17', units: 2840, exportUnits: 0, creditUnits: 0, creditAmount: 0, mdKva: 12.0, loadKw: 13, fixedCharges: 25000, energyCharges: 21016, otherCharges: 3221, amount: 49237, status: 'Paid', paidOn: '2026-09-12', paidFrom: 'Electricity/Water/Tax', paymentRef: 'UTR5001', costPerUnit: 17.34, notes: '' },
    { id: 'eb2', service: 'Common area', serviceNo: 'TS-1100-2033', period: '2026-08', billDate: '2026-09-02', dueDate: '2026-09-17', units: 9800, mdKva: 38.0, loadKw: 42, fixedCharges: 31000, energyCharges: 72520, otherCharges: 7246, amount: 110766, status: 'Paid', paidOn: '2026-09-12', paidFrom: 'Electricity/Water/Tax', paymentRef: 'UTR5002', costPerUnit: 11.30, notes: '' },
    { id: 'eb3', service: 'STP', serviceNo: 'TS-1100-2058', period: '2026-08', billDate: '2026-09-02', dueDate: '2026-09-17', units: 6100, mdKva: 22.0, loadKw: 24, fixedCharges: 18000, energyCharges: 45140, otherCharges: 4420, amount: 67560, status: 'Paid', paidOn: '2026-09-12', paidFrom: 'Electricity/Water/Tax', paymentRef: 'UTR5003', costPerUnit: 11.08, notes: '' },
    { id: 'eb4', service: 'WTP', serviceNo: 'TS-1100-2060', period: '2026-08', billDate: '2026-09-02', dueDate: '2026-09-17', units: 2300, mdKva: 9.0, loadKw: 10, fixedCharges: 9500, energyCharges: 17020, otherCharges: 1856, amount: 28376, status: 'Paid', paidOn: '2026-09-12', paidFrom: 'Electricity/Water/Tax', paymentRef: 'UTR5004', costPerUnit: 12.34, notes: '' },
    { id: 'eb5', service: 'Street lights', serviceNo: 'TS-1100-2077', period: '2026-08', billDate: '2026-09-02', dueDate: '2026-09-17', units: 3150, mdKva: 0, loadKw: 0, fixedCharges: 6000, energyCharges: 23310, otherCharges: 2052, amount: 31362, status: 'Paid', paidOn: '2026-09-12', paidFrom: 'Electricity/Water/Tax', paymentRef: 'UTR5005', costPerUnit: 9.96, notes: '' },
    { id: 'eb6', service: 'Clubhouse', serviceNo: 'TS-1100-2041', period: '2026-09', billDate: '2026-10-02', dueDate: '2026-10-17', units: 3010, mdKva: 12.0, loadKw: 13, fixedCharges: 25000, energyCharges: 22274, otherCharges: 3309, amount: 50583, status: 'Unpaid', paidOn: '', paidFrom: '', paymentRef: '', costPerUnit: 16.80, notes: '' },
    { id: 'eb7', service: 'Common area', serviceNo: 'TS-1100-2033', period: '2026-09', billDate: '2026-10-02', dueDate: '2026-10-17', units: 10388, mdKva: 38.0, loadKw: 42, fixedCharges: 31000, energyCharges: 76871, otherCharges: 7551, amount: 115422, status: 'Unpaid', paidOn: '', paidFrom: '', paymentRef: '', costPerUnit: 11.11, notes: '' },
    { id: 'eb8', service: 'STP', serviceNo: 'TS-1100-2058', period: '2026-09', billDate: '2026-10-02', dueDate: '2026-10-17', units: 6466, mdKva: 22.0, loadKw: 24, fixedCharges: 18000, energyCharges: 47848, otherCharges: 4609, amount: 70457, status: 'Unpaid', paidOn: '', paidFrom: '', paymentRef: '', costPerUnit: 10.90, notes: '' },
    { id: 'eb9', service: 'WTP', serviceNo: 'TS-1100-2060', period: '2026-09', billDate: '2026-10-02', dueDate: '2026-10-17', units: 2438, mdKva: 9.0, loadKw: 10, fixedCharges: 9500, energyCharges: 18041, otherCharges: 1928, amount: 29469, status: 'Unpaid', paidOn: '', paidFrom: '', paymentRef: '', costPerUnit: 12.09, notes: '' },
    { id: 'eb10', service: 'Street lights', serviceNo: 'TS-1100-2077', period: '2026-09', billDate: '2026-10-02', dueDate: '2026-10-17', units: 3339, mdKva: 0, loadKw: 0, fixedCharges: 6000, energyCharges: 24709, otherCharges: 2150, amount: 32859, status: 'Unpaid', paidOn: '', paidFrom: '', paymentRef: '', costPerUnit: 9.84, notes: '' },
  ],
  [COLLECTIONS.VILLA_ELECTRICITY]: [
    { id: 've1', unit: 'Villa 12', month: '2026-08', units: 410, amount: 3680, mdKw: 5.2, sanctionedKw: 5, notes: '' },
    { id: 've2', unit: 'Villa 12', month: '2026-09', units: 443, amount: 3974, mdKw: 5.6, sanctionedKw: 5, notes: '' },
    { id: 've3', unit: 'Villa 35', month: '2026-08', units: 620, exportUnits: 85, creditUnits: 40, creditAmount: 420, amount: 5890, mdKw: 6.8, sanctionedKw: 5, notes: '' },
    { id: 've4', unit: 'Villa 35', month: '2026-09', units: 670, amount: 6361, mdKw: 7.3, sanctionedKw: 5, notes: '' },
    { id: 've5', unit: 'Villa 70', month: '2026-08', units: 305, amount: 2650, mdKw: 4.1, sanctionedKw: 5, notes: '' },
    { id: 've6', unit: 'Villa 70', month: '2026-09', units: 329, amount: 2862, mdKw: 4.4, sanctionedKw: 5, notes: '' },
    { id: 've7', unit: 'Villa 101', month: '2026-08', units: 780, amount: 7420, mdKw: 7.9, sanctionedKw: 5, notes: '' },
    { id: 've8', unit: 'Villa 101', month: '2026-09', units: 842, amount: 8014, mdKw: 8.5, sanctionedKw: 5, notes: '' },
    { id: 've9', unit: 'Villa 135', month: '2026-08', units: 520, amount: 4900, mdKw: 6.2, sanctionedKw: 5, notes: '' },
    { id: 've10', unit: 'Villa 135', month: '2026-09', units: 562, amount: 5292, mdKw: 6.7, sanctionedKw: 5, notes: '' },
    { id: 've11', unit: 'Villa 188', month: '2026-08', units: 260, amount: 2210, mdKw: 3.6, sanctionedKw: 5, notes: '' },
    { id: 've12', unit: 'Villa 188', month: '2026-09', units: 281, amount: 2387, mdKw: 3.9, sanctionedKw: 5, notes: '' },
  ],
  [COLLECTIONS.INFRA_PLANS]: [
    { id: PLAN_ID, name: 'La Paloma site plan', imageUrl: 'plans/la-paloma.jpg', width: 4000, height: 3413, metersPerPx: 0.15, order: 1, boundary: ZN([1132, 72], [1760, 20], [2120, 48], [2440, 100], [3040, 160], [2980, 600], [3160, 800], [3440, 1040], [3872, 1560], [3740, 1680], [3680, 1880], [3540, 2200], [3220, 2560], [2900, 2820], [2520, 2860], [2520, 3400], [2240, 3400], [2320, 3040], [2340, 2640], [2240, 2240], [2220, 1912], [1720, 1920], [1200, 2272], [80, 2020], [8, 1680], [8, 1340], [400, 1280], [860, 1048], [1020, 900], [1048, 480]), notes: 'From the approved layout (sheet scale 1:800), cropped and lightened. The scale is taken from the sheet: confirm it with Set scale on a distance you know, such as a 12 m road.' },
  ],
  [COLLECTIONS.INFRA_LOG]: [
    { id: 'il1', assetId: 'in1', assetName: 'Street lights - Lane A (west)', date: '2026-10-10', condition: 'Needs attention', source: 'Inspection', note: '3 of 12 faulty. Night round.', by: 'Facility Manager' },
    { id: 'il2', assetId: 'in7', assetName: 'Lane camera 1', date: '2026-10-12', condition: 'Out of service', source: 'Inspection', note: 'No video feed since the storm.', by: 'Facility Manager' },
    { id: 'il3', assetId: 'eq7', assetName: 'Borewell submersible 2', date: '2026-10-02', condition: 'Under repair', source: 'Inspection', note: 'Motor pulled for rewinding.', by: 'Facility Manager' },
  ],
  [COLLECTIONS.EQUIPMENT]: [
    { id: 'eq1', name: 'STP inlet pump 1', area: 'STP', type: 'Pump', make: 'Kirloskar', model: 'KDS-420', serialNo: '', rating: '5.5 kW', installDate: '2024-02-10', warrantyUntil: '2027-02-09', amcVendor: 'ARC Facility Management', lastService: '2026-07-12', nextService: '2026-10-12', status: 'Working', spares: '', history: '' },
    { id: 'eq2', specs: '{"Power (kW)":"7.5","Air flow (m³/h)":"420"}', name: 'STP blower A', area: 'STP', type: 'Blower', make: 'Everest', model: 'ERB-75', serialNo: '', rating: '7.5 kW', installDate: '2023-11-05', warrantyUntil: '2026-11-04', amcVendor: 'ARC Facility Management', lastService: '2026-08-20', nextService: '2026-11-20', status: 'Needs attention', spares: '', history: '' },
    { id: 'eq3', name: 'STP blower B', area: 'STP', type: 'Blower', make: 'Everest', model: 'ERB-75', serialNo: '', rating: '7.5 kW', installDate: '2023-11-05', warrantyUntil: '2026-11-04', amcVendor: 'ARC Facility Management', lastService: '2026-08-20', nextService: '2026-11-20', status: 'Working', spares: '', history: '' },
    { id: 'eq4', name: 'WTP raw-water motor', area: 'WTP', type: 'Motor', make: 'Crompton', model: 'CG-10HP', serialNo: '', rating: '7.5 kW', installDate: '2022-06-01', warrantyUntil: '2025-05-31', amcVendor: 'ARC Facility Management', lastService: '2026-06-30', nextService: '2026-09-30', status: 'Working', spares: '', history: '' },
    { id: 'eq5', name: 'WTP filter feed pump', area: 'WTP', type: 'Pump', make: 'CRI', model: 'CRI-3S', serialNo: '', rating: '3.7 kW', installDate: '2022-06-01', warrantyUntil: '2025-05-31', amcVendor: 'ARC Facility Management', lastService: '2026-06-30', nextService: '2026-12-30', status: 'Working', spares: '', history: '' },
    { id: 'eq6', name: 'Clubhouse pool circulation pump', area: 'Clubhouse', type: 'Pump', make: 'Pentair', model: 'IntelliFlo', serialNo: '', rating: '2.2 kW', installDate: '2024-05-18', warrantyUntil: '2027-05-17', amcVendor: 'ARC Facility Management', lastService: '2026-09-05', nextService: '2026-12-05', status: 'Working', spares: '', history: '' },
    { id: 'eq8', name: 'Main gate CCTV cameras', area: 'Main gate / security', type: 'CCTV camera', location: 'Main gate & guard room', quantity: 8, make: 'Hikvision', model: 'DS-2CD2143', rating: '4 MP', installDate: '2025-01-20', warrantyUntil: '2027-01-19', amcVendor: 'ARC Facility Management', lastService: '2026-07-01', nextService: '2026-10-20', status: 'Working', spares: '', history: '' },
    { id: 'eq9', name: 'Perimeter & lane CCTV cameras', area: 'Street / roads', type: 'CCTV camera', location: 'Lanes A-F, perimeter wall', quantity: 24, make: 'Hikvision', model: 'DS-2CD2043', rating: '4 MP', installDate: '2025-01-20', warrantyUntil: '2027-01-19', amcVendor: 'ARC Facility Management', lastService: '2026-07-01', nextService: '2026-10-20', status: 'Needs attention', spares: '', history: '' },
    { id: 'eq10', name: 'NVR + camera UPS (security room)', area: 'Main gate / security', type: 'UPS / battery', location: 'Security room rack', quantity: 2, make: 'APC', model: 'Smart-UPS 3 kVA', rating: '3 kVA', backupHours: 2, batteryChanged: '2025-02-10', installDate: '2024-02-10', warrantyUntil: '2026-02-09', amcVendor: '', lastService: '2026-05-10', nextService: '2026-11-10', status: 'Working', spares: '', history: '' },
    { id: 'eq11', name: 'Street lights - main road', area: 'Street / roads', type: 'Street light', location: 'Main road poles 1-40', quantity: 40, make: 'Syska', model: 'LED 60 W', rating: '60 W', installDate: '2023-08-01', warrantyUntil: '2026-07-31', amcVendor: '', lastService: '2026-08-15', nextService: '2027-02-15', status: 'Working', spares: '', history: '' },
    { id: 'eq12', specs: '{"Wattage (W)":"30","Pole height (m)":"6","Lamp type":"LED"}', name: 'Street lights - lanes', area: 'Street / roads', type: 'Street light', location: 'Lanes A-F', quantity: 72, make: 'Syska', model: 'LED 30 W', rating: '30 W', installDate: '2023-08-01', warrantyUntil: '2026-07-31', amcVendor: '', lastService: '2026-08-15', nextService: '2027-02-15', status: 'Needs attention', spares: '', history: '' },
    { id: 'eq13', name: 'Clubhouse AC - gym', area: 'Clubhouse', type: 'Air conditioner', location: 'Gym', quantity: 2, make: 'Daikin', model: 'FTKM50', rating: '1.5 TR', installDate: '2024-04-01', warrantyUntil: '2027-03-31', amcVendor: 'ARC Facility Management', lastService: '2026-06-15', nextService: '2026-12-15', status: 'Working', spares: '', history: '' },
    { id: 'eq14', name: 'Clubhouse AC - party hall', area: 'Clubhouse', type: 'Air conditioner', location: 'Party hall', quantity: 3, make: 'Voltas', model: 'Cassette 2 TR', rating: '2 TR', installDate: '2024-04-01', warrantyUntil: '2027-03-31', amcVendor: 'ARC Facility Management', lastService: '2026-06-15', nextService: '2026-12-15', status: 'Working', spares: '', history: '' },
    { id: 'eq7', name: 'Borewell submersible 2', area: 'Borewell', type: 'Motor', make: 'Texmo', model: 'TS-7.5', serialNo: '', rating: '5.5 kW', installDate: '2021-03-15', warrantyUntil: '2024-03-14', amcVendor: '', lastService: '2026-04-02', nextService: '2026-10-02', status: 'Under repair', spares: '', history: '' },
    // ---- infrastructure map demo assets (illustrative positions)
    { id: 'in1', specs: '{"Wattage (W)":"30","Pole height (m)":"6","Lamp type":"LED","Poles in this group":"12"}', name: 'Street lights - Lane A (west)', area: 'Street / roads', type: 'Street light', location: 'West lane, poles 1-12', quantity: 12, faulty: 3, make: 'Syska', model: 'LED 30 W', rating: '30 W', installDate: '2023-08-01', lastService: '2026-08-15', nextService: '2026-09-30', status: 'Needs attention', lastInspected: '2026-10-10', shape: LN([280, 1830], [1280, 1830]) },
    { id: 'in2', name: 'Feeder pillar FP-1', area: 'Electrical', type: 'Feeder pillar', location: 'Main road, near Lane 1', quantity: 1, make: 'Schneider', rating: '200 A', installDate: '2023-06-10', lastService: '2026-06-20', nextService: '2026-12-20', status: 'Working', shape: PT(2560, 680) },
    { id: 'in3', name: 'Feeder pillar FP-2', area: 'Electrical', type: 'Feeder pillar', location: 'Main road, mid-block', quantity: 1, make: 'Schneider', rating: '200 A', installDate: '2023-06-10', lastService: '2026-06-20', nextService: '2026-12-20', status: 'Working', shape: PT(2560, 1100) },
    { id: 'in4', name: 'Feeder pillar FP-3', area: 'Electrical', type: 'Feeder pillar', location: 'West cross road', quantity: 1, make: 'Schneider', rating: '200 A', installDate: '2023-06-10', lastService: '2026-04-02', nextService: '2026-09-02', status: 'Working', shape: PT(1290, 1780) },
    { id: 'in5', name: 'HT yard & transformer', area: 'Electrical', type: 'Transformer / HT', location: 'Near the main gate', quantity: 1, make: 'Voltamp', rating: '630 kVA', installDate: '2022-11-01', warrantyUntil: '2027-10-31', lastService: '2026-07-10', nextService: '2027-01-10', status: 'Working', shape: PT(2330, 2540) },
    { id: 'in6', name: 'Gate camera (entry)', area: 'Main gate / security', type: 'CCTV camera', location: 'Entry barrier', quantity: 1, make: 'Hikvision', model: 'DS-2CD2143', installDate: '2025-01-20', lastService: '2026-07-01', nextService: '2026-10-20', status: 'Working', shape: PT(2470, 2620, 20) },
    { id: 'in7', name: 'Lane camera 1', area: 'Street / roads', type: 'CCTV camera', location: 'Main road junction', quantity: 1, make: 'Hikvision', model: 'DS-2CD2043', installDate: '2025-01-20', lastService: '2026-07-01', nextService: '2026-10-20', status: 'Out of service', shape: PT(2528, 1300, 90) },
    { id: 'in8', name: 'Lane camera 2', area: 'Street / roads', type: 'CCTV camera', location: 'West junction', quantity: 1, make: 'Hikvision', model: 'DS-2CD2043', installDate: '2025-01-20', lastService: '2026-07-01', nextService: '2026-10-20', status: 'Working', shape: PT(1290, 1450, 0) },
    { id: 'in9', name: 'Clubhouse camera', area: 'Clubhouse', type: 'CCTV camera', location: 'Clubhouse entrance', quantity: 1, make: 'Hikvision', model: 'DS-2CD2043', installDate: '2025-01-20', lastService: '2026-07-01', nextService: '2026-10-20', status: 'Working', shape: PT(2850, 2330, 270) },
    { id: 'in10', name: 'Water main (gate to north)', area: 'Water supply', type: 'Water pipeline', location: 'Along the main road', quantity: 1, make: 'HDPE 160 mm', installDate: '2022-06-01', status: 'Working', shape: LN([2440, 2660], [2500, 2300], [2500, 400]), serves: ['Maple Enclave', 'Palm District', 'Tower A'], closeValve: 'Valve V1 (main, near gate)' },
    { id: 'in90', name: 'Valve V1 (main, near gate)', area: 'Water supply', type: 'Valve', location: 'Main road, near the gate', quantity: 1, status: 'Working', shape: PT(2500, 2000), serves: ['Maple Enclave', 'Palm District', 'Tower A'] },
    { id: 'in91', name: 'Valve V2 (east-west branch)', area: 'Water supply', type: 'Valve', location: 'Cross road, west end', quantity: 1, status: 'Working', shape: PT(3000, 1475), serves: ['Palm District'] },
    { id: 'in11', specs: '{"Diameter (mm)":"110","Material":"HDPE","Pressure class":"PN10"}', name: 'Water branch (east-west)', area: 'Water supply', type: 'Water pipeline', location: 'Cross road', quantity: 1, make: 'HDPE 110 mm', installDate: '2022-06-01', status: 'Needs attention', lastInspected: '2026-10-08', shape: LN([1290, 1475], [3480, 1475]), serves: ['Palm District'], closeValve: 'Valve V2 (east-west branch)' },
    { id: 'in12', name: 'Sewer trunk to STP', area: 'Sewage', type: 'Sewer line', location: 'West cross road to STP', quantity: 1, make: 'UPVC 250 mm', installDate: '2022-06-01', status: 'Working', shape: LN([1260, 300], [1260, 1880], [400, 1880], [170, 1700]) },
    { id: 'in13', name: 'STP plant area', area: 'STP', type: 'Zone / building', location: 'West boundary', quantity: 1, status: 'Working', shape: ZN([50, 1380], [210, 1380], [210, 1780], [50, 1780]) },
    { id: 'in14', name: 'WTP plant area', area: 'WTP', type: 'Zone / building', location: 'Near clubhouse', quantity: 1, status: 'Working', shape: ZN([2880, 2410], [3080, 2410], [3080, 2570], [2880, 2570]) },
    { id: 'in15', name: 'Clubhouse', area: 'Clubhouse', type: 'Zone / building', location: 'South-east corner', quantity: 1, status: 'Needs attention', shape: ZN([2610, 2290], [2830, 2290], [2830, 2600], [2610, 2600]) },
  ].map((r) => ({ ...r, ...(INFRA_SHAPES[r.id] ? { shape: INFRA_SHAPES[r.id] } : {}), ...(r.shape || INFRA_SHAPES[r.id] ? ON_PLAN : {}) })),
  [COLLECTIONS.VILLA_IMPORT_RULES]: [
    { id: 'vir1', name: 'Villa electricity workbook', sheet: '', headerRow: 1, unitCol: 'Villa', unitPrefix: 'Villa ', monthCol: 'Month', unitsCol: 'Units', exportCol: 'Export', creditUnitsCol: 'Credit Units', amountCol: 'Amount', creditAmountCol: 'Credit', mdCol: 'MD', sanctionedCol: '' },
  ],
  [COLLECTIONS.FINANCE_SETTINGS]: [
    { id: 'fs1', onHand: 'Maintenance,Electricity/Water/Tax', clubhouse: 400000, interest: 400000, water: 160000, dg: 160000, emergency: 160000, others: 230000,
      lateFeeEnabled: false, lateFeeKind: 'Percent per month', lateFeeValue: 2, lateFeeGraceDays: 15, lateFeeMaxMonths: 6, lateFeeAuto: false, blockDefaulters: false, blockOverdueDays: 60, blockOverdueAmount: 0, lockedUntil: '', approvalLimit: 0, approvalSeparate: false, invoiceSkipWithinQuote: false, allowOverride: true, finalCanDecideEC: true, invoiceTolerancePct: 5 },
  ],
  [COLLECTIONS.APPROVAL_POLICIES]: (() => {
    const EC = { kind: 'group', value: 'EC members' }; const FA = { kind: 'group', value: 'Final approvers' };
    return [
      { id: 'apl1', name: 'Maintenance work: EC, then final approvers', active: true, priority: 10, subjects: ['Maintenance quotation', 'Maintenance invoice'], minAmount: 0, maxAmount: 0, categories: [], taskTypes: [], requireFlag: '',
        steps: JSON.stringify([{ name: 'EC', approvers: [EC], needed: 1, canFinish: true }, { name: 'Final approval', approvers: [FA], needed: 1, canFinish: false }]) },
      { id: 'apl2', name: 'Fund release: EC', active: true, priority: 10, subjects: ['Maintenance release'], minAmount: 0, maxAmount: 0, categories: [], taskTypes: [], requireFlag: '',
        steps: JSON.stringify([{ name: 'EC', approvers: [EC], needed: 1, canFinish: true }, { name: 'Final approval', approvers: [FA], needed: 1, canFinish: false }]) },
      { id: 'apl3', name: 'Event expense: EC', active: true, priority: 10, subjects: ['Cultural expense'], minAmount: 0, maxAmount: 0, categories: [], taskTypes: [], requireFlag: '',
        steps: JSON.stringify([{ name: 'EC', approvers: [EC], needed: 1, canFinish: true }]) },
      { id: 'apl4', name: 'Event expense over the event limit: final approvers', active: true, priority: 20, subjects: ['Cultural expense'], minAmount: 0, maxAmount: 0, categories: [], taskTypes: [], requireFlag: 'eventFinal',
        steps: JSON.stringify([{ name: 'Final approval', approvers: [FA], needed: 1, canFinish: false }]) },
      { id: 'apl6', name: 'Cultural fund release: EC', active: true, priority: 10, subjects: ['Cultural release'], minAmount: 0, maxAmount: 0, categories: [], taskTypes: [], requireFlag: '',
        steps: JSON.stringify([{ name: 'EC', approvers: [EC], needed: 1, canFinish: true }]) },
      { id: 'apl5', name: 'Invoice above the approved amount: President too', active: true, priority: 30, subjects: ['Maintenance invoice'], minAmount: 0, maxAmount: 0, categories: [], taskTypes: [], requireFlag: 'overBudget',
        steps: JSON.stringify([{ name: 'President', approvers: [{ kind: 'role', value: 'president' }], needed: 1, canFinish: false }]) },
    ];
  })(),
  [COLLECTIONS.IMPORT_PROFILES]: [
    { id: 'ip1', name: 'HDFC statement (Excel)', account: '', sheet: '', headerRow: 1, dateCol: 'Date', narrationCol: 'Narration', debitCol: 'Withdrawal Amt.', creditCol: 'Deposit Amt.', balanceCol: 'Closing Balance', partyCol: 'Paid/Recieved', remarksCol: 'Remarks', dateMode: 'As in the file', skipSweep: true },
  ],
  [COLLECTIONS.BANK_TXNS]: laPaloma.txns.map(([date, ai, narration, debit, credit, balance, party, remarks], i) => {
    const account = BANK_ACCOUNT_NAMES[ai];
    return { id: `bt${i}`, date, account, narration, debit, credit, balance, party, remarks, head: categorize({ account, narration, party, remarks, debit, credit }) };
  }),
  [COLLECTIONS.ATTENDANCE]: ATT_ROWS,
  [COLLECTIONS.ATTENDANCE_SETTINGS]: [{ id: 'ats1', siteName: 'La Paloma (demo location - set yours under Site & GPS rules)', siteLat: DEMO_SITE.lat, siteLng: DEMO_SITE.lng, radiusM: 300, enforcement: 'Record only (flag exceptions)', graceMinutes: 15 }],
  [COLLECTIONS.SITE_SERVICES]: [
    { id: 'svc-trash', name: 'Trash pickup', icon: '🗑', mode: 'Collection', startTime: '07:00', endTime: '09:00', weekdays: [0, 1, 2, 3, 4, 5], area: 'All villas & apartments', notes: 'Keep bins outside the gate', active: true, order: 1 },
    { id: 'svc-workers', name: 'Workers allowed', icon: '🔨', mode: 'Access', startTime: '09:00', endTime: '18:00', weekdays: [0, 1, 2, 3, 4, 5], area: 'All', notes: 'Contractors, repairs and deliveries', active: true, order: 2 },
    { id: 'svc-water', name: 'Water tanker', icon: '🚚', mode: 'Collection', startTime: '06:00', endTime: '08:00', weekdays: [2, 5], area: 'Blocks without borewell', notes: 'Demo service added by the admin', active: true, order: 3 },
  ],
  [COLLECTIONS.SITE_HOLIDAYS]: [
    { id: 'hd1', date: plusDays(9), name: 'Gandhi Jayanti (demo)', trash: 'Rescheduled', trashNewDate: plusDays(10), workers: 'Not allowed', workersFrom: '', workersTo: '', note: 'Wet-waste pickup moves to the next day' },
    { id: 'hd2', date: plusDays(27), name: 'Diwali', trash: 'No pickup', trashNewDate: '', workers: 'Not allowed', workersFrom: '', workersTo: '', note: 'Please keep waste at home; pickup resumes next morning', effects: { 'Water tanker': { effect: 'As usual' } } },
    { id: 'hd3', date: plusDays(45), name: 'Christmas (demo)', trash: 'Pickup as usual', trashNewDate: '', workers: 'Limited hours', workersFrom: '10:00', workersTo: '14:00', note: '' },
  ],
  [COLLECTIONS.SITE_CALENDAR]: [
    { id: 'sc1', kind: 'Trash pickup', title: 'Wet waste (kitchen)', repeat: 'Weekly', weekdays: [0, 1, 2, 3, 4, 5], startTime: '07:00', endTime: '09:00', area: 'All villas & apartments', notes: 'Keep bins outside the gate by 6:45 am', date: '', endDate: '', allowed: '' },
    { id: 'sc2', kind: 'Trash pickup', title: 'Dry waste (recyclables)', repeat: 'Weekly', weekdays: [1, 4], startTime: '10:00', endTime: '12:00', area: 'All villas & apartments', notes: 'Clean, dry plastics, paper and metal', date: '', endDate: '', allowed: '' },
    { id: 'sc3', kind: 'Trash pickup', title: 'E-waste & hazardous', repeat: 'One date', weekdays: [], date: plusDays(12), startTime: '10:00', endTime: '13:00', area: 'Clubhouse parking', notes: 'Batteries, bulbs, small electronics', endDate: '', allowed: '' },
    { id: 'sc4', kind: 'Workers allowed', title: 'Contractors & repair workers', repeat: 'Weekly', weekdays: [0, 1, 2, 3, 4, 5], startTime: '09:00', endTime: '18:00', area: 'All', notes: 'No drilling or breaking after 6 pm', date: '', endDate: '', allowed: 'Allowed' },
    { id: 'sc5', kind: 'Workers allowed', title: 'Sundays & holidays', repeat: 'Weekly', weekdays: [6], startTime: '', endTime: '', area: 'All', notes: 'Emergency repairs only - inform the security office', date: '', endDate: '', allowed: 'Not allowed' },
  ],
  [COLLECTIONS.CULTURAL_EVENTS]: [
    { id: 'ce1', name: 'Vinayaka Chavithi 2026', type: 'Festival', startDate: '2026-09-14', endDate: '2026-09-24', venue: 'Clubhouse lawn', status: 'Completed', visibility: 'Published', programmeStatus: 'Published', fund: 'Ganesh', series: 'Vinayaka Chavithi', size: 'Large', historicalActual: 586304, upiPayee: 'La Paloma Cultural Committee', gateway: 'Demo gateway (simulated)', budget: 500000, targetCollection: 400000, upiId: 'lapaloma.culture@upi', description: '<p>Eleven days of pooja, aarti, prasadam and cultural evenings. <b>Mushika Seva</b> volunteers keep everything running.</p>', ...totalsOf(CULT_DON.filter((d) => d.eventId === 'ce1'), CULT_EXP.filter((d) => d.eventId === 'ce1')) },
    { id: 'ce2', defaultPeople: 4, name: 'Diwali Cultural Evening 2026', type: 'Cultural programme', startDate: plusDays(27), endDate: plusDays(27), venue: 'Party Hall - Banquet 1', status: 'Open', visibility: 'Published', programmeStatus: 'Published', fund: 'Cultural', series: 'Diwali', size: 'Medium', finalOver: 10000, upiPayee: 'La Paloma Cultural Committee', gateway: 'Demo gateway (simulated)', budget: 35000, targetCollection: 150000, upiId: 'lapaloma.culture@upi', description: '<p>Rangoli, kids’ performances, music and a community dinner. Sign up for programmes and seva below.</p>', ...totalsOf(CULT_DON.filter((d) => d.eventId === 'ce2'), CULT_EXP.filter((d) => d.eventId === 'ce2')) },
    { id: 'ce3', series: 'Ugadi', size: 'Small', name: 'Ugadi Celebration 2027', type: 'Festival', startDate: '2027-03-30', endDate: '2027-03-30', venue: 'Clubhouse lawn', status: 'Planning', visibility: 'Published', programmeStatus: 'Draft', upiId: 'lapaloma.culture@upi', upiPayee: 'La Paloma Cultural Committee', fund: 'Cultural', gateway: 'None (UPI QR only)', budget: 60000, targetCollection: 80000, description: '<p>Panchangam sravanam, Ugadi pachadi and a children’s programme. Agenda will be published soon.</p>', ...totalsOf([], []) },
    ...CULTURAL_HISTORY.map((e) => ({ ...e })),
  ],
  [COLLECTIONS.CULTURAL_PROGRAMS]: [
    { id: 'cp1', eventId: 'ce1', title: 'Pranapratishtha & first aarti', date: '2026-09-14', startTime: '18:00', endTime: '19:30', lead: 'Pandit Srinivas', venue: 'Pandal', capacity: 0, participants: [] },
    { id: 'cp2', eventId: 'ce1', title: 'Kids’ fancy dress', date: '2026-09-19', startTime: '17:00', endTime: '18:30', lead: 'Cultural Committee', venue: 'Clubhouse lawn', capacity: 20, participants: [] },
    { id: 'cp3', eventId: 'ce2', title: 'Rangoli competition', date: plusDays(27), startTime: '16:00', endTime: '17:30', lead: 'Cultural Committee', venue: 'Podium', capacity: 30, participants: [{ name: 'Ananya Mehta', unit: 'Villa 135', phone: '' }] },
    { id: 'cp4', eventId: 'ce2', title: 'Kids’ dance & music showcase', date: plusDays(27), startTime: '18:00', endTime: '19:30', lead: 'Meera Rao', venue: 'Party Hall - Banquet 1', capacity: 25, participants: [] },
    { id: 'cp5', eventId: 'ce2', title: 'Community dinner', date: plusDays(27), startTime: '19:45', endTime: '21:30', lead: 'Catering team', venue: 'Party Hall - Banquet 1', capacity: 0, participants: [] },
    { id: 'cp6', eventId: 'ce3', title: 'Panchangam sravanam', date: '2027-03-30', startTime: '17:00', endTime: '17:45', lead: 'Pandit Srinivas', venue: 'Clubhouse lawn', capacity: 0, participants: [] },
  ],
  [COLLECTIONS.CULTURAL_SEVAS]: [
    { id: 'cs1', eventId: 'ce1', title: 'Flower decoration', date: '2026-09-14', startTime: '09:00', endTime: '12:00', needed: 6, description: 'Mandap and entrance decoration', volunteers: [{ name: 'Ananya Mehta', unit: 'Villa 135', phone: '' }, { name: 'Ravi Kumar', unit: 'Villa 48', phone: '' }] },
    { id: 'cs2', eventId: 'ce2', title: 'Rangoli set-up', date: plusDays(27), startTime: '13:00', endTime: '16:00', needed: 5, description: 'Marking the floor, colours and lights', volunteers: [{ name: 'Ravi Kumar', unit: 'Villa 48', phone: '' }] },
    { id: 'cs3', eventId: 'ce2', title: 'Food counter & serving', date: plusDays(27), startTime: '19:30', endTime: '21:30', needed: 8, description: 'Serving and clean-up at the community dinner', volunteers: [] },
    { id: 'cs4', eventId: 'ce2', title: 'Registration desk', date: plusDays(27), startTime: '15:30', endTime: '18:00', needed: 2, description: 'Welcome guests, hand out passes', volunteers: [] },
  ],
  [COLLECTIONS.CULTURAL_OFFERINGS]: [
    { id: 'co1', eventId: 'ce2', title: 'Rangoli & entrance decoration', day: 'Evening (main entrance, podium)', kind: 'Fixed slot', pledgeValue: 30000, description: 'Large floor rangoli, flower arches and welcome entrance set-up', reservedBy: '', reservedUnit: '' },
    { id: 'co2', eventId: 'ce2', title: 'Diyas & festive lighting', day: 'Evening (clubhouse & lawn)', kind: 'Fixed slot', pledgeValue: 20000, description: 'Diyas, string lights and lanterns across the venue', reservedBy: '', reservedUnit: '' },
    { id: 'co3', eventId: 'ce2', title: 'Kids’ prizes & gifts', day: 'Programme', kind: 'Fixed slot', pledgeValue: 10000, description: 'Prizes and return gifts for every participating child', reservedBy: '', reservedUnit: '' },
    { id: 'co4', eventId: 'ce2', title: 'Stage lighting & sound', day: 'Programme', kind: 'Fixed slot', pledgeValue: 25000, description: 'Stage, lights and sound for the evening', reservedBy: 'Ravi Kumar', reservedUnit: 'Villa 48', reservedAt: '2026-10-09', donationId: 'cd9' },
    { id: 'co5', eventId: 'ce2', title: 'Community dinner', day: 'Dinner (open for any amount)', kind: 'Community pool', pledgeValue: 0, description: 'Community feast for all residents — contribute any amount' },
    { id: 'co6', eventId: 'ce1', title: 'Decoration (main entrance, Ganesha and photo booth)', day: 'Day 1 (Inaugural festive set-up)', kind: 'Fixed slot', pledgeValue: 30000, description: 'Grand mandapam backdrop, lighting, flower arches and welcome entrance set-up', reservedBy: 'Sunita Rao', reservedUnit: 'Villa 77', reservedAt: '2026-09-01', donationId: 'cd10' },
    { id: 'co7', eventId: 'ce1', title: 'Grand Banti Bhojanalu & Visarjan procession', day: 'Day 7 (Grand finale)', kind: 'Community pool', pledgeValue: 0, description: 'Community feast for all residents and the Visarjan procession' },
  ],
  [COLLECTIONS.CULTURAL_DONATIONS]: CULT_DON,
  [COLLECTIONS.CULTURAL_EXPENSES]: CULT_EXP,
  [COLLECTIONS.DOCUMENTS]: [
    { id: 'doc1', title: 'Association Bylaws 2026', category: 'Association', version: 'v3.2', access: 'Everyone', expiry: '', unit: '' },
    { id: 'doc2', title: 'Villa 135 ownership deed', category: 'Villa document', version: 'v1.0', access: 'Villa owner / resident', expiry: '', unit: 'Villa 135' },
    { id: 'doc3', title: 'ARC Facility Management Contract', category: 'Vendor contract', version: 'v1.0', access: 'EC + Finance', expiry: '2027-03-31', unit: '' },
    { id: 'doc4', title: 'AGM Minutes — 2026', category: 'Association', version: 'v1.1', access: 'All owners', expiry: '', unit: '' },
  ],
};

// Bump when seed data / schemas / record shape change. A DEMO community whose tab still holds data from an older
// build (sessionStorage survives reloads) is reset to fresh demo data instead of running new code against stale
// schemas and records. A real (non-demo) community is never reset this way.
mergeReferenceData(SEED, COLLECTIONS);

export const DATA_VERSION = '2026-10-24-b';
const versionKey = (slug) => `communityos:${slug}:dataVersion`;

export function resetDemoData(slug = getCommunity()) {
  storage.clearCommunity(slug);
}

/** Collections every NEW community starts with: configuration and defaults, never people or money. */
const TEMPLATE_COLLECTIONS = [
  COLLECTIONS.COMMUNITY_CONFIG, COLLECTIONS.FACILITIES, COLLECTIONS.IMPORTANT_NUMBERS, COLLECTIONS.NUMBER_SECTIONS,
  COLLECTIONS.UTILITY_TYPES, COLLECTIONS.LOG_TYPES, COLLECTIONS.TASK_TYPES, COLLECTIONS.QUICK_PHRASES, COLLECTIONS.AMENITY_TYPES, COLLECTIONS.AMENITY_ITEMS, COLLECTIONS.AMENITY_SETTINGS, COLLECTIONS.NOTIFICATION_TEMPLATES, COLLECTIONS.CATEGORY_MAP, COLLECTIONS.APPROVER_SETTINGS,
  COLLECTIONS.NOTICE_TEMPLATES, COLLECTIONS.MERGE_FIELDS, COLLECTIONS.EC_ROLES, COLLECTIONS.SUBCOMMITTEES, COLLECTIONS.VILLA_IMPORT_RULES, COLLECTIONS.IMPORT_PROFILES, COLLECTIONS.TAX_SETTINGS, COLLECTIONS.TAX_COMPONENTS,
];

/** What a new community receives besides the 18 default roles and all field/permission schemas (which load from DEFAULT_ROLES / DEFAULT_SCHEMAS). */
export function templateSeed(community) {
  const out = {};
  for (const c of TEMPLATE_COLLECTIONS) out[c] = (SEED[c] || []).map((r) => ({ ...r }));
  out[COLLECTIONS.CATEGORY_MAP] = out[COLLECTIONS.CATEGORY_MAP].map((r) => ({ ...r, vendor: '' })); // vendors are the community's own
  out[COLLECTIONS.AMENITY_SETTINGS] = out[COLLECTIONS.AMENITY_SETTINGS].map((r) => ({ ...r, gstin: '', adminRecipients: [], reportRecipients: [] }));
  // a new community prints ITS OWN name and details (never La Paloma's), and starts as not yet entered
  out[COLLECTIONS.COMMUNITY_CONFIG] = out[COLLECTIONS.COMMUNITY_CONFIG].map((r) => ({ ...r, legalName: community?.name || '', address: '', registrationNo: '', panNo: '', taxRegistered: 'Yes', taxId: '', contactPhone: '', contactEmail: '', website: '', signatory: '', payInstructions: '', statementNote: '' }));
  out[COLLECTIONS.EC_ROLES] = out[COLLECTIONS.EC_ROLES].map((r) => ({ ...r, personName: '' }));
  out[COLLECTIONS.SUBCOMMITTEES] = out[COLLECTIONS.SUBCOMMITTEES].map((r) => ({ ...r, memberCount: 0 }));
  out[COLLECTIONS.MERGE_FIELDS] = out[COLLECTIONS.MERGE_FIELDS].map((r) => (r.token === '{{SOCIETY_NAME}}' ? { ...r, defaultValue: community?.name || '' } : r));
  return out;
}

/** The first person of a new community: its Super Admin. */
export const adminUserRow = (a) => ({ name: a.name, phone: a.phone || '', email: (a.email || '').trim().toLowerCase(), status: 'Active', roleId: 'super_admin', extraRoleIds: [], units: [] });

/** Write `source` ({collection: rows}) into a community's storage where that collection is still empty. */
/** Same input -> same UUID-shaped id. Two tabs (or React's double effect) seeding one empty back end at the same moment
 *  must produce identical ids, or the cross references (event -> programme ...) would point at the other run's rows. */
function stableId(key) {
  const h = [0x811c9dc5, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35];
  for (let i = 0; i < key.length; i++) for (let k = 0; k < 4; k++) h[k] = Math.imul(h[k] ^ key.charCodeAt(i), 0x01000193 + k * 2) >>> 0;
  const x = h.map((n) => n.toString(16).padStart(8, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-a${x.slice(17, 20)}-${x.slice(20, 32)}`;
}
const seeding = new Map(); // one seed run per community per tab
export function seedCommunity(store, source) {
  const k = store; if (seeding.has(k)) return seeding.get(k);
  const run = seedCommunityOnce(store, source).finally(() => seeding.delete(k));
  seeding.set(k, run); return run;
}
async function seedCommunityOnce(store, source) {
  // Back end: one cheap look instead of ~100 (a list per collection). Seeded already = users exist = nothing to do.
  // (A new build that adds a collection to the demo data does not backfill a back end that has been seeded: use the Data source panel's copy.)
  if (isApiMode() && (await store.list(COLLECTIONS.USERS)).length > 0) return;
  // Primary keys are UUIDs. Seed rows are written with readable placeholder ids, so give each a real
  // UUID and re-point the few cross references. shortId is the human-facing per-module id.
  const idMap = {};
  for (const [collection, records] of Object.entries(source)) {
    records.forEach((r) => { if (r.id) idMap[`${collection}:${r.id}`] = stableId(`${collection}:${r.id}`); });
  }
  const REFS = {
    [COLLECTIONS.TICKET_COMMENTS]: { ticketId: COLLECTIONS.TICKETS },
    [COLLECTIONS.QUOTATIONS]: { ticketId: COLLECTIONS.TICKETS },
    [COLLECTIONS.TICKETS]: { selectedQuotationId: COLLECTIONS.QUOTATIONS, assetId: COLLECTIONS.EQUIPMENT },
    [COLLECTIONS.EQUIPMENT]: { planId: COLLECTIONS.INFRA_PLANS },
    [COLLECTIONS.INFRA_LOG]: { assetId: COLLECTIONS.EQUIPMENT },
    [COLLECTIONS.FORUM_POSTS]: { topicId: COLLECTIONS.FORUM, parentId: COLLECTIONS.FORUM_POSTS },
    [COLLECTIONS.VENDOR_COMMENTS]: { vendorId: COLLECTIONS.VENDORS },
    [COLLECTIONS.EVENT_WORK]: { eventId: COLLECTIONS.CULTURAL_EVENTS },
    [COLLECTIONS.CHECKLIST_ROUNDS]: { checklistId: COLLECTIONS.CHECKLISTS },
    [COLLECTIONS.CULTURAL_PROGRAMS]: { eventId: COLLECTIONS.CULTURAL_EVENTS },
    [COLLECTIONS.CULTURAL_SEVAS]: { eventId: COLLECTIONS.CULTURAL_EVENTS },
    [COLLECTIONS.CULTURAL_DONATIONS]: { eventId: COLLECTIONS.CULTURAL_EVENTS, offeringId: COLLECTIONS.CULTURAL_OFFERINGS },
    [COLLECTIONS.CULTURAL_OFFERINGS]: { eventId: COLLECTIONS.CULTURAL_EVENTS, donationId: COLLECTIONS.CULTURAL_DONATIONS },
    [COLLECTIONS.CULTURAL_EXPENSES]: { eventId: COLLECTIONS.CULTURAL_EVENTS },
    [COLLECTIONS.CONTACT_REVIEWS]: { contactId: COLLECTIONS.SERVICE_CONTACTS },
    [COLLECTIONS.AUDITS]: { auditorVendorId: COLLECTIONS.VENDORS },
    [COLLECTIONS.DUES]: { readingId: COLLECTIONS.READINGS },
    [COLLECTIONS.READINGS]: { dueId: COLLECTIONS.DUES },
    [COLLECTIONS.GATE_LINKS]: { personId: COLLECTIONS.GATE_PEOPLE },
    [COLLECTIONS.GATE_VISITS]: { personId: COLLECTIONS.GATE_PEOPLE, passId: COLLECTIONS.GATE_PASSES, workOrderId: COLLECTIONS.GATE_WORKORDERS, approvalId: COLLECTIONS.GATE_APPROVALS },
    [COLLECTIONS.GATE_APPROVALS]: { visitId: COLLECTIONS.GATE_VISITS },
    [COLLECTIONS.GATE_FLAGS]: { visitId: COLLECTIONS.GATE_VISITS, personId: COLLECTIONS.GATE_PEOPLE },
    [COLLECTIONS.GATE_WORKORDERS]: { rosterIds: COLLECTIONS.GATE_PEOPLE },
    [COLLECTIONS.GATE_ROUNDS]: { checkpointIds: COLLECTIONS.GATE_CHECKPOINTS },
  };
  for (const [collection, records] of Object.entries(source)) {
    const existing = await store.list(collection);
    if (existing.length === 0) {
      // every record gets an Id + metadata from day one (audit/"last updated by" need them)
      const now = new Date().toISOString();
      const stamped = records.map((r, i) => {
        const parsed = Date.parse(r.createdAt);
        const refs = {};
        for (const [field, target] of Object.entries(REFS[collection] || {})) {
          if (Array.isArray(r[field])) refs[field] = r[field].map((x) => idMap[`${target}:${x}`] || x);
          else if (r[field]) refs[field] = idMap[`${target}:${r[field]}`] || r[field];
        }
        const shortId = collection === COLLECTIONS.TICKETS && r.ticketNumber ? r.ticketNumber : `${shortPrefix(collection)}-${String(i + 1).padStart(4, '0')}`;
        return {
          ...r,
          ...refs,
          id: idMap[`${collection}:${r.id}`] || stableId(`${collection}:${i}:${JSON.stringify(r).length}`),
          shortId,
          recVersion: r.recVersion ?? 1,
          recordCreatedAt: r.recordCreatedAt ?? (isNaN(parsed) ? now : new Date(parsed).toISOString()),
          recordCreatedBy: r.recordCreatedBy ?? 'System (seed data)',
          lastUpdatedAt: r.lastUpdatedAt ?? now,
          lastUpdatedBy: r.lastUpdatedBy ?? 'System (seed data)',
        };
      });
      await store.replaceAll(collection, stamped);
    }
  }
}

/** Called when the tab opens a community: demo communities get the full La Paloma demo data, real ones were provisioned empty. */
export async function seedIfEmpty(community) {
  const slug = community?.slug || getCommunity();
  if (community?.demoData) {
    try {
      // Only the throw-away browser store is reset when the build changes. A real database is NEVER wiped by opening the app.
      if (!isApiMode() && sessionStorage.getItem(versionKey(slug)) !== DATA_VERSION) {
        resetDemoData(slug);
        sessionStorage.setItem(versionKey(slug), DATA_VERSION);
      }
    } catch { /* storage unavailable */ }
    await seedCommunity(storage, SEED);
  }
}

/** The starting data of a new community ({collection: rows}): the defaults or the demo data, and its first Super Admin. Also used by the server. */
export async function provisionSource(community, admin) {
  const source = community.demoData ? { ...SEED } : templateSeed(community);
  if (admin?.name) {
    const row = adminUserRow(admin);
    source[COLLECTIONS.USERS] = community.demoData ? [...(SEED[COLLECTIONS.USERS] || []), { id: 'u_admin', ...row }] : [{ id: 'u_admin', ...row }];
  }
  if (community.largeData) {
    // large test community: blocks, thousands of units, a year of dues, tickets, bookings, several clubhouses and pools
    const { largeCommunityData } = await import('./syntheticCommunity.js');
    const big = largeCommunityData(typeof community.largeData === 'object' ? community.largeData : {});
    const extraUsers = big[COLLECTIONS.USERS] || []; delete big[COLLECTIONS.USERS];
    Object.assign(source, big);
    source[COLLECTIONS.USERS] = [...(source[COLLECTIONS.USERS] || []), ...extraUsers];
  }
  return source;
}

/** Platform console: create a community's starting data (defaults, or the demo data) and its first Super Admin. */
export async function provisionCommunity(community, admin) {
  const store = storage.forCommunity(community.slug);
  await seedCommunity(store, await provisionSource(community, admin));
  if (community.demoData) { try { sessionStorage.setItem(versionKey(community.slug), DATA_VERSION); } catch { /* ignore */ } }
}

/** Stamp one hand-made row (e.g. adding a person to a community from the console) with the standard record metadata. */
export function stampRow(collection, row, count = 0, by = 'Platform admin') {
  const now = new Date().toISOString();
  return { ...row, id: row.id || uuid(), shortId: `${shortPrefix(collection)}-${String(count + 1).padStart(4, '0')}`, recVersion: 1, recordCreatedAt: now, recordCreatedBy: by, lastUpdatedAt: now, lastUpdatedBy: by };
}
