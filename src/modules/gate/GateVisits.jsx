import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import { VISIT_KINDS, VISIT_STATES } from '../../lib/gate/constants.js';
import { Photo, StateTag, clock, sameDay, stamp } from './gateUi.jsx';
import { PhoneSearch, PhoneFilters } from '../../components/ToolIcons.jsx';
import { usePhone } from '../../components/Tabs.jsx';

const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);
export const dur = (m) => (m == null ? '' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);

export function VisitDetail({ v, onClose, dock = false }) {
  const { records: approvals } = useCollection(COLLECTIONS.GATE_APPROVALS, 'Gate');
  const ap = approvals.find((a) => a.id === v.approvalId);
  return (
    <Modal dock={dock} title={v.name} subtitle={`${v.shortId || ''} · ${v.kind}`} onClose={onClose}>
      <div className="gg-row" style={{ marginBottom: 12 }}><Photo src={v.photo} name={v.name} size={120} /><StateTag state={v.state} /></div>
      <div className="form-grid">
        {[['Going to', v.unit || '—'], ['Gate', v.gate], ['In', `${stamp(v.inAt)} · ${v.method}`],
          ['Out', v.outAt ? `${stamp(v.outAt)}${v.outMethod ? ` · ${v.outMethod}` : ''} (${dur(mins(v.inAt, v.outAt))})` : '—'],
          v.company && ['Company', v.company], v.vehicle && ['Vehicle', v.vehicle], v.purpose && ['Purpose', v.purpose], ['Recorded by', v.verifiedBy || '—'],
          v.note && ['Note', v.note]].filter(Boolean).map(([k, x]) => <div className="field" key={k}><label>{k}</label><div className="ro-value">{x}</div></div>)}
        {ap && <div className="field"><label>Approval</label><div className="ro-value"><StateTag state={ap.status} /> {ap.answeredBy ? `by ${ap.answeredBy}` : ''} {ap.answeredAt ? `· answered in ${Math.max(1, Math.round((new Date(ap.answeredAt) - new Date(ap.requestedAt)) / 1000))} s` : ''}</div></div>}
      </div>
    </Modal>
  );
}

export default function GateVisits() {
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const [range, setRange] = useState('today'); const [kind, setKind] = useState(''); const [state, setState] = useState(''); const [q, setQ] = useState(''); const [open, setOpen] = useState(null);
  const phone = usePhone(); const docked = !!open && !phone;   // a computer: the visit opens beside the list
  const rows = useMemo(() => visits.filter((v) => {
    if (range === 'today' && !sameDay(v.inAt)) return false;
    if (range === '7' && Date.now() - new Date(v.inAt) > 7 * 86400000) return false;
    if (kind && v.kind !== kind) return false; if (state && v.state !== state) return false;
    return !q || `${v.name} ${v.unit} ${v.vehicle} ${v.company} ${v.shortId}`.toLowerCase().includes(q.toLowerCase());
  }).sort((a, b) => String(b.inAt).localeCompare(String(a.inAt))), [visits, range, kind, state, q]);
  function csv() {
    const head = ['Id', 'Name', 'Kind', 'Going to', 'Gate', 'State', 'Method', 'In', 'Out', 'Vehicle', 'Company'];
    const body = rows.map((v) => [v.shortId, v.name, v.kind, v.unit, v.gate, v.state, v.method, v.inAt, v.outAt, v.vehicle, v.company].map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(','));
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' })); a.download = 'gate-visits.csv'; a.click();
  }
  return (
    <div className={`card${docked ? ' list-docked' : ''}`} data-testid="gate-visits">
      <div className="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <select aria-label="Period" value={range} onChange={(e) => setRange(e.target.value)} style={{ width: 'auto' }}><option value="today">Today</option><option value="7">Last 7 days</option><option value="all">All</option></select>
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)} style={{ width: 'auto' }}><option value="">All kinds</option>{VISIT_KINDS.map((k) => <option key={k}>{k}</option>)}</select>
        <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} style={{ width: 'auto' }}><option value="">All states</option>{VISIT_STATES.map((k) => <option key={k}>{k}</option>)}</select>
        <PhoneSearch className="search" placeholder="Search name, villa, vehicle, id" ariaLabel="Search visits" value={q} onChange={(v) => setQ(v)} />
        <button type="button" className="btn secondary hide-sm" style={{ marginLeft: 'auto' }} onClick={csv}>Download CSV</button>
      </div>
      <div className="table-wrap hide-sm"><table><thead><tr><th></th><th>Who</th><th>Going to</th><th>Gate</th><th>In</th><th>Out</th><th>State</th></tr></thead><tbody>
        {rows.slice(0, 200).map((v) => (
          <tr key={v.id} className="clickable" data-testid="visit-row" onClick={() => setOpen(v)}>
            <td><Photo src={v.photo} name={v.name} size={34} /></td>
            <td><b>{v.name}</b><br /><small className="muted">{v.kind}{v.company ? ` · ${v.company}` : ''}{v.vehicle ? ` · ${v.vehicle}` : ''}</small></td>
            <td>{v.unit}</td><td>{v.gate}</td><td>{clock(v.inAt)}</td><td>{clock(v.outAt) || '—'}</td><td><StateTag state={v.state} /></td>
          </tr>
        ))}
      </tbody></table>{rows.length === 0 && <div className="empty">No visits match.</div>}</div>
      <div className="show-sm" data-testid="visit-list">
        {rows.length === 0 && <div className="empty">No visits match.</div>}
        {rows.slice(0, 100).map((v) => (
          <div key={v.id} className={`gg-mini${open?.id === v.id ? ' row-sel' : ''}`} data-testid="visit-card" onClick={() => setOpen(v)}>
            <Photo src={v.photo} name={v.name} size={36} />
            <div className="gg-main"><b>{v.name}</b><small className="muted">{[v.kind, v.unit && `→ ${v.unit}`, clock(v.inAt)].filter(Boolean).join(' · ')}{v.vehicle ? ` · ${v.vehicle}` : ''}</small></div>
            <StateTag state={v.state} />
          </div>
        ))}
      </div>
      {open && <VisitDetail dock v={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
