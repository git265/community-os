import { region } from './region/regions.js';
import { communityTaxId, localDay, todayLocal } from './locale.js';
import { billTermsText } from './billText.js';
// Amenity pricing, GST, deposit, cancellation / refund rules, message templates and report text.
// Pure functions (no storage, no React) so the booking screen can PREVIEW exactly what the server-side hook later CHARGES.
// Every rate, tax rule, deposit and cancellation tier is data on the amenity (or the settings row), never code.

export const RATE_UNITS = ['Per hour', 'Per day / event', 'Free'];
export const GST_MODES = ['Exclusive', 'Inclusive'];
// Payment modes follow the community's country (lib/region/paymentModes.js): online = through the gateway, office = booking stays "Pending payment" until staff mark it received
export { ONLINE_MODES, OFFICE_MODES, PAYMENT_MODES } from './region/paymentModes.js';

export const DEFAULT_CANCELLATION = [
  { hoursBefore: 72, refundPct: 100 },
  { hoursBefore: 24, refundPct: 50 },
  { hoursBefore: 0, refundPct: 0 },
];

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const creditBalance = (rows, unit) => round2(rows.filter((r) => r.unit === unit).reduce((n, r) => n + (r.type === 'Credit' ? 1 : -1) * (Number(r.amount) || 0), 0));
export const inr = (n) => `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: round2(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;

const isWeekend = (date) => { const d = new Date(`${date}T12:00:00`).getDay(); return d === 0 || d === 6; };

/** Cancellation tiers, cleaned and sorted (longest notice first). Falls back to the community default. */
export function tiersOf(amenity) {
  const raw = Array.isArray(amenity?.cancellationRules) && amenity.cancellationRules.length ? amenity.cancellationRules : DEFAULT_CANCELLATION;
  return raw
    .map((t) => ({ hoursBefore: Math.max(0, Number(t.hoursBefore) || 0), refundPct: Math.min(100, Math.max(0, Number(t.refundPct) || 0)) }))
    .sort((a, b) => b.hoursBefore - a.hoursBefore);
}

/** The amount on the booking screen: rate -> taxable value -> GST -> fee, plus the refundable security deposit. */
export function quote(amenity, date, settings = {}, extras = 0) {
  if (!amenity) return null;
  const addOn = round2(Number(extras) || 0);
  const free = (amenity.rateUnit === 'Free' || !(Number(amenity.rate) > 0)) && addOn <= 0;
  const weekend = !!date && isWeekend(date) && Number(amenity.weekendRate) > 0;
  const serviceFree = amenity.rateUnit === 'Free' || !(Number(amenity.rate) > 0);
  const rate = free ? 0 : (serviceFree ? 0 : Number(weekend ? amenity.weekendRate || amenity.rate : amenity.rate)) + addOn;
  const gstOn = !free && !!amenity.gstApplicable;
  const gstRate = gstOn ? Number(amenity.gstRate ?? settings.defaultGstRate ?? 18) : 0;
  const mode = amenity.gstMode || 'Exclusive';
  let base = rate;
  let gst = 0;
  let fee = rate;
  if (gstOn && mode === 'Inclusive') { base = round2(rate / (1 + gstRate / 100)); gst = round2(rate - base); fee = round2(rate); }
  if (gstOn && mode !== 'Inclusive') { base = round2(rate); gst = round2(base * gstRate / 100); fee = round2(base + gst); }
  const deposit = round2(Number(amenity.depositAmount) || 0);
  return { free, weekend, addOn, rate, rateUnit: amenity.rateUnit || 'Per day / event', base, gstRate, gst, fee, gstMode: mode, deposit, total: round2(fee + deposit), halves: gstOn ? round2(gst / 2) : 0 };
}

/** "₹2,500 + 18% GST / event" - the one-line price shown on amenity chips and cards. */
export function priceLabel(amenity) {
  if (!amenity) return '';
  if (amenity.rateUnit === 'Free' || !(Number(amenity.rate) > 0)) return amenity.freeLabel || 'Free for residents';
  const unit = amenity.rateUnit === 'Per hour' ? 'hour' : 'event';
  const tax = amenity.gstApplicable ? (amenity.gstMode === 'Inclusive' ? ` incl. ${amenity.gstRate ?? 18}% GST` : ` + ${amenity.gstRate ?? 18}% GST`) : '';
  return `${inr(amenity.rate)}${tax} / ${unit}`;
}

/** When the booking starts (local time). A slot starts at its first hour; a full-day booking at the amenity's opening time. */
export function startAtOf(date, slot, amenity) {
  const m = /^(\d{1,2}):(\d{2})/.exec(slot && slot !== 'Full day' ? slot : amenity?.hours || '');
  const hh = m ? String(m[1]).padStart(2, '0') : '00';
  const mm = m ? m[2] : '00';
  return `${date}T${hh}:${mm}:00`;
}

export const hoursUntil = (startAt, now = new Date()) => (new Date(startAt).getTime() - now.getTime()) / 3600000;

/** Can this booking still be made? (minimum notice and how far ahead residents may book) */
export function bookingWindowError(amenity, date, slot, now = new Date()) {
  const left = hoursUntil(startAtOf(date, slot, amenity), now);
  const minH = Number(amenity?.minNoticeHours) || 0;
  const maxD = Number(amenity?.maxAdvanceDays) || 0;
  if (left < 0) return 'That time has already passed.';
  if (minH && left < minH) return `This amenity must be booked at least ${minH} hour${minH === 1 ? '' : 's'} ahead.`;
  if (maxD && left > maxD * 24) return `This amenity can be booked at most ${maxD} days ahead.`;
  return '';
}

export const ITEMS_ONLY = 'Items only (no space)';
export const RESERVATION_MODES = ['Reservation required', 'Walk-in (no reservation)', ITEMS_ONLY];
export const isWalkIn = (a) => a?.reservation === 'Walk-in (no reservation)';
/** Chairs, tables, linen and the like hired on their own: no space is held, so any number of units may book the same day until the stock runs out. */
export const isItemsOnly = (a) => a?.reservation === ITEMS_ONLY;
/** May this person ignore the booking window and limits for this amenity? (Super Admin always; otherwise the roles the committee named, if they are on the amenities team.) */
export const canOverrideRules = (amenity, roleId, isStaff) => !!isStaff && (roleId === 'super_admin' || !(amenity?.overrideRoles || []).length || amenity.overrideRoles.includes(roleId));

/** The per-amenity limits a resident is held to: blocked dates, which unit types may book, and how many bookings a unit may hold. */
export function bookingRulesError(amenity, { date, unit = '', unitType = '', bookings = [] } = {}) {
  const a = amenity || {};
  if ((a.blackoutDates || []).includes(date)) return `${a.name} is closed on ${date}.`;
  const types = a.allowedUnitTypes || [];
  if (types.length && unitType && !types.includes(unitType)) return `${a.name} can be booked by ${types.join(' / ').toLowerCase()} units only.`;
  const mine = bookings.filter((b) => b.unit === unit && b.amenity === a.name && b.status !== 'Cancelled');
  const perDay = Number(a.maxPerDay) || 0;
  if (perDay && mine.filter((b) => b.date === date).length >= perDay) return `One unit can hold at most ${perDay} booking${perDay === 1 ? '' : 's'} a day for ${a.name}.`;
  const perMonth = Number(a.maxPerMonth) || 0;
  if (perMonth && mine.filter((b) => String(b.date).slice(0, 7) === String(date).slice(0, 7)).length >= perMonth) return `One unit can book ${a.name} at most ${perMonth} time${perMonth === 1 ? '' : 's'} a month.`;
  const upcoming = Number(a.maxUpcoming) || 0;
  const now = todayLocal();
  if (upcoming && mine.filter((b) => b.date >= now && !['Completed'].includes(b.status)).length >= upcoming) return `You already hold ${upcoming} upcoming booking${upcoming === 1 ? '' : 's'} for ${a.name}. Use or cancel one first.`;
  return '';
}

/** Human text for the rules table: "Cancel 72 h or more before: 100% refund". */
export function tierText(t, i, all) {
  const lower = all[i + 1];
  if (t.hoursBefore === 0) return `Less than ${all[i - 1]?.hoursBefore ?? 0} h before the start, or after it: ${t.refundPct}% refund`;
  return `${t.hoursBefore} h or more before the start${lower ? '' : ''}: ${t.refundPct}% refund`;
}

/**
 * What cancelling NOW refunds. `paid` = money actually received (fee + deposit). Fee is refunded by the tier of notice; the security
 * deposit is always returned in full. A staff-waived cancellation (e.g. the community cancels) refunds everything.
 */
export function cancellationQuote(booking, amenity, now = new Date(), { waive = false } = {}) {
  const startAt = booking.startAt || startAtOf(booking.date, booking.slot, amenity);
  const left = hoursUntil(startAt, now);
  const tiers = booking.policySnapshot?.length ? booking.policySnapshot : tiersOf(amenity);
  const tier = tiers.find((t) => left >= t.hoursBefore) || { hoursBefore: 0, refundPct: 0 };
  const pct = waive ? 100 : tier.refundPct;
  const feePaid = booking.paymentStatus === 'Paid' ? round2(booking.feeTotal) : 0;
  const depPaid = booking.paymentStatus === 'Paid' ? round2(booking.depositAmount) : 0;
  const refundFee = round2(feePaid * pct / 100);
  const retained = round2(feePaid - refundFee);
  return { hoursLeft: Math.max(0, Math.round(left * 10) / 10), pct, tier, feePaid, depPaid, refundFee, refundDeposit: depPaid, retained, refund: round2(refundFee + depPaid), waived: waive, paid: booking.paymentStatus === 'Paid' };
}

/* --------------------------------------------------------- templates ----- */

export const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
export const EVENTS = [
  { id: 'booking_confirmed', label: 'Booking confirmed', hint: 'Sent when a booking is made and paid (or free).' },
  { id: 'booking_pending', label: 'Booking awaiting payment', hint: 'Cash / cheque bookings until the office records the payment.' },
  { id: 'payment_received', label: 'Payment received', hint: 'Sent when pending payment is recorded.' },
  { id: 'booking_cancelled', label: 'Booking cancelled', hint: 'Sent with the refund summary.' },
  { id: 'refund_processed', label: 'Refund processed', hint: 'Sent when a refund is credited or paid out.' },
  { id: 'deposit_settled', label: 'Security deposit settled', hint: 'Sent when the deposit is released or deductions are made.' },
  { id: 'payment_expired', label: 'Unpaid booking released', hint: 'Sent when an unpaid booking is auto-released.' },
  { id: 'reminder', label: 'Booking reminder', hint: 'Sent the day before the booking.' },
  { id: 'daily_report', label: 'Daily report', hint: 'Today\'s activity and tomorrow\'s schedule.' },
  { id: 'summary_report', label: 'Summary report', hint: 'Weekly / monthly totals with payment and tax details.' },
];
export const BOOKING_EVENTS = EVENTS.filter((e) => !/report/.test(e.id)).map((e) => e.id);
export const TOKENS = [
  '{{community}}', '{{booking_no}}', '{{amenity}}', '{{date}}', '{{slot}}', '{{unit}}', '{{owner}}', '{{rate}}', '{{taxable}}', '{{gst_rate}}', '{{gst}}', '{{tax_name}}', '{{tax_breakdown}}', '{{pay_by}}', '{{fee}}', '{{deposit}}',
  '{{total}}', '{{payment_mode}}', '{{payment_status}}', '{{refund}}', '{{refund_pct}}', '{{retained}}', '{{deposit_returned}}', '{{reason}}', '{{gstin}}', '{{report}}', '{{report_period}}',
];

export function renderTemplate(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

/** Values for the template tokens of one booking. */
export function bookingVars(b, { community = '', settings = {}, owner = '', reason = '', extra = {} } = {}) {
  return {
    community, booking_no: b.shortId || '', amenity: b.amenity, date: b.date, slot: b.slot, unit: b.unit, owner,
    rate: inr(b.rate), taxable: inr(b.baseAmount), gst_rate: `${b.gstRate || 0}%`, tax_name: region().tax.name, tax_breakdown: billTermsText({ amount: b.gstMode === 'Inclusive' ? b.feeTotal : b.baseAmount, rate: b.gstRate, mode: b.gstMode, showPenalty: false }).split('\n').filter((l) => /breakdown/.test(l)).join(' '), pay_by: '', gst: inr(b.gstAmount), fee: inr(b.feeTotal), deposit: inr(b.depositAmount), total: inr(b.totalPayable),
    payment_mode: b.paymentMode || '—', payment_status: b.paymentStatus || '', refund: inr(b.refundAmount), refund_pct: `${b.refundPct ?? 0}%`, retained: inr(b.retainedAmount),
    deposit_returned: inr(b.depositReturned), reason: reason || b.cancelReason || '', gstin: communityTaxId(), ...extra,
  };
}

/* ---------------------------------------------------------- reports ------ */

const dayOf = (s) => localDay(s || '');
const addDays = (d, n) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return localDay(x); };
export { addDays };

/** Money columns for a set of bookings, by the day money moved (paidAt / cancelledAt). */
export function moneyTotals(bookings, from, to) {
  const inRange = (d) => d && dayOf(d) >= from && dayOf(d) <= to;
  const paid = bookings.filter((b) => inRange(b.paidAt));
  const refunded = bookings.filter((b) => inRange(b.cancelledAt) && Number(b.refundAmount) > 0);
  const sum = (l, k) => round2(l.reduce((n, b) => n + (Number(b[k]) || 0), 0));
  const retainedCancel = bookings.filter((b) => inRange(b.cancelledAt));
  // deposits handed back after the event (a cancelled booking's deposit is already inside its refund)
  const settled = bookings.filter((b) => b.status !== 'Cancelled' && inRange(b.depositSettledAt) && Number(b.depositReturned) > 0);
  const waived = bookings.filter((b) => b.chargeWaived && inRange(b.recordCreatedAt));
  const depositsReturned = sum(settled, 'depositReturned');
  return {
    depositsReturned, waived: sum(waived, 'waivedAmount'), waivedCount: waived.length,
    bookingsPaid: paid.length, taxable: sum(paid, 'baseAmount'), gst: sum(paid, 'gstAmount'), fees: sum(paid, 'feeTotal'), deposits: sum(paid, 'depositAmount'),
    collected: round2(sum(paid, 'feeTotal') + sum(paid, 'depositAmount')), refunds: sum(refunded, 'refundAmount'), retained: sum(retainedCancel, 'retainedAmount'),
    net: round2(sum(paid, 'feeTotal') + sum(paid, 'depositAmount') - sum(refunded, 'refundAmount') - depositsReturned),
  };
}

/** Plain-text report (works in WhatsApp, SMS and e-mail alike). kind: 'daily' | 'summary'. */
export function buildReport(kind, { bookings = [], community = '', settings = {}, from, to, today }) {
  const active = (b) => b.status !== 'Cancelled';
  const lines = [];
  const money = moneyTotals(bookings, from, to);
  const L = (s = '') => lines.push(s);
  const head = kind === 'daily' ? `${community} · Amenity daily report · ${today}` : `${community} · Amenity summary · ${from} to ${to}`;
  L(`*${head}*`);
  if (communityTaxId()) L(`${region().tax.idLabel} ${communityTaxId()}`);
  L();
  if (kind === 'daily') {
    const todayB = bookings.filter((b) => active(b) && b.date === today).sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
    const tmr = addDays(today, 1);
    const tmrB = bookings.filter((b) => active(b) && b.date === tmr).sort((a, b) => String(a.slot).localeCompare(String(b.slot)));
    L(`*Today (${todayB.length})*`);
    todayB.forEach((b) => L(`• ${b.amenity} · ${b.slot} · ${b.unit} · ${b.paymentStatus || ''}`));
    if (!todayB.length) L('• No bookings');
    L();
    L(`*Tomorrow ${tmr} (${tmrB.length})*`);
    tmrB.forEach((b) => L(`• ${b.amenity} · ${b.slot} · ${b.unit}`));
    if (!tmrB.length) L('• No bookings');
    L();
    const made = bookings.filter((b) => dayOf(b.recordCreatedAt) === today).length;
    const cancelled = bookings.filter((b) => dayOf(b.cancelledAt) === today);
    L(`New bookings today: ${made} · Cancellations: ${cancelled.length}`);
  } else {
    const names = [...new Set(bookings.map((b) => b.amenity))];
    L('*By amenity*');
    names.forEach((n) => {
      const rows = bookings.filter((b) => b.amenity === n && b.date >= from && b.date <= to);
      const act = rows.filter(active);
      L(`• ${n}: ${act.length} booking${act.length === 1 ? '' : 's'}, ${rows.length - act.length} cancelled`);
    });
    L();
  }
  const pending = bookings.filter((b) => b.paymentStatus === 'Pending' && active(b));
  const refundDue = bookings.filter((b) => b.refundStatus === 'Refund due');
  const held = bookings.filter((b) => b.depositStatus === 'Held');
  L(`*Payments ${kind === 'daily' ? 'today' : 'in period'}*`);
  L(`Taxable value: ${inr(money.taxable)}`);
  L(`GST${settings.defaultGstRate ? '' : ''}: ${inr(money.gst)}`);
  L(`Fees incl. GST: ${inr(money.fees)}`);
  L(`Security deposits received: ${inr(money.deposits)}`);
  L(`Refunds: ${inr(money.refunds)}`);
  L(`Security deposits returned: ${inr(money.depositsReturned)}`);
  if (money.waivedCount) L(`Charges waived (free bookings): ${inr(money.waived)} on ${money.waivedCount} booking${money.waivedCount === 1 ? '' : 's'}`);
  L(`*Net received: ${inr(money.net)}*`);
  L();
  L(`Awaiting payment: ${pending.length} (${inr(pending.reduce((n, b) => n + (Number(b.totalPayable) || 0), 0))})`);
  L(`Refunds due: ${refundDue.length} (${inr(refundDue.reduce((n, b) => n + (Number(b.refundAmount) || 0), 0))})`);
  L(`Deposits held: ${held.length} (${inr(held.reduce((n, b) => n + (Number(b.depositAmount) || 0), 0))})`);
  return { subject: head, text: lines.join('\n'), money, counts: { pending: pending.length, refundDue: refundDue.length, held: held.length } };
}

/** Starter message wording, seeded per event + channel + audience. Everything is editable (Notifications -> Templates). */
export function defaultTemplates() {
  const rows = [];
  const body = {
    booking_confirmed: {
      Owner: 'Hi {{owner}}, your booking {{booking_no}} is confirmed.\n{{amenity}} · {{date}} · {{slot}}\nFee {{taxable}} + {{tax_name}} {{gst}} ({{gst_rate}}) = {{fee}}\n{{tax_breakdown}}\nRefundable deposit {{deposit}}\nTotal paid {{total}} via {{payment_mode}}.\n— {{community}}',
      Admin: 'New booking {{booking_no}}: {{amenity}} · {{date}} · {{slot}} · {{unit}} ({{owner}})\nFee {{fee}} (GST {{gst}}), deposit {{deposit}}, total {{total}} · {{payment_mode}} · {{payment_status}}',
    },
    booking_pending: {
      Owner: 'Hi {{owner}}, booking {{booking_no}} ({{amenity}} · {{date}} · {{slot}}) is reserved. Please pay {{total}} at the office by {{payment_mode}} to confirm it. Fee includes {{tax_name}} {{gst}} ({{gst_rate}}); unpaid reservations are released automatically.',
      Admin: 'Payment awaited: {{booking_no}} {{amenity}} · {{date}} · {{unit}} · {{total}} ({{payment_mode}}).',
    },
    payment_received: {
      Owner: 'Payment of {{total}} received for booking {{booking_no}} ({{amenity}} · {{date}}). Thank you!',
      Admin: 'Payment received: {{booking_no}} · {{unit}} · {{total}} ({{payment_mode}}). Taxable {{taxable}}, {{tax_name}} {{gst}}.',
    },
    booking_cancelled: {
      Owner: 'Booking {{booking_no}} ({{amenity}} · {{date}} · {{slot}}) is cancelled.\nRefund {{refund}} ({{refund_pct}} of the fee + deposit {{deposit_returned}}). Retained {{retained}}.',
      Admin: 'Cancelled: {{booking_no}} · {{amenity}} · {{date}} · {{unit}}. Refund {{refund}}, retained {{retained}}. Reason: {{reason}}',
    },
    refund_processed: {
      Owner: 'Your refund of {{refund}} for booking {{booking_no}} has been processed.',
      Admin: 'Refund processed: {{booking_no}} · {{unit}} · {{refund}}.',
    },
    deposit_settled: {
      Owner: 'Security deposit for {{booking_no}}: {{deposit_returned}} returned of {{deposit}}. {{reason}}',
      Admin: 'Deposit settled: {{booking_no}} · {{unit}} · returned {{deposit_returned}} of {{deposit}}. {{reason}}',
    },
    payment_expired: {
      Owner: 'Booking {{booking_no}} ({{amenity}} · {{date}}) was released because payment was not received in time.',
      Admin: 'Auto-released unpaid booking {{booking_no}} · {{amenity}} · {{date}} · {{unit}}.',
    },
    reminder: {
      Owner: 'Reminder: {{amenity}} tomorrow ({{date}}) · {{slot}} for {{unit}}. Booking {{booking_no}}. Please read the rules before use.',
      Admin: '',
    },
    daily_report: { Admin: '{{report}}' },
    summary_report: { Admin: '{{report}}' },
  };
  for (const e of EVENTS) {
    for (const ch of CHANNELS) {
      for (const aud of ['Owner', 'Admin']) {
        const text = body[e.id]?.[aud];
        if (!text) continue;
        // SMS stays short: reports go by WhatsApp / e-mail only
        if (/report/.test(e.id) && ch === 'SMS') continue;
        rows.push({
          id: `nt_${e.id}_${ch}_${aud}`.toLowerCase(), event: e.id, channel: ch, audience: aud, enabled: ch !== 'SMS',
          subject: ch === 'Email' ? `${e.label} · {{community}}${/report/.test(e.id) ? ' · {{report_period}}' : ' · {{booking_no}}'}` : '',
          body: ch === 'SMS' ? text.split('\n').filter(Boolean).slice(0, 2).join(' ') : text,
        });
      }
    }
  }
  return rows;
}

/* ---- add-on items with a quantity (chairs, tables ...) ---- */
export const parseExtras = (v) => { try { const a = typeof v === 'string' ? JSON.parse(v || '[]') : v; return Array.isArray(a) ? a.filter((x) => x && x.itemId && Number(x.qty) > 0) : []; } catch { return []; } };
/** Items offered with an amenity: those for every amenity plus those set for this one. */
export const itemsFor = (items, amenityName) => (items || []).filter((i) => i.active !== false && (!i.amenity || i.amenity === amenityName));
const overlaps = (b, date, slot) => b.date === date && b.status !== 'Cancelled' && (slot === 'Full day' || b.slot === 'Full day' || b.slot === slot);
/** How many of an item are still free on a date and slot (stock less what other bookings already hold). */
export const itemLeft = (item, bookings, date, slot, ignoreId = '') => {
  const held = (bookings || []).filter((b) => b.id !== ignoreId && overlaps(b, date, slot)).reduce((n, b) => n + parseExtras(b.extras).filter((x) => x.itemId === item.id).reduce((m, x) => m + Number(x.qty), 0), 0);
  return Math.max(0, (Number(item.stock) || 0) - held);
};
/** Turn { itemId: qty } into booked lines priced from the catalog, or an error. Never trusts the browser's prices. */
export function priceExtras(picks, items, bookings, amenityName, date, slot) {
  const lines = []; let total = 0;
  for (const [itemId, raw] of Object.entries(picks || {})) {
    const qty = Math.floor(Number(raw) || 0); if (qty <= 0) continue;
    const it = itemsFor(items, amenityName).find((i) => i.id === itemId);
    if (!it) return { error: 'One of the add-on items is not available for this amenity' };
    const cap = Number(it.maxPerBooking) > 0 ? Number(it.maxPerBooking) : Infinity;
    if (qty > cap) return { error: `At most ${cap} ${it.name.toLowerCase()} per booking` };
    const left = itemLeft(it, bookings, date, slot);
    if (qty > left) return { error: `Only ${left} ${it.name.toLowerCase()} left for that time` };
    const line = round2(qty * (Number(it.price) || 0)); total += line;
    lines.push({ itemId, name: it.name, qty, price: Number(it.price) || 0, amount: line });
  }
  return { lines, total: round2(total) };
}
