// The reports a community can schedule. Each one is a small function over the community's own data that returns
//   { title, lines: [summary lines], columns: [...], rows: [[...]] , empty }
// so any new report is one more entry here. `perUnit` reports can also be personalised: sent to a villa they show only that villa's rows.
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { effectiveCondition, faultyOf, openTicketsByAsset, units as unitsOf } from '../../modules/infra/infraModel.js';
import { fmtDate, localDay } from '../locale.js';

export const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return iso(d); };
export const dmy = (s) => fmtDate(s);
export const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const monthStart = (s) => `${s.slice(0, 7)}-01`;

export const PERIODS = {
  today: { label: 'Today', range: (t) => ({ from: t, to: t }) },
  tomorrow: { label: 'Tomorrow', range: (t) => ({ from: addDays(t, 1), to: addDays(t, 1) }) },
  today_tomorrow: { label: 'Today and tomorrow', range: (t) => ({ from: t, to: addDays(t, 1) }) },
  yesterday: { label: 'Yesterday', range: (t) => ({ from: addDays(t, -1), to: addDays(t, -1) }) },
  next7: { label: 'Next 7 days', range: (t) => ({ from: t, to: addDays(t, 7) }) },
  next14: { label: 'Next 14 days', range: (t) => ({ from: t, to: addDays(t, 14) }) },
  last7: { label: 'Last 7 days', range: (t) => ({ from: addDays(t, -6), to: t }) },
  last30: { label: 'Last 30 days', range: (t) => ({ from: addDays(t, -29), to: t }) },
  mtd: { label: 'This month so far', range: (t) => ({ from: monthStart(t), to: t }) },
  prevMonth: { label: 'Last month', range: (t) => { const f = monthStart(addDays(monthStart(t), -1)); return { from: f, to: addDays(monthStart(t), -1) }; } },
  asof: { label: 'As of now', range: (t) => ({ from: t, to: t }) },
};

const between = (d, r) => !!d && localDay(d) >= r.from && localDay(d) <= r.to;   // a moment counts on the day it falls on here
const closed = (t) => ['Completed', 'Closed', 'Cancelled'].includes(t.status);
const bullet = (a) => a.filter((x) => x !== '' && x != null).join(' · ');

export const REPORTS = [
  {
    id: 'bookings', label: 'Amenity bookings', group: 'Amenities', perUnit: true, taxAware: true, needs: [C.AMENITIES],
    blurb: 'Who has booked which amenity, and when. The daily version is the "what is happening today and tomorrow" sheet.',
    periods: ['today_tomorrow', 'today', 'tomorrow', 'yesterday', 'next7', 'last7', 'mtd'], defaultPeriod: 'today_tomorrow',
    build({ data, range, unit }) {
      const all = data[C.AMENITIES].filter((b) => !unit || b.unit === unit);
      const live = all.filter((b) => b.status !== 'Cancelled' && between(b.date, range)).sort((a, b) => `${a.date} ${a.slot}`.localeCompare(`${b.date} ${b.slot}`));
      const cancelled = all.filter((b) => b.status === 'Cancelled' && between(b.date, range)).length;
      const pending = live.filter((b) => b.paymentStatus === 'Pending').length;
      const lines = [`${live.length} booking${live.length === 1 ? '' : 's'}${cancelled ? ` · ${cancelled} cancelled` : ''}${pending ? ` · ${pending} payment pending` : ''}`];
      const byAm = new Map(); live.forEach((b) => byAm.set(b.amenity, (byAm.get(b.amenity) || 0) + 1));
      if (!unit && byAm.size) lines.push(`By amenity: ${[...byAm.entries()].map(([k, v]) => `${k} ${v}`).join(', ')}`);
      return { title: unit ? `Your bookings · ${unit}` : 'Amenity bookings', lines, columns: ['Date', 'Time', 'Amenity', 'Unit', 'Payment', 'Taxable (₹)', 'GST (₹)', 'Fee (₹)'], taxCols: ['Taxable (₹)', 'GST (₹)'], moneyCols: ['Taxable (₹)', 'GST (₹)', 'Fee (₹)'], rows: live.map((b) => [dmy(b.date), b.slot || '', b.amenity, b.unit, b.paymentStatus || '', Number(b.baseAmount) || 0, Number(b.gstAmount) || 0, Number(b.feeTotal) || 0]), empty: !live.length };
    },
  },
  {
    id: 'dues', label: 'Dues outstanding', group: 'Billing', perUnit: true, taxAware: true, needs: [C.DUES],
    blurb: 'Unpaid maintenance, water, DG and other dues. To a villa it lists that villa\'s own unpaid bills.',
    periods: ['asof'], defaultPeriod: 'asof',
    build({ data, today, unit }) {
      const unpaid = data[C.DUES].filter((d) => !['Paid', 'Cancelled'].includes(d.status) && Number(d.amount) > 0 && (!unit || d.unit === unit));
      const late = (d) => d.dueDate && d.dueDate < today;
      const total = unpaid.reduce((s, d) => s + Number(d.amount), 0); const lateAmt = unpaid.filter(late).reduce((s, d) => s + Number(d.amount), 0);
      const lines = [`Outstanding ${inr(total)} in ${unpaid.length} bill${unpaid.length === 1 ? '' : 's'}${unit ? '' : ` from ${new Set(unpaid.map((d) => d.unit)).size} units`} · overdue ${inr(lateAmt)}`];
      if (!unit) {
        const cat = new Map(); unpaid.forEach((d) => cat.set(d.category, (cat.get(d.category) || 0) + Number(d.amount)));
        lines.push(`By kind: ${[...cat.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${inr(v)}`).join(', ')}`);
      }
      const rows = unpaid.sort((a, b) => (late(b) - late(a)) || Number(b.amount) - Number(a.amount)).slice(0, 500).map((d) => [d.unit, d.category, d.billedMonth || '', Number(d.amount), Number(d.tax) || 0, dmy(d.dueDate), late(d) ? 'Overdue' : 'Unpaid']);
      return { title: unit ? `Your dues · ${unit}` : 'Dues outstanding', lines, columns: ['Unit', 'Kind', 'Month', 'Amount (₹)', 'Tax (₹)', 'Payable by', 'Status'], taxCols: ['Tax (₹)'], moneyCols: ['Amount (₹)', 'Tax (₹)'], rows, empty: !unpaid.length };
    },
  },
  {
    id: 'collections', label: 'Payments received', group: 'Billing', perUnit: false, needs: [C.DUES],
    blurb: 'Money collected in the period, by kind of due and by how it was paid.',
    periods: ['yesterday', 'last7', 'mtd', 'prevMonth', 'last30'], defaultPeriod: 'yesterday',
    build({ data, range }) {
      const paid = data[C.DUES].filter((d) => d.status === 'Paid' && between(d.paidAt, range));
      const total = paid.reduce((s, d) => s + Number(d.amount || 0), 0);
      const by = (k) => { const m = new Map(); paid.forEach((d) => m.set(d[k] || '—', (m.get(d[k] || '—') || 0) + Number(d.amount || 0))); return [...m.entries()].sort((a, b) => b[1] - a[1]); };
      const lines = [`Received ${inr(total)} from ${paid.length} payment${paid.length === 1 ? '' : 's'}`, `By kind: ${by('category').map(([k, v]) => `${k} ${inr(v)}`).join(', ') || '—'}`, `By mode: ${by('paymentMode').map(([k, v]) => `${k} ${inr(v)}`).join(', ') || '—'}`];
      return { title: 'Payments received', lines, columns: ['Paid on', 'Unit', 'Kind', 'Month', 'Amount (₹)', 'Mode'], moneyCols: ['Amount (₹)'], rows: paid.sort((a, b) => String(a.paidAt).localeCompare(String(b.paidAt))).slice(0, 500).map((d) => [dmy(d.paidAt), d.unit, d.category, d.billedMonth || '', Number(d.amount), d.paymentMode || '']), empty: !paid.length };
    },
  },
  {
    id: 'water', label: 'Water & plant log', group: 'Utilities', perUnit: false, needs: [C.PLANT_LOGS],
    blurb: 'Water received, treated and recycled each day, with salt and chlorine used (from the plant log).',
    periods: ['last7', 'yesterday', 'mtd', 'prevMonth', 'last30'], defaultPeriod: 'last7',
    build({ data, range }) {
      const logs = data[C.PLANT_LOGS].filter((l) => between(l.date, range)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const sum = (k) => logs.reduce((s, l) => s + (Number(l[k]) || 0), 0); const n = logs.length || 1;
      const lines = [`${logs.length} day${logs.length === 1 ? '' : 's'} logged`, `Bhagiratha ${Math.round(sum('bhKl'))} KL (avg ${Math.round(sum('bhKl') / n)}/day) · WTP ${Math.round(sum('wtpKl'))} KL · STP ${Math.round(sum('stpKl'))} KL`, `Salt used ${Math.round(sum('saltUsed'))} kg · Chlorine used ${Math.round(sum('chlorineUsed') * 10) / 10} L`];
      return { title: 'Water & plant log', lines, columns: ['Date', 'Bhagiratha (KL)', 'WTP (KL)', 'STP (KL)', 'Salt (kg)', 'Chlorine (L)', 'Remarks'], rows: logs.map((l) => [dmy(l.date), l.bhKl ?? '', l.wtpKl ?? '', l.stpKl ?? '', l.saltUsed ?? '', l.chlorineUsed ?? '', l.remarks || '']), empty: !logs.length };
    },
  },
  {
    id: 'tasks', label: 'Maintenance tasks', group: 'Maintenance', perUnit: false, needs: [C.TICKETS],
    blurb: 'Open and overdue tasks, and what was raised or closed in the period.',
    periods: ['yesterday', 'last7', 'mtd', 'last30'], defaultPeriod: 'last7',
    build({ data, range, today }) {
      const all = data[C.TICKETS]; const open = all.filter((t) => !closed(t));
      const late = open.filter((t) => t.slaDueAt && String(t.slaDueAt).slice(0, 10) < today);
      const raised = all.filter((t) => between(t.recordCreatedAt, range)).length; const done = all.filter((t) => closed(t) && between(t.lastUpdatedAt, range)).length;
      const lines = [`${open.length} open · ${late.length} past their due date · ${raised} raised and ${done} closed in the period`];
      const by = new Map(); open.forEach((t) => by.set(t.category || 'Other', (by.get(t.category || 'Other') || 0) + 1));
      lines.push(`Open by category: ${[...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`);
      const rows = [...late, ...open.filter((t) => !late.includes(t))].slice(0, 300).map((t) => [t.ticketNumber || '', t.title, t.category || '', t.priority || '', t.status, t.assignedTo || 'Unassigned', t.slaDueAt ? dmy(t.slaDueAt) : '', late.includes(t) ? 'Late' : '']);
      return { title: 'Maintenance tasks', lines, columns: ['Task', 'Title', 'Category', 'Priority', 'Status', 'Assigned to', 'Due', ''], rows, empty: !open.length && !raised && !done };
    },
  },
  {
    id: 'audits', label: 'Audits due', group: 'Audits', perUnit: false, needs: [C.AUDITS],
    blurb: 'Each audited area: last result and whether the next audit is overdue or coming up.',
    periods: ['asof'], defaultPeriod: 'asof',
    build({ data, today }) {
      const latest = new Map(); data[C.AUDITS].forEach((a) => { const o = latest.get(a.area); if (!o || String(a.auditDate) > String(o.auditDate)) latest.set(a.area, a); });
      const rows = [...latest.values()].map((a) => { const d = a.nextDue ? Math.round((new Date(`${a.nextDue}T00:00:00`) - new Date(`${today}T00:00:00`)) / 86400000) : null; return { a, d, state: d == null ? 'No next date' : d < 0 ? `Overdue by ${-d} day${d === -1 ? '' : 's'}` : d <= 30 ? `Due in ${d} day${d === 1 ? '' : 's'}` : 'OK' }; })
        .sort((x, y) => (x.d ?? 9999) - (y.d ?? 9999));
      const od = rows.filter((r) => r.d != null && r.d < 0).length; const soon = rows.filter((r) => r.d != null && r.d >= 0 && r.d <= 30).length; const fail = rows.filter((r) => r.a.result === 'Fail').length;
      return { title: 'Audits due', lines: [`${rows.length} areas audited · ${od} overdue · ${soon} due in 30 days · ${fail} last audit failed`], columns: ['Area', 'Last audit', 'Result', 'Score', 'Next due', 'State'], rows: rows.map(({ a, state }) => [a.area, dmy(a.auditDate), a.result, a.score ?? '', dmy(a.nextDue), state]), empty: !rows.length };
    },
  },
  {
    id: 'infra', label: 'Infrastructure health', group: 'Infrastructure', perUnit: false, needs: [C.EQUIPMENT, C.TICKETS],
    blurb: 'Lights, feeders, cameras, pipelines and plant that are not working or need attention.',
    periods: ['asof'], defaultPeriod: 'asof',
    build({ data }) {
      const open = openTicketsByAsset(data[C.TICKETS]); const openIds = new Set(open.keys());
      const rows = data[C.EQUIPMENT].map((a) => ({ a, c: effectiveCondition(a, openIds) })).filter((x) => ['Needs attention', 'Under repair', 'Out of service'].includes(x.c));
      const cnt = (c) => rows.filter((x) => x.c === c).length;
      return { title: 'Infrastructure health', lines: [`${rows.length} asset${rows.length === 1 ? '' : 's'} need action: ${cnt('Out of service')} out of service · ${cnt('Under repair')} under repair · ${cnt('Needs attention')} need attention`], columns: ['Asset', 'Kind', 'Area', 'Condition', 'Faulty', 'Open task'], rows: rows.sort((x, y) => (x.c === 'Out of service' ? 0 : 1) - (y.c === 'Out of service' ? 0 : 1)).map(({ a, c }) => [a.name, a.type, a.area || '', c, unitsOf(a) > 1 ? `${faultyOf(a)} of ${unitsOf(a)}` : '', (open.get(a.id) || [])[0]?.ticketNumber || '']), empty: !rows.length };
    },
  },
  {
    id: 'eventwork', label: 'Event work', group: 'Events', perUnit: false, needs: [C.EVENT_WORK],
    blurb: 'Work for upcoming events that is not done yet, who owns it and how many people are needed when.',
    periods: ['next7', 'next14', 'today_tomorrow'], defaultPeriod: 'next7',
    build({ data, range, today }) {
      const pending = data[C.EVENT_WORK].filter((w) => !['Done', 'Cancelled'].includes(w.status));
      const late = pending.filter((w) => w.neededOn < today); const soon = pending.filter((w) => between(w.neededOn, range));
      const list = [...late, ...soon].sort((a, b) => String(a.neededOn).localeCompare(String(b.neededOn)));
      const need = soon.reduce((s, w) => s + (Number(w.staffRequested) || 0), 0); const got = soon.reduce((s, w) => s + (Number(w.staffConfirmed) || 0), 0);
      const own = (r) => soon.filter((w) => w.ownerRole === r).length + late.filter((w) => w.ownerRole === r).length;
      return { title: 'Event work', lines: [`${list.length} item${list.length === 1 ? '' : 's'} to do: ${late.length} late · Facility Manager ${own('Facility Manager')} · MEP ${own('MEP')}`, `People needed ${need} · confirmed ${got}${need > got ? ` · ${need - got} still to arrange` : ''}`],
        columns: ['Needed on', 'Event', 'Work', 'When', 'People', 'Kind', 'Owner', 'Status'], rows: list.map((w) => [dmy(w.neededOn), w.eventName, w.title, w.phase, `${w.staffConfirmed || 0}/${w.staffRequested || 0}`, w.staffType || '', w.ownerRole, w.status]), empty: !list.length };
    },
  },
];
export const reportOf = (id) => REPORTS.find((r) => r.id === id);

// ---- Custom reports: built on screen from any allowed list, no code. The recipe is stored on the schedule. ----
export const CUSTOM_SOURCES = [C.ATTENDANCE, C.SHIFTS, C.TICKETS, C.DUES, C.AMENITIES, C.GATE_VISITS, C.INCIDENTS, C.PLANT_LOGS, C.DG_FUEL_LOGS, C.EQUIPMENT, C.AUDITS, C.VENDORS, C.EVENT_WORK, C.WORKFORCE];
export const FILTER_OPS = ['is', 'is not', 'contains', 'empty', 'not empty', 'more than', 'less than'];
const matches = (r, f) => {
  const v = r[f.field]; const t = String(f.value ?? '').toLowerCase(); const sv = v == null ? '' : (Array.isArray(v) ? v.join(', ') : String(v)); const l = sv.toLowerCase();
  switch (f.op) { case 'is': return l === t; case 'is not': return l !== t; case 'contains': return l.includes(t); case 'empty': return l === ''; case 'not empty': return l !== ''; case 'more than': return Number(v) > Number(f.value); case 'less than': return Number(v) < Number(f.value); default: return true; }
};
const parseSpec = (c) => { if (!c) return {}; if (typeof c === 'object') return c; try { return JSON.parse(c); } catch { return {}; } };
export function customDef(specIn) {
  const sp = parseSpec(specIn); const lab = (k) => sp.labels?.[k] || k;
  return {
    id: 'custom', label: 'Custom report', group: 'Custom', perUnit: false, custom: true, needs: sp.source ? [sp.source] : [], periods: Object.keys(PERIODS), defaultPeriod: 'asof',
    blurb: 'Build your own: pick a list, the columns, filters, sorting and optional grouping.',
    build({ data, range, today }) {
      let rows = (data[sp.source] || []);
      if (sp.dateField && range.id !== 'asof') rows = rows.filter((r) => between(r[sp.dateField], range));
      rows = rows.filter((r) => (sp.filters || []).every((f) => !f.field || matches(r, { ...f, value: f.value === '@today' ? today : f.value })));
      const cell = (r, k) => { const v = r[k]; if (v == null) return ''; if (Array.isArray(v)) return v.join(', '); return (sp.dates || []).includes(k) && v ? dmy(v) : (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v); };
      const cmp = (a, b) => { const x = a[sp.sortBy] ?? ''; const y = b[sp.sortBy] ?? ''; const n = Number(x) - Number(y); const o = Number.isFinite(n) && x !== '' && y !== '' ? n : String(x).localeCompare(String(y), undefined, { numeric: true }); return sp.sortDir === 'desc' ? -o : o; };
      if (sp.sortBy) rows = [...rows].sort(cmp);
      if (sp.groupBy) {
        const g = new Map(); rows.forEach((r) => { const k = cell(r, sp.groupBy) || '—'; (g.get(k) || g.set(k, []).get(k)).push(r); });
        const m = sp.measure && sp.measure !== 'count' && sp.measureField ? sp.measure : '';
        const mname = m ? `${m === 'avg' ? 'Average' : 'Total'} ${lab(sp.measureField)}` : '';
        const out = [...g.entries()].map(([k, list]) => { const nums = m ? list.map((r) => Number(r[sp.measureField]) || 0) : []; const tot = nums.reduce((a, b) => a + b, 0); return [k, list.length, ...(m ? [Math.round((m === 'avg' ? tot / (nums.length || 1) : tot) * 100) / 100] : [])]; }).sort((a, b) => b[1] - a[1]);
        const columns = [lab(sp.groupBy), 'Count', ...(m ? [mname] : [])];
        return { title: sp.title || 'Custom report', lines: [`${rows.length} record${rows.length === 1 ? '' : 's'} in ${out.length} group${out.length === 1 ? '' : 's'} (by ${lab(sp.groupBy)})`], columns, moneyCols: columns.slice(1), rows: out, empty: !rows.length };
      }
      const keys = (sp.columns || []).length ? sp.columns : Object.keys(rows[0] || {}).slice(0, 6);
      const shown = rows.slice(0, Number(sp.limit) || 500);
      return { title: sp.title || 'Custom report', lines: [`${rows.length} record${rows.length === 1 ? '' : 's'}${rows.length > shown.length ? ` (first ${shown.length} listed)` : ''}`], columns: keys.map(lab), moneyCols: keys.filter((k) => (sp.numeric || []).includes(k)).map(lab), rows: shown.map((r) => keys.map((k) => cell(r, k))), empty: !rows.length };
    },
  };
}
/** The definition a schedule uses (a built-in report, or its own custom recipe). */
export const defOf = (s) => (s?.reportType === 'custom' ? customDef(s.custom) : reportOf(s?.reportType));

export const FORMATS = [
  { id: 'Summary', help: 'A few lines of key numbers' },
  { id: 'Detailed', help: 'Key numbers and the table (first 25 lines in a message)' },
  { id: 'Excel', help: 'Key numbers; the full table as an Excel file in Reports → Sent' },
  { id: 'CSV', help: 'Key numbers; the full table as a CSV file in Reports → Sent' },
];
export const CHANNEL_CHOICES = ['In-app', 'Email', 'WhatsApp', 'SMS'];

/** Read what a report needs straight from storage (it runs for the community, not for one person's view). */
export async function loadData(needs) {
  const out = {};
  await Promise.all(needs.map(async (c) => { out[c] = await storage.list(c); }));
  return out;
}

export function rangeFor(def, periodId, today) {
  const p = PERIODS[periodId] ? periodId : def.defaultPeriod;
  return { id: p, label: PERIODS[p].label, ...PERIODS[p].range(today) };
}

/** Build one report (optionally for one unit). `data` can be reused across many units. */
export function buildReport(def, { data, periodId, today = iso(new Date()), unit = '', opts = {} }) {
  const range = rangeFor(def, periodId, today);
  let r = def.build({ data, range, today, unit });
  r = shape(r, def, opts);
  return { ...r, report: def.id, periodLabel: def.periods.length > 1 || range.id !== 'asof' ? range.label : '', range, today, intro: opts.intro || '', footer: opts.footer || '' };
}

/** What a schedule chose to show: which columns, tax columns, a totals row, a summary. */
export const optsOf = (s = {}) => ({ columns: s.showCols || [], tax: s.showTax !== false, totals: !!s.showTotals, summary: s.showSummary !== false, intro: s.intro || '', footer: s.footer || '' });
function shape(r, def, o) {
  const cols = r.columns; let keep = cols.map((c) => (def.taxAware && o.tax === false && (r.taxCols || []).includes(c) ? false : (!o.columns?.length || o.columns.includes(c))));
  if (!keep.some(Boolean)) keep = cols.map(() => true);
  const idx = cols.map((_, i) => i).filter((i) => keep[i]);
  let rows = r.rows.map((row) => idx.map((i) => row[i]));
  const columns = idx.map((i) => cols[i]);
  const lines = o.summary === false ? [] : r.lines;
  if (o.totals && rows.length && (r.moneyCols || []).some((c) => columns.includes(c))) {
    const tot = columns.map((c, j) => (j === 0 ? 'Total' : (r.moneyCols || []).includes(c) ? Math.round(rows.reduce((s, x) => s + (Number(x[j]) || 0), 0) * 100) / 100 : ''));
    rows = [...rows, tot];
  }
  return { ...r, columns, rows, lines };
}
/** Every column a report can show (for the "what to show" picker). */
export function columnsOf(def) { const data = {}; def.needs.forEach((c) => { data[c] = []; }); try { const r = def.build({ data, range: { from: '', to: '' }, today: iso(new Date()), unit: '' }); return { columns: r.columns, taxCols: r.taxCols || [], money: (r.moneyCols || []).length > 0 }; } catch { return { columns: [], taxCols: [], money: false }; } }

/** The text of a report as sent in a message. */
export function textOf(rep, format, community = '') {
  const head = `*${community ? `${community} · ` : ''}${rep.title}*${rep.periodLabel ? ` · ${rep.periodLabel}` : ''} · ${dmy(rep.today)}`;
  const out = [head, ...(rep.intro ? ['', rep.intro] : []), '', ...rep.lines];
  if (format === 'Detailed' && rep.rows.length) {
    out.push('', ...rep.rows.slice(0, 25).map((r) => `• ${bullet(r.map((x) => (typeof x === 'number' ? x.toLocaleString('en-IN') : x)))}`));
    if (rep.rows.length > 25) out.push(`…and ${rep.rows.length - 25} more (see Reports → Sent)`);
  } else if ((format === 'Excel' || format === 'CSV') && rep.rows.length) out.push('', `Full table (${rep.rows.length} lines) is in Reports → Sent as ${format === 'Excel' ? 'an Excel file' : 'a CSV file'}.`);
  if (rep.empty) out.push('', 'Nothing to report.');
  if (rep.footer) out.push('', rep.footer);
  return out.join('\n');
}
