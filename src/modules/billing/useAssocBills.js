import { useMemo } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { fmtDate, money, todayLocal } from '../../lib/locale.js';

export const inr = (n) => money(n);
export const dmy = (s) => fmtDate(s, { empty: '—' });
export const todayIso = () => todayLocal();
export const UTIL_ICON = { Electricity: '⚡', Water: '💧', 'DG diesel': '🛢', Gas: '🔥', 'Internet / telecom': '🌐', 'Waste / sanitation': '♻', Other: '🧾' };

/** Every bill the association pays itself (electricity, water, DG diesel, gas, internet …) with its payment state taken from the ledger. */
export function useAssocBills() {
  const { records: fuel } = useCollection(C.DG_FUEL_LOGS, 'DG Fuel Log');
  const { records: elec } = useCollection(C.ELECTRICITY_BILLS, 'Electricity Bills');
  const { records: assoc, refresh } = useCollection(C.ASSOC_BILLS, 'Association Utility Bills');
  const { records: ledger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: skips, save: saveSkip, remove: removeSkip } = useCollection(C.LEDGER_SKIPS, 'Not Recorded Payments');
  const bills = useMemo(() => [
    ...fuel.map((f) => ({ key: `dgfuel:${f.id}`, id: f.id, src: 'dgfuel', shortId: f.shortId, utility: 'DG diesel', location: 'DG room', title: `DG diesel · ${f.litres} L`, sub: `${f.supplier || 'Supplier not noted'} · ${dmy(f.date)}`, amount: Number(f.amount) || Math.round((Number(f.litres) || 0) * (Number(f.rate) || 0)), vendor: f.supplier || '', date: f.date, due: '' })),
    ...elec.map((b) => ({ key: `elec:${b.id}`, id: b.id, src: 'elec', shortId: b.shortId, utility: 'Electricity', location: b.service || 'Common area', title: `Electricity · ${b.service || 'Supply'} · ${b.period || ''}`, sub: `${b.serviceNo || ''}${b.units ? ` · ${Number(b.units).toLocaleString('en-IN')} kWh` : ''} · bill ${dmy(b.billDate)}`, amount: Number(b.amount) || Number(b.totalAmount) || 0, vendor: 'Electricity board', date: b.billDate || b.period || '', due: b.dueDate, markedPaid: b.status === 'Paid', paidOn: b.paidOn, period: b.period })),
    ...assoc.map((b) => ({ key: `assoc:${b.id}`, id: b.id, src: 'assoc', rec: b, shortId: b.shortId, utility: b.utility, location: b.location, title: `${b.utility} · ${b.provider || ''} · ${b.period || ''}`, sub: `${b.location}${b.accountNo ? ` · ${b.accountNo}` : ''}${b.quantity ? ` · ${b.quantity} used` : ''} · bill ${dmy(b.billDate)}`, amount: Number(b.amount) || 0, vendor: b.provider || '', date: b.billDate || b.period || '', due: b.dueDate, markedPaid: !!b.paidOn, paidOn: b.paidOn, period: b.period })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))), [fuel, elec, assoc]);
  const paidBy = (k) => ledger.filter((l) => l.sourceId === k && l.type === 'Debit');
  const skipOf = (k) => skips.find((s) => s.sourceId === k);
  const isPaid = (b) => paidBy(b.key).length > 0 || !!b.markedPaid;
  const overdue = (b) => !!b.due && b.due < todayIso() && !isPaid(b);
  return { bills, paidBy, skipOf, isPaid, overdue, saveSkip, removeSkip, refresh };
}
