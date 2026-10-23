import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { headOf } from '../../lib/utilityLedger.js';
import AmenityLedgerPanel from './AmenityLedgerPanel.jsx';
import { SegTabs } from '../../components/ui.jsx';
import { fmtDate, money } from '../../lib/locale.js';
import { PhoneSearch, PhoneFilters } from '../../components/ToolIcons.jsx';

const inr = (n) => money(n);
const dmy = (s) => fmtDate(s, { empty: '—' });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const HEADS = [['Utilities', '💧 Utilities'], ['Amenities', '🏊 Amenities'], ['Maintenance', '🏠 Maintenance dues']];
const PAGE = 50;

/**
 * Money coming in from residents, in one place: Utilities (water, DG and any other utility), Amenities (bookings, deposits)
 * and Maintenance dues. Every payment is its own transaction, linked to its bill or booking. Pick a year (and month) first;
 * the summary groups the period by head and by item, and the list below shows each transaction.
 */
export default function Collections({ onNavigate }) {
  const { records: ledger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: bookings } = useCollection(C.AMENITIES, 'Bookings');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [head, setHead] = useState('all');
  const [q, setQ] = useState('');
  const [n, setN] = useState(PAGE);
  const bk = useMemo(() => new Map(bookings.map((b) => [b.id, b])), [bookings]);

  const all = useMemo(() => ledger.filter((l) => !l.nonCash && !l.internal && Number(l.amount) > 0 && (l.type === 'Credit' || String(l.sourceId || '').startsWith('amenity:'))).map((l) => {
    const sid = String(l.sourceId || '');
    let h = ''; let item = '';
    if (l.category === 'Amenities' || l.module === 'Amenities' || sid.startsWith('amenity:')) { h = 'Amenities'; item = bk.get(sid.split(':')[1])?.amenity || 'Amenity bookings'; }
    else if (l.sourceType === 'due' || sid.startsWith('due:') || sid.startsWith('dues:')) { h = headOf(l.category); item = l.category; }
    return h ? { ...l, head: h, item, ref: l.billNo || l.bookingNo || l.shortId } : null;
  }).filter(Boolean), [ledger, bk]);
  const years = useMemo(() => [...new Set(all.map((l) => String(l.date).slice(0, 4)))].sort().reverse(), [all]);
  const y = year || years[0] || String(new Date().getFullYear());
  const inPeriod = useMemo(() => all.filter((l) => String(l.date).startsWith(y) && (!month || String(l.date).slice(5, 7) === month)), [all, y, month]);
  const money = (l) => (l.type === 'Credit' ? Number(l.amount) : -Number(l.amount)); // refunds net off
  const summary = useMemo(() => HEADS.map(([h, label]) => {
    const rows = inPeriod.filter((l) => l.head === h);
    const items = new Map();
    rows.forEach((l) => { const e = items.get(l.item) || { item: l.item, n: 0, sum: 0 }; e.n += l.type === 'Credit' ? 1 : 0; e.sum += money(l); items.set(l.item, e); });
    return { h, label, n: rows.filter((l) => l.type === 'Credit').length, sum: rows.reduce((t, l) => t + money(l), 0), items: [...items.values()].sort((a, b) => b.sum - a.sum) };
  }), [inPeriod]);
  const list = useMemo(() => {
    let r = inPeriod.filter((l) => head === 'all' || l.head === head);
    if (q) { const s = q.toLowerCase(); r = r.filter((l) => `${l.description} ${l.unit} ${l.ref} ${l.item} ${l.shortId}`.toLowerCase().includes(s)); }
    return r.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.shortId).localeCompare(String(a.shortId)));
  }, [inPeriod, head, q]);
  const total = summary.reduce((t, s) => t + s.sum, 0);
  return (
    <div className="card" data-testid="collections" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <h2 style={{ margin: 0, flex: 1 }}>📥 Collections</h2>
        <select aria-label="Year" data-testid="col-year" value={y} onChange={(e) => { setYear(e.target.value); setN(PAGE); }} style={{ width: 'auto' }}>{(years.length ? years : [y]).map((v) => <option key={v}>{v}</option>)}</select>
        <select aria-label="Month" data-testid="col-month" value={month} onChange={(e) => { setMonth(e.target.value); setN(PAGE); }} style={{ width: 'auto' }}><option value="">All months</option>{MON.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select>
      </div>
      <p className="muted" style={{ margin: '4px 0 10px' }}>What residents paid for utilities, amenities and maintenance dues. Each payment is its own transaction, linked to its bill or booking.</p>
      <div className="stat-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' }}>
        <div className="stat-card" style={{ cursor: 'default' }}><span className="sc-label">Total collected</span><span className="sc-value" data-testid="col-total">{inr(total)}</span><span className="muted" style={{ fontSize: 12 }}>{month ? `${MON[Number(month) - 1]} ` : ''}{y}</span></div>
        {summary.map((s) => <button key={s.h} type="button" className="stat-card" data-testid={`col-sum-${s.h}`} onClick={() => { setHead(head === s.h ? 'all' : s.h); setN(PAGE); }} style={{ textAlign: 'left', outline: head === s.h ? '2px solid var(--blue)' : undefined }}><span className="sc-label">{s.label}</span><span className="sc-value">{inr(s.sum)}</span><span className="muted" style={{ fontSize: 12 }}>{s.n} payment{s.n === 1 ? '' : 's'}</span></button>)}
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}><table className="resp-table" data-testid="col-summary">
        <thead><tr><th>Head</th><th>Item</th><th>Payments</th><th>Collected</th></tr></thead>
        <tbody>{summary.flatMap((s) => (s.items.length ? s.items.map((it, i) => <tr key={`${s.h}-${it.item}`}><td data-label="Head">{i === 0 ? <b>{s.label}</b> : ''}</td><td data-label="Item">{it.item}</td><td data-label="Payments">{it.n}</td><td data-label="Collected">{inr(it.sum)}</td></tr>) : [<tr key={s.h}><td data-label="Head"><b>{s.label}</b></td><td data-label="Item" className="muted">nothing collected in this period</td><td data-label="Payments">0</td><td data-label="Collected">{inr(0)}</td></tr>]))}</tbody></table></div>
      {(head === 'all' || head === 'Amenities') && <div style={{ marginTop: 12 }}><AmenityLedgerPanel onNavigate={onNavigate} /></div>}
      <h3 style={{ margin: '14px 0 6px' }}>Transactions</h3>
      <div className="exp-tools">
        <SegTabs label="Head" value={head} onChange={(k) => { setHead(k); setN(PAGE); }} tabs={[{ key: 'all', label: 'All', count: inPeriod.length }, ...HEADS.map(([h, l]) => ({ key: h, label: l.replace(/^\S+ /, ''), count: inPeriod.filter((x) => x.head === h).length }))]} />
        <PhoneSearch type="search" ariaLabel="Search collections" testid="col-search" placeholder="Search villa, bill / booking no., item" value={q} onChange={(v) => { setQ(v); setN(PAGE); }} className="" />
      </div>
      {list.length === 0 ? <div className="empty">No payments in this period.</div> : (
        <div className="table-wrap"><table className="resp-table" data-testid="col-table">
          <thead><tr><th>Date</th><th>Txn</th><th>Head · item</th><th>Villa</th><th>Bill / booking</th><th>Mode</th><th>Amount</th></tr></thead>
          <tbody>{list.slice(0, n).map((l) => (
            <tr key={l.id} data-testid="col-row">
              <td data-label="Date">{dmy(l.date)}</td><td data-label="Txn" className="mono">{l.shortId}</td><td data-label="Head · item">{l.head} · {l.item}</td><td data-label="Villa">{l.unit || '—'}</td>
              <td data-label="Bill / booking" className="mono">{l.ref}</td><td data-label="Mode">{l.mode || '—'}</td>
              <td data-label="Amount" style={{ color: l.type === 'Credit' ? '#15803d' : '#c7364a', fontWeight: 600 }}>{l.type === 'Credit' ? '+' : '−'}{inr(l.amount)}</td>
            </tr>))}</tbody></table></div>
      )}
      {list.length > n && <button type="button" className="btn secondary" data-testid="col-more" style={{ marginTop: 8 }} onClick={() => setN((x) => x + 100)}>Show more ({list.length - n})</button>}
    </div>
  );
}
