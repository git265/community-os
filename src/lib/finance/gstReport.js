// The community's GST report, built from the ledger: tax collected on what the society sells (amenity bookings and any other taxed
// receipt) against the tax paid on vendor bills it may claim back. Shaped like the returns it feeds (GSTR-1 outward supplies,
// GSTR-3B summary), but it is a working report for the treasurer and the CA, not a filing.
import { todayLocal } from '../locale.js';
import { carriesCredit, ITC } from './itc.js';
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const isOutward = (l) => l.type === 'Credit' && Number(l.gstAmount) > 0 && !l.reversalOf;
const month = (d) => String(d || '').slice(0, 7);
const claimable = (l) => l.itcStatus === ITC.ok;

/** Financial year (India: April-March) a date belongs to, as 2026 for 2026-27. */
export const fyOf = (d) => { const y = Number(String(d).slice(0, 4)); return Number(String(d).slice(5, 7)) >= 4 ? y : y - 1; };
export const fyLabel = (y) => `${y}-${String(y + 1).slice(2)}`;

export function buildGstReport({ ledger = [], vendors = [], fy }) {
  const inFy = (l) => l.date && fyOf(l.date) === fy;
  const outward = ledger.filter((l) => isOutward(l) && inFy(l)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const inward = ledger.filter((l) => carriesCredit(l) && inFy(l)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const gstinOf = (n) => vendors.find((v) => v.name === n)?.gstin || '';
  const months = new Map();
  const m = (k) => { if (!months.has(k)) months.set(k, { month: k, outTaxable: 0, outGst: 0, inGst: 0, inClaimable: 0, inAtRisk: 0, inUnchecked: 0 }); return months.get(k); };
  outward.forEach((l) => { const x = m(month(l.date)); x.outTaxable += Number(l.baseAmount) || Math.max(0, Number(l.amount) - Number(l.gstAmount)); x.outGst += Number(l.gstAmount); });
  inward.forEach((l) => { const x = m(month(l.date)); const g = Number(l.gstAmount); x.inGst += g; if (claimable(l)) x.inClaimable += g; else if ([ITC.missing, ITC.gstin, ITC.details].includes(l.itcStatus)) x.inAtRisk += g; else if (l.itcStatus !== ITC.na && l.itcStatus !== ITC.unreg) x.inUnchecked += g; });
  const rows = [...months.values()].sort((a, b) => a.month.localeCompare(b.month)).map((x) => ({ ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'number' ? r2(v) : v])), net: r2(x.outGst - x.inClaimable) }));
  const sum = (k) => r2(rows.reduce((n, x) => n + x[k], 0));
  const totals = { outTaxable: sum('outTaxable'), outGst: sum('outGst'), inGst: sum('inGst'), inClaimable: sum('inClaimable'), inAtRisk: sum('inAtRisk'), inUnchecked: sum('inUnchecked'), net: sum('net') };
  return {
    months: rows, totals,
    outward: outward.map((l) => { const g = Number(l.gstAmount); const t = Number(l.baseAmount) || Math.max(0, Number(l.amount) - g); return { date: l.date, ref: l.shortId, description: l.description, unit: l.unit || '', taxable: r2(t), rate: Number(l.gstRate) || (t ? r2((g / t) * 100) : 0), cgst: r2(g / 2), sgst: r2(g / 2), igst: 0, total: r2(Number(l.amount)) }; }),
    inward: inward.map((l) => ({ date: l.date, ref: l.shortId, vendor: l.vendor || '', gstin: gstinOf(l.vendor), invoiceNo: l.invoiceNo || l.billNo || '', taxable: r2(Number(l.baseAmount) || Math.max(0, Number(l.amount) - Number(l.gstAmount))), gst: r2(l.gstAmount), status: l.itcStatus || ITC.none, claimable: claimable(l) })),
  };
}
export const fyOptions = (ledger) => { const s = new Set([fyOf(todayLocal())]); ledger.forEach((l) => { if (l.date && (isOutward(l) || carriesCredit(l))) s.add(fyOf(l.date)); }); return [...s].sort((a, b) => b - a); };
