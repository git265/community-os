import React from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import NeedsAttention from './NeedsAttention.jsx';
import ImportantNumbers from './ImportantNumbers.jsx';
import DataHealthChip from './DataHealthChip.jsx';
import NoticeList from '../../components/NoticeList.jsx';

const FUND_COLORS = ['#14b8a6', '#f6b94c', '#377dff', '#ef5350', '#18a66a'];

function monthKey(billedMonth) {
  // "Sep 2026" -> sortable key; falls back to the string itself.
  const [mon, year] = (billedMonth || '').split(' ');
  const idx = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(mon);
  return idx === -1 ? billedMonth : `${year}-${String(idx + 1).padStart(2, '0')}`;
}

export default function DashboardModule({ onNavigate }) {
  const { role, roleId, hasPermission } = useApp();
  const { records: properties, loading: l1 } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const { records: tickets, loading: l2 } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const { records: dues, loading: l3 } = useCollection(COLLECTIONS.DUES, 'Billing');
  const { records: visitors, loading: l4 } = useCollection(COLLECTIONS.GATE_VISITS, 'Security');

  if (l1 || l2 || l3 || l4) return <div className="empty">Loading…</div>;

  const occupied = properties.filter((p) => p.occupancy !== 'Vacant').length;
  const openTickets = tickets.filter((t) => t.status !== 'Closed').length;
  const slaTickets = tickets.filter((t) => t.status === 'Open').length;
  const unpaid = dues.filter((d) => !['Paid', 'Cancelled'].includes(d.status));
  const unpaidTotal = unpaid.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  const inside = visitors.filter((v) => v.state === 'Inside').length;
  const insideVendors = visitors.filter((v) => v.state === 'Inside' && v.kind === 'Crew').length;

  // Maintenance summary: what is open, what is late and where the work is piling up.
  const todayIso = new Date().toISOString().slice(0, 10);
  const live = tickets.filter((t) => !['Closed', 'Cancelled'].includes(t.status));
  const overdue = live.filter((t) => t.slaDueAt && t.slaDueAt < todayIso);
  const critical = live.filter((t) => t.priority === 'Critical' || t.priority === 'High');
  const unassigned = live.filter((t) => t.status === 'Open');
  const onHold = live.filter((t) => t.status === 'On Hold' || t.awaitingParts);
  const awaitingClose = live.filter((t) => t.status === 'Completed');
  const closedMonth = tickets.filter((t) => t.status === 'Closed' && String(t.lastUpdatedAt || '').slice(0, 7) === todayIso.slice(0, 7)).length;

  const goTickets = (k) => { try { sessionStorage.setItem('communityos:ticketCard', k); } catch { /* ignore */ } onNavigate?.('tickets'); };
  const go = (id) => onNavigate?.(id);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Community command center</h1>
          <p>Live snapshot across properties, maintenance, billing and security.</p>
        </div>
      </div>

      <div className="grid metrics">
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => go('properties')}>
          <div className="label">Homes occupied</div>
          <div className="value">{occupied} <small className="muted">/ {properties.length}</small></div>
          <div className="muted">View properties ›</div>
        </button>
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => goTickets('live')}>
          <div className="label">Open maintenance tickets</div>
          <div className="value">{openTickets}</div>
          <div className="muted">{slaTickets > 0 ? `${slaTickets} not yet assigned · ` : ''}View ›</div>
        </button>
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => go('billing')}>
          <div className="label">Unpaid dues</div>
          <div className="value">₹{unpaidTotal.toLocaleString('en-IN')}</div>
          <div className="muted">{unpaid.length} unit{unpaid.length === 1 ? '' : 's'} · View ›</div>
        </button>
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => go('security')}>
          <div className="label">Visitors on premises</div>
          <div className="value">{inside}</div>
          <div className="muted">{insideVendors} crew · {inside - insideVendors} others</div>
        </button>
      </div>

      <DataHealthChip onNavigate={onNavigate} />
      <ImportantNumbers />

      <NeedsAttention role={role} roleId={roleId} hasPermission={hasPermission} onNavigate={onNavigate} />

      <div className="card" style={{ marginTop: 16 }} data-testid="maint-summary">
        <h2 style={{ margin: 0 }}>Maintenance summary</h2>
        <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>Tap a card to open those tasks in Maintenance.</p>
        <div className="stat-cards six" style={{ marginTop: 12 }}>
          {[
            { k: 'live', label: 'Open tasks', n: live.length },
            { k: 'overdue', label: 'Past SLA date', n: overdue.length, tone: overdue.length ? 'red' : '' },
            { k: 'critical', label: 'High / critical', n: critical.length, tone: critical.length ? 'amber' : '' },
            { k: 'open', label: 'Not yet picked up', n: unassigned.length },
            { k: 'hold', label: 'On hold / awaiting parts', n: onHold.length },
            { k: 'completed', label: 'Completed, to close', n: awaitingClose.length, tone: awaitingClose.length ? 'green' : '' },
          ].map((c) => (
            <button key={c.k} type="button" className={`stat-card ${c.tone || ''}`} data-testid={`mc-${c.k}`} disabled={!onNavigate} onClick={() => goTickets(c.k)} aria-label={`${c.label}: ${c.n}. Open in Maintenance`}>
              <span className="sc-label">{c.label}</span>
              <span className="sc-value">{c.n}</span>
              
            </button>
          ))}
        </div>
        {overdue.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <h3 style={{ margin: '0 0 6px' }}>Most overdue</h3>
            <ul className="list">{[...overdue].sort((a, b) => (a.slaDueAt < b.slaDueAt ? -1 : 1)).slice(0, 4).map((t) => <li key={t.id}><span><b>{t.title}</b><br /><small className="muted">{t.category} · {t.unit} · {t.assignedTo || 'unassigned'}</small></span><span className="tag red">due {t.slaDueAt}</span></li>)}</ul>
          </div>
        )}
        <small className="muted">{closedMonth} closed this month.</small>
      </div>

      <NoticeList limit={10} title="Notices" onOpen={onNavigate ? () => go('communications') : null} />
    </div>
  );
}
