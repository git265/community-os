// Maintenance → Queue: a category's technicians (on shift, free or busy) and its maintenance tickets of the last days in the order received -
// who has each, where it stands, and the place in line of the ones waiting. Residents see other homes' tickets anonymised (no title, no villa).
import React, { useEffect, useState } from 'react';
import { getPrincipal } from '../../lib/security/principal.js';
import { ticketQueue, nudgeDue, tookText, availabilityText } from '../../lib/ticketQueue.js';
import { Segmented } from '../../components/ui.jsx';
import { fmtDateTime } from '../../lib/locale.js';

const nth = (n) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const TONE = { Open: '', Assigned: 'blue', 'In Progress': 'blue', 'On Hold': 'orange', Completed: 'green', Closed: 'green', Cancelled: '' };

/** The queue of one category, read again when tickets change and every minute while it is open. */
export function useTicketQueue(category, { days = 3, enabled = true } = {}) {
  const [q, setQ] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!enabled || !category) { setQ(null); return undefined; }
    let on = true;
    const load = () => ticketQueue(category, { days, principal: getPrincipal() }).then((x) => { if (on) { setQ(x); setErr(''); } }).catch((e) => on && setErr(e?.message || String(e)));
    load();
    const h = (e) => { if (!e.detail?.collection || e.detail.collection === 'tickets' || e.detail.collection === 'handymen') load(); };
    window.addEventListener('communityos:changed', h);
    const iv = setInterval(load, 60e3);
    return () => { on = false; window.removeEventListener('communityos:changed', h); clearInterval(iv); };
  }, [category, days, enabled]);
  return { q, err };
}

/** The technicians of a category on one line: free, on a ticket, off shift. */
export function TechStrip({ q }) {
  if (!q) return null;
  if (!q.technicians.length) return <div className="muted" data-testid="tq-techs">No technician is set up for {q.category} (Workforce → field staff).</div>;
  return (
    <div className="tq-techs" data-testid="tq-techs">
      {q.technicians.map((x) => (
        <span key={x.name} className={`tq-tech ${!x.onShift ? 'off' : x.busy ? 'busy' : 'free'}`}>
          <i aria-hidden="true" />{x.name}<small>{!x.onShift ? 'off shift' : x.busy ? `on ${x.working || 'a job'}` : 'free'}</small>
        </span>
      ))}
    </div>
  );
}

export default function TicketQueue({ categories = [], defaultCategory = '', coverage = [] }) {
  const me = getPrincipal();
  const staff = me && me.role?.category !== 'Resident';
  const [category, setCategory] = useState(defaultCategory || categories[0] || '');
  const [days, setDays] = useState(3);
  const { q, err } = useTicketQueue(category, { days });
  const limits = coverage.find((c) => String(c.category).toLowerCase() === String(category).toLowerCase()) || {};
  const rows = q?.tickets || [];
  const open = (r) => { if (r.ticketNumber && (staff || r.mine)) window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link: `#/ticket/${r.ticketNumber}` } })); };
  return (
    <div data-testid="ticket-queue">
      <div className="tq-head">
        <select aria-label="Category" data-testid="tq-category" value={category} onChange={(e) => setCategory(e.target.value)}>{categories.map((c) => <option key={c}>{c}</option>)}</select>
        <Segmented options={[{ value: 1, label: 'Today' }, { value: 3, label: '3 days' }, { value: 7, label: '7 days' }]} value={days} onChange={setDays} label="How far back" />
      </div>
      {err && <div className="notice error">{err}</div>}
      <TechStrip q={q} />
      <div className="muted tq-sum" data-testid="tq-summary">
        {q ? `${q.waiting ? `${q.waiting} waiting for a technician` : 'Nobody waiting'} · ${rows.length} ticket${rows.length === 1 ? '' : 's'} in the order received` : 'Loading…'}
        {!staff && q ? ' · other homes are shown without their details' : ''}
      </div>
      {q && !rows.length && <div className="empty">No {category} tickets in this period.</div>}
      <div className="tq-list">
        {rows.map((r, i) => {
          const due = staff ? nudgeDue(r, limits) : null;
          return (
            <button type="button" key={r.ticketNumber || i} className={`tq-row${r.mine ? ' mine' : ''}`} data-testid="tq-row" onClick={() => open(r)} disabled={!(staff || r.mine)}>
              <span className="tq-main">
                <span><span className="mono">{r.ticketNumber}</span>{r.mine && <span className="tag blue" style={{ marginLeft: 6 }}>Yours</span>}{r.priority === 'Critical' || r.priority === 'High' ? <span className="tag red" style={{ marginLeft: 6 }}>{r.priority}</span> : null}</span>
                <b>{r.title || 'Another home'}</b>
                <small className="muted">{[r.unitNo, `received ${fmtDateTime(r.receivedAt)}`, r.completedAt ? `done ${fmtDateTime(r.completedAt)}` : ''].filter(Boolean).join(' · ')}</small>
              </span>
              <span className="tq-side">
                <span className={`tag ${TONE[r.status] || ''}`}>{r.place ? `${nth(r.place)} in line` : r.status}</span>
                <small>{r.technician || (r.place ? 'waiting' : '—')}</small>
                {due && <span className="tag red" data-testid="tq-late">{due.kind === 'start' ? 'not started' : 'in progress'} {tookText(due.minutes)}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** In the raise form: what a request in this category will meet now - the free technician, or its place in the queue. */
export function QueueAvailability({ category }) {
  const { q } = useTicketQueue(category);
  const a = availabilityText(q, category);
  if (!a) return null;
  return <div className={`tq-avail ${a.tone}`} data-testid="tq-avail">{a.tone === 'ok' ? '✅' : '⏳'} {a.text}</div>;
}

/** On an open ticket waiting in the queue: its place in line and who is on shift. */
export function QueuePlace({ ticket }) {
  const { q } = useTicketQueue(ticket?.category, { enabled: !!ticket && ticket.status === 'Open' && !ticket.assignedTo });
  const row = q?.tickets.find((r) => r.ticketNumber === ticket?.ticketNumber);
  if (!q || !row?.place) return null;
  const on = q.technicians.filter((x) => x.onShift);
  return (
    <div className="tq-place" data-testid="tq-place">
      <b>⏳ {nth(row.place)} in the {q.category} queue.</b>{' '}
      {on.length ? `${on.length === 1 ? 'The technician on shift is' : `All ${on.length} technicians on shift are`} on other jobs; the next one free takes it.` : 'No technician is on shift now; the next one to clock in takes it.'}
      <TechStrip q={q} />
    </div>
  );
}
