import { todayLocal } from '../../lib/locale.js';
import React, { useEffect, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C, getDataSource } from '../../lib/storage/index.js';

const today = () => todayLocal();

/** Why a task its creator raised needs a look (first match wins), or null. */
function reasonFor(t) {
  if (t.status === 'Completed') return { tone: 'green', text: 'Work is finished: confirm and close it' };
  if (t.ecApproval === 'Rejected' || t.treasurerApproval === 'Rejected') return { tone: 'red', text: 'An approval was rejected: pick another quotation or fix it' };
  if (t.slaDueAt && t.slaDueAt < today()) return { tone: 'red', text: `Overdue since ${new Date(`${t.slaDueAt}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}` };
  if (t.status === 'On Hold') return { tone: 'orange', text: t.awaitingParts ? 'On hold, waiting for parts' : 'On hold' };
  if (t.status === 'Open' && !t.assignedTo) return { tone: 'orange', text: 'Not assigned to anyone yet' };
  return null;
}

/** "Needs attention": tasks YOU created that are stuck, overdue, rejected or waiting for you to close. Hidden when there are none.
 *  (Things waiting for your decision live in Approvals; things to pay live in Payments.) */
export default function NeedsAttention({ role }) {
  const { currentUser } = useApp();
  // on v2: only the open tasks I raised, from the server (one filtered page); otherwise every ticket, filtered here
  const v2 = getDataSource().mode === 'v2';
  const staffView = !!role && role.category !== 'Resident';
  const { records: all } = useCollection(C.TICKETS, 'Maintenance', { enabled: !v2 && staffView });
  const [raised, setRaised] = useState([]);
  useEffect(() => {
    if (!v2 || !staffView) return undefined;
    let on = true;
    const load = () => import('../../lib/storage/v2/V2ApiAdapter.js').then((m) => m.myOpenTickets()).then((x) => { if (on) setRaised(x); }).catch(() => {});
    load();
    const h = (e) => { if (!e?.detail?.collection || e.detail.collection === C.TICKETS) load(); };
    window.addEventListener('communityos:changed', h);
    return () => { on = false; window.removeEventListener('communityos:changed', h); };
  }, [v2, staffView]);
  if (!staffView) return null;
  const tickets = v2 ? raised : all;
  const mine = tickets
    .filter((t) => (v2 || t.createdBy === currentUser?.name) && !['Closed', 'Cancelled'].includes(t.status))
    .map((t) => ({ t, r: reasonFor(t) })).filter((x) => x.r);
  if (!mine.length) return null;
  const open = (t) => window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link: `#/ticket/${t.ticketNumber}` } }));
  return (
    <div className="card needs-attn" data-testid="needs-attention" style={{ marginTop: 16 }}>
      <h2 style={{ margin: 0 }}>Needs attention</h2>
      <p className="muted" style={{ margin: '2px 0 8px', fontSize: 13 }}>Tasks you raised that are overdue, rejected, on hold or ready to close.</p>
      <ul className="list">
        {mine.slice(0, 5).map(({ t, r }) => (
          <li key={t.id} className="row-link" data-testid="attn-row" onClick={() => open(t)}>
            <span><span className={`tag ${r.tone}`}>{r.text}</span> <b>{t.title}</b><br /><small className="muted">{t.ticketNumber} · {t.category}{t.assignedTo ? ` · ${t.assignedTo}` : ''}</small></span>
            <button type="button" className="btn sm" onClick={(e) => { e.stopPropagation(); open(t); }}>Open</button>
          </li>
        ))}
        {mine.length > 5 && <li><small className="muted">and {mine.length - 5} more in Maintenance → My tasks</small></li>}
      </ul>
    </div>
  );
}
