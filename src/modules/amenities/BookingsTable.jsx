import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SegTabs } from '../../components/ui.jsx';
import { inr } from '../../lib/amenityEngine.js';
import { BOOKING_PAY_TONE as TONE } from '../../components/StatusTag.jsx';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const PAGE = 40;
export const isFinancial = (b) => Number(b.totalPayable) > 0 || (b.paymentStatus && !['Not required', undefined, ''].includes(b.paymentStatus) && b.paymentStatus !== 'Cancelled' && Number(b.totalPayable) > 0);

/**
 * All bookings as a table, split into Free and Financial, filtered by year and month (dropdowns, so ten years of
 * bookings stay easy to reach), searchable by amenity / villa / booking no., sortable by any column, and paged.
 */
export default function BookingsTable({ bookings, isResident, onOpen, title }) {
  const nowY = String(new Date().getFullYear());
  const years = useMemo(() => [...new Set(bookings.map((b) => String(b.date || '').slice(0, 4)).filter(Boolean))].sort().reverse(), [bookings]);
  const [year, setYear] = useState(() => '');
  const [month, setMonth] = useState('');
  const [kind, setKind] = useState('all');
  const [amenity, setAmenity] = useState('');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
  const [page, setPage] = useState(1);
  const y = year || (years.includes(nowY) ? nowY : years[0] || '');
  const inYear = bookings.filter((b) => !y || String(b.date || '').startsWith(y));
  const base = inYear.filter((b) => (!month || String(b.date || '').slice(5, 7) === month) && (!amenity || b.amenity === amenity));
  const fin = base.filter(isFinancial);
  const free = base.filter((b) => !isFinancial(b));
  const amenities = [...new Set(bookings.map((b) => b.amenity))].sort();
  const rows = useMemo(() => {
    let list = kind === 'free' ? free : kind === 'all' ? base : fin;
    if (q) { const s = q.toLowerCase(); list = list.filter((b) => `${b.amenity} ${b.unit} ${b.date} ${b.status} ${b.shortId} ${b.paymentStatus}`.toLowerCase().includes(s)); }
    const get = (b) => (sort.key === 'totalPayable' ? Number(b.totalPayable) || 0 : String(b[sort.key] ?? '').toLowerCase());
    return [...list].sort((a, b) => { const x = get(a); const z = get(b); return (x < z ? -1 : x > z ? 1 : 0) * (sort.dir === 'asc' ? 1 : -1) || String(b.recordCreatedAt || '').localeCompare(String(a.recordCreatedAt || '')); });
  }, [base, fin, free, kind, q, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const shown = rows.slice(0, Math.min(page, pages) * PAGE);
  const moreRef = useRef(null);
  useEffect(() => { setPage(1); }, [y, month, kind, amenity, q, sort]);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || typeof IntersectionObserver === 'undefined' || page >= pages) return undefined;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setPage((n) => n + 1); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [page, pages, shown.length]);
  const th = (key, label) => <th key={key} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'asc' ? 'desc' : 'asc' }))} data-testid={`bk-sort-${key}`} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>{label}{sort.key === key && <span className="arr"> {sort.dir === 'asc' ? '▲' : '▼'}</span>}</th>;
  const total = fin.filter((b) => b.status !== 'Cancelled').reduce((n, b) => n + (Number(b.totalPayable) || 0), 0);
  return (
    <div className="card" style={{ marginTop: 20 }} data-testid="bookings-card">
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <SegTabs label="Booking type" value={kind} onChange={setKind} tabs={[{ key: 'financial', label: 'Financial', count: fin.length }, { key: 'free', label: 'Free', count: free.length }, { key: 'all', label: 'All', count: base.length }]} />
      <div className="exp-tools" style={{ marginTop: 10 }}>
        <input type="search" aria-label="Search bookings" data-testid="bk-search" placeholder="Search amenity, villa or booking no." value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Year" data-testid="bk-year" value={y} onChange={(e) => setYear(e.target.value)} style={{ width: 'auto' }}>{years.length ? years.map((v) => <option key={v}>{v}</option>) : <option>{nowY}</option>}</select>
        <select aria-label="Month" data-testid="bk-month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }}><option value="">All months</option>{MON.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select>
        <select aria-label="Amenity" data-testid="bk-amenity" value={amenity} onChange={(e) => setAmenity(e.target.value)} style={{ width: 'auto' }}><option value="">All amenities</option>{amenities.map((a) => <option key={a}>{a}</option>)}</select>
      </div>
      {kind !== 'free' && <div className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>{rows.length} booking{rows.length === 1 ? '' : 's'}{kind === 'financial' ? ` · ${inr(total)} payable (excluding cancelled)` : ''}</div>}
      {shown.length === 0 ? <div className="empty">No bookings match.</div> : (
        <div className="table-wrap"><table className="resp-table sortable" data-testid="bookings-table">
          <thead><tr>{th('shortId', 'Booking')}{th('amenity', 'Amenity')}{th('date', 'Date')}<th>Slot</th>{!isResident && th('unit', 'Villa')}{th('status', 'Status')}{kind !== 'free' && th('totalPayable', 'Amount')}{kind !== 'free' && th('paymentStatus', 'Payment')}</tr></thead>
          <tbody>{shown.map((b) => (
            <tr key={b.id} className="clickable" data-testid="booking-row" onClick={() => onOpen(b.id)}>
              <td data-label="Booking" className="mono">{b.shortId}</td><td data-label="Amenity"><b>{b.amenity}</b></td><td data-label="Date">{b.date}</td><td data-label="Slot">{b.slot}</td>
              {!isResident && <td data-label="Villa">{b.unit}</td>}
              <td data-label="Status"><span className={`tag ${b.status === 'Cancelled' ? '' : b.status === 'Confirmed' || b.status === 'Completed' ? 'green' : 'orange'}`}>{b.status}</span></td>
              {kind !== 'free' && <td data-label="Amount">{Number(b.totalPayable) > 0 ? inr(b.totalPayable) : '—'}</td>}
              {kind !== 'free' && <td data-label="Payment">{b.paymentStatus && b.paymentStatus !== 'Not required' ? <span className={`tag ${TONE[b.paymentStatus] || ''}`}>{b.paymentStatus}</span> : '—'}</td>}
            </tr>))}</tbody>
        </table></div>
      )}
      <div ref={moreRef} className="stable-sentinel">{page < pages ? <span className="muted">Loading…</span> : null}</div>
    </div>
  );
}
