import React, { useEffect, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS, getDataSource } from '../../lib/storage/index.js';
import NeedsAttention from './NeedsAttention.jsx';
import ImportantNumbers from './ImportantNumbers.jsx';
import DataHealthChip from './DataHealthChip.jsx';
import NoticeList from '../../components/NoticeList.jsx';
import { useApprovals } from '../approvals/ApprovalsPanel.jsx';
import { money, fmtDate } from '../../lib/locale.js';
import { usePhone } from '../../components/Tabs.jsx';

/** Phone home: the few things waiting for THIS person, one tap each (approvals, tickets nobody has, unpaid bills). Hidden when nothing waits. */
function NeedsYou({ unassigned, unpaidTotal, unpaidUnits, goTickets, go }) {
  const items = useApprovals().filter((i) => i.mine);
  const owed = items.reduce((n, i) => n + (Number(i.amount) || 0), 0);
  const openLink = (link) => window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link } }));
  const rows = [
    items.length > 0 && { k: 'approve', b: 'Review', tone: 'warn', t: `${items.length} waiting for your approval`, s: owed ? `${money(owed)} · ${[...new Set(items.map((i) => i.kind))].slice(0, 2).join(', ').toLowerCase()}` : items[0].title, on: () => (items.length === 1 ? openLink(items[0].link) : goTickets('live')) },
    unassigned > 0 && { k: 'assign', b: 'Assign', tone: 'info', t: `${unassigned} ticket${unassigned === 1 ? '' : 's'} not yet assigned`, s: 'Open them in Maintenance', on: () => goTickets('open') },
    unpaidUnits > 0 && { k: 'unpaid', b: 'Collect', tone: 'bad', t: `${money(unpaidTotal)} unpaid dues`, s: 'Open Billing to collect or remind', on: () => go('billing') },
  ].filter(Boolean);
  if (!rows.length) return null;
  return (
    <section className="needs-you mobile-only" data-testid="needs-you" aria-label="Needs you">
      <h2>Needs you <span className="nu-count">{rows.length}</span></h2>
      {rows.map((r) => (
        <button key={r.k} type="button" className="nu-row" data-testid={`nu-${r.k}`} onClick={r.on}>
          <span className={`nu-dot ${r.tone}`} aria-hidden="true" />
          <span className="nu-text"><b>{r.t}</b><small>{r.s}</small></span>
          <span className="nu-go" aria-hidden="true">›</span>
          <span className="nu-btn" aria-hidden="true">{r.b}</span>
        </button>
      ))}
    </section>
  );
}

const FUND_COLORS = ['#14b8a6', '#f6b94c', '#377dff', '#ef5350', '#18a66a'];

function monthKey(billedMonth) {
  // "Sep 2026" -> sortable key; falls back to the string itself.
  const [mon, year] = (billedMonth || '').split(' ');
  const idx = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(mon);
  return idx === -1 ? billedMonth : `${year}-${String(idx + 1).padStart(2, '0')}`;
}

/** The v2 server's counts for this page (one call), refreshed when something they count changes. null until loaded or when not on v2. */
function useServerSummary(on) {
  const [sum, setSum] = useState(null);
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    const load = () => import('../../lib/storage/v2/V2ApiAdapter.js').then((m) => m.v2Summary('dashboard')).then((x) => { if (live) setSum(x); }).catch(() => { if (live) setSum((s) => s || {}); });
    load();
    const h = (e) => { const c = e?.detail?.collection; if (!c || ['tickets', 'dues', 'gateVisits', 'properties', 'amenities'].includes(c)) load(); };
    window.addEventListener('communityos:changed', h);
    return () => { live = false; window.removeEventListener('communityos:changed', h); };
  }, [on]);
  return sum;
}

export default function DashboardModule({ onNavigate }) {
  const { role, roleId, hasPermission } = useApp();
  const phone = usePhone();
  // on the v2 back end the server counts (one call); otherwise the lists are read and counted here
  const v2 = getDataSource().mode === 'v2';
  const sum = useServerSummary(v2);
  const { records: properties, loading: l1 } = useCollection(COLLECTIONS.PROPERTIES, 'Properties', { enabled: !v2 });
  const { records: tickets, loading: l2 } = useCollection(COLLECTIONS.TICKETS, 'Maintenance', { enabled: !v2 });
  const { records: dues, loading: l3 } = useCollection(COLLECTIONS.DUES, 'Billing', { enabled: !v2 });
  const { records: visitors, loading: l4 } = useCollection(COLLECTIONS.GATE_VISITS, 'Security', { enabled: !v2 });

  if (v2 ? !sum : (l1 || l2 || l3 || l4)) return <div className="empty">Loading…</div>;

  const todayIso = new Date().toISOString().slice(0, 10);
  const st = (k) => Number(sum?.tickets?.byStatus?.[k] || 0);
  let occupied, homes, openTickets, slaTickets, unpaidTotal, unpaidUnits, inside, insideVendors, live, overdue, critical, unassigned, onHold, awaitingClose, closedMonth, mostOverdue;
  if (v2) {
    occupied = sum.homes?.occupied ?? 0; homes = sum.homes?.total ?? 0;
    openTickets = (sum.tickets?.total ?? 0) - st('Closed'); slaTickets = st('Open');
    unpaidTotal = Number(sum.dues?.outstanding || 0); unpaidUnits = sum.dues?.unitsOwing ?? 0;
    inside = sum.gate?.inside ?? 0; insideVendors = sum.gate?.insideCrew ?? 0;
    live = (sum.tickets?.total ?? 0) - st('Closed') - st('Cancelled'); overdue = sum.tickets?.overdue ?? 0; critical = sum.tickets?.critical ?? 0;
    unassigned = st('Open'); onHold = sum.tickets?.onHold ?? 0; awaitingClose = st('Completed'); closedMonth = sum.tickets?.closedThisMonth ?? 0;
    mostOverdue = (sum.tickets?.mostOverdue || []).map((t) => ({ id: t.id, title: t.title, category: t.category, unit: t.unitNo || 'Common area', assignedTo: t.assignee || '', slaDueAt: t.slaDueAt }));
  } else {
    occupied = properties.filter((p) => p.occupancy !== 'Vacant').length; homes = properties.length;
    openTickets = tickets.filter((t) => t.status !== 'Closed').length;
    slaTickets = tickets.filter((t) => t.status === 'Open').length;
    const unpaid = dues.filter((d) => !['Paid', 'Cancelled'].includes(d.status));
    unpaidTotal = unpaid.reduce((s, d) => s + (Number(d.amount) || 0), 0); unpaidUnits = unpaid.length;
    inside = visitors.filter((v) => v.state === 'Inside').length;
    insideVendors = visitors.filter((v) => v.state === 'Inside' && v.kind === 'Crew').length;
    // Maintenance summary: what is open, what is late and where the work is piling up.
    const liveRows = tickets.filter((t) => !['Closed', 'Cancelled'].includes(t.status));
    const overdueRows = liveRows.filter((t) => t.slaDueAt && t.slaDueAt < todayIso);
    live = liveRows.length; overdue = overdueRows.length;
    critical = liveRows.filter((t) => t.priority === 'Critical' || t.priority === 'High').length;
    unassigned = liveRows.filter((t) => t.status === 'Open').length;
    onHold = liveRows.filter((t) => t.status === 'On Hold' || t.awaitingParts).length;
    awaitingClose = liveRows.filter((t) => t.status === 'Completed').length;
    closedMonth = tickets.filter((t) => t.status === 'Closed' && String(t.lastUpdatedAt || '').slice(0, 7) === todayIso.slice(0, 7)).length;
    mostOverdue = [...overdueRows].sort((a, b) => (a.slaDueAt < b.slaDueAt ? -1 : 1)).slice(0, 4);
  }

  const goTickets = (k) => { try { sessionStorage.setItem('communityos:ticketCard', k); } catch { /* ignore */ } onNavigate?.('tickets'); };
  const go = (id) => onNavigate?.(id);
  const needsYou = role?.category !== 'Resident' && <NeedsYou unassigned={slaTickets} unpaidTotal={unpaidTotal} unpaidUnits={unpaidUnits} goTickets={goTickets} go={go} />;
  const notices = <NoticeList limit={10} title="Notices" onOpen={onNavigate ? () => go('communications') : null} />;
  const maintSummary = (
    <div className="card" style={{ marginTop: 16 }} data-testid="maint-summary">
      <h2 style={{ margin: 0 }}>Maintenance summary</h2>
      <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>Tap a card to open those tasks in Maintenance.</p>
      <div className="stat-cards six" style={{ marginTop: 12 }}>
        {[
          { k: 'live', label: 'Open tasks', n: live },
          { k: 'overdue', label: 'Past SLA date', n: overdue, tone: overdue ? 'red' : '' },
          { k: 'critical', label: 'High / critical', n: critical, tone: critical ? 'amber' : '' },
          { k: 'open', label: 'Not yet picked up', n: unassigned },
          { k: 'hold', label: 'On hold / awaiting parts', n: onHold },
          { k: 'completed', label: 'Completed, to close', n: awaitingClose, tone: awaitingClose ? 'green' : '' },
        ].map((c) => (
          <button key={c.k} type="button" className={`stat-card ${c.tone || ''}`} data-testid={`mc-${c.k}`} disabled={!onNavigate} onClick={() => goTickets(c.k)} aria-label={`${c.label}: ${c.n}. Open in Maintenance`}>
            <span className="sc-label">{c.label}</span>
            <span className="sc-value">{c.n}</span>
          
          </button>
        ))}
      </div>
      {overdue > 0 && mostOverdue.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h3 style={{ margin: '0 0 6px' }}>Most overdue</h3>
          <ul className="list">{mostOverdue.map((t) => <li key={t.id}><span><b>{t.title}</b><br /><small className="muted">{t.category} · {t.unit} · {t.assignedTo || 'unassigned'}</small></span><span className="tag red">due {fmtDate(t.slaDueAt)}</span></li>)}</ul>
        </div>
      )}
      <small className="muted">{closedMonth} closed this month.</small>
    </div>
  );

  return (
    <div className="cc-home">
      <div className="page-head">
        <div>
          <h1>Community command center</h1>
          <p>Live snapshot across properties, maintenance, billing and security.</p>
        </div>
      </div>

      <div className="grid metrics">
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => go('properties')}>
          <div className="label">Homes occupied</div><div className="label-short">Homes</div>
          <div className="value">{occupied} <small className="muted">/ {homes}</small></div>
          <div className="muted">View properties ›</div>
        </button>
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => goTickets('live')}>
          <div className="label">Open maintenance tickets</div><div className="label-short">Open tickets</div>
          <div className="value">{openTickets}</div>
          <div className="muted">{slaTickets > 0 ? `${slaTickets} not yet assigned · ` : ''}View ›</div>
        </button>
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => go('billing')}>
          <div className="label">Unpaid dues</div><div className="label-short">Unpaid</div>
          <div className="value">₹{unpaidTotal.toLocaleString('en-IN')}</div>
          <div className="muted">{unpaidUnits} unit{unpaidUnits === 1 ? '' : 's'} · View ›</div>
        </button>
        <button type="button" className="card metric clickable" disabled={!onNavigate} onClick={() => go('security')}>
          <div className="label">Visitors on premises</div><div className="label-short">Visitors in</div>
          <div className="value">{inside}</div>
          <div className="muted">{insideVendors} crew · {inside - insideVendors} others</div>
        </button>
      </div>

      {phone ? (<>
        {needsYou}
        <DataHealthChip onNavigate={onNavigate} />
        <ImportantNumbers />
        <NeedsAttention role={role} roleId={roleId} hasPermission={hasPermission} onNavigate={onNavigate} />
        {maintSummary}
        {notices}
      </>) : (
        <div className="home-cols">   {/* computer: what needs doing on the left, notices and numbers on the right */}
          <div className="home-main">
            {needsYou}
            <DataHealthChip onNavigate={onNavigate} />
            <NeedsAttention role={role} roleId={roleId} hasPermission={hasPermission} onNavigate={onNavigate} />
            {maintSummary}
          </div>
          <div className="home-side">
            {notices}
            <ImportantNumbers />
          </div>
        </div>
      )}
    </div>
  );
}
