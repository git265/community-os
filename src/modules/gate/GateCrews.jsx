import React, { useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { CREW_CLASSES, DAYS } from '../../lib/gate/constants.js';
import { dayOf, answerApproval, windowOpen } from '../../lib/gate/engine.js';
import { Photo, StateTag, clock, sameDay } from './gateUi.jsx';

function Roster({ order, onClose }) {
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const { save } = useCollection(COLLECTIONS.GATE_WORKORDERS, 'Gate');
  const [ids, setIds] = useState(order.rosterIds || []); const [q, setQ] = useState('');
  const pool = people.filter((p) => CREW_CLASSES.includes(p.personClass) && p.status === 'Active' && (!q || `${p.name} ${p.vendor || ''}`.toLowerCase().includes(q.toLowerCase())));
  const blocked = people.filter((p) => CREW_CLASSES.includes(p.personClass) && p.status !== 'Active').length;
  const toggle = (id) => setIds((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  return (
    <Modal title={`Roster · ${order.title}`} subtitle="Only vetted (Active) people can be put on a roster." onClose={onClose}>
      <input className="search" aria-label="Search people" placeholder="Search by name or vendor" value={q} onChange={(e) => setQ(e.target.value)} />
      <div style={{ maxHeight: 340, overflow: 'auto', marginTop: 8 }}>{pool.map((p) => <label className="gg-check" key={p.id} data-testid="roster-pick"><input type="checkbox" checked={ids.includes(p.id)} onChange={() => toggle(p.id)} /><Photo src={p.photo} name={p.name} size={32} /><span style={{ flex: 1 }}><b>{p.name}</b> <small className="muted">{p.personClass} · {p.vendor || '—'}</small></span></label>)}</div>
      {blocked > 0 && <small className="muted">{blocked} more crew-type people are not Active yet and cannot be listed.</small>}
      <div className="form-actions" style={{ marginTop: 12 }}><button type="button" className="btn" data-testid="roster-save" onClick={async () => { await save({ ...order, rosterIds: ids, expectedHeadcount: Number(order.expectedHeadcount) || ids.length }); onClose(); }}>Save roster ({ids.length})</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

export default function GateCrews({ canEdit = true }) {
  const { records: orders } = useCollection(COLLECTIONS.GATE_WORKORDERS, 'Gate');
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const { records: approvals } = useCollection(COLLECTIONS.GATE_APPROVALS, 'Gate');
  const [edit, setEdit] = useState(null); const [roster, setRoster] = useState(null);
  const waiting = approvals.filter((a) => a.unit === 'Common area' && ['Pending', 'No answer'].includes(a.status));
  const todays = visits.filter((v) => sameDay(v.inAt));
  return (
    <div data-testid="gate-crews">
      {waiting.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }} data-testid="crew-waiting"><h3 style={{ marginTop: 0 }}>Waiting for the Facility Manager</h3>
          {waiting.map((a) => <div className="gg-card hot" key={a.id}><Photo src={a.photo} name={a.name} size={56} /><div className="gg-main"><b>{a.name}</b><span className="muted">{a.purpose}</span><div className="gg-actions"><button type="button" className="btn good" data-testid="crew-approve" onClick={() => answerApproval(a.id, 'Approved')}>Allow today</button><button type="button" className="btn deny" onClick={() => answerApproval(a.id, 'Denied')}>Deny</button></div></div></div>)}
        </div>
      )}
      <div className="gg-row" style={{ justifyContent: 'space-between', marginBottom: 10 }}><p className="muted" style={{ margin: 0 }}>Each crew job is a work order with a roster. The gate lets listed people in inside the window; anyone else is held for approval.</p>{canEdit && <button type="button" className="btn" data-testid="wo-add" onClick={() => setEdit({ status: 'Active', days: DAYS.slice(0, 6), fromTime: '07:00', toTime: '16:00' })}>+ New work order</button>}</div>
      {orders.length === 0 && <div className="empty card">No work orders yet.</div>}
      {orders.map((o) => {
        const crew = (o.rosterIds || []).map((id) => people.find((p) => p.id === id)).filter(Boolean);
        const mine = todays.filter((v) => v.workOrderId === o.id);
        const inside = crew.filter((p) => mine.some((v) => v.personId === p.id && v.state === 'Inside'));
        const left = crew.filter((p) => mine.some((v) => v.personId === p.id && ['Exited', 'Auto-closed'].includes(v.state)) && !inside.includes(p));
        const expected = Number(o.expectedHeadcount) || crew.length; const open = windowOpen(o);
        return (
          <div className="card" key={o.id} style={{ marginBottom: 14 }} data-testid="work-order">
            <div className="gg-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div><h3 style={{ margin: 0 }}>{o.title} <StateTag state={o.status} /></h3><span className="muted">{o.vendor} · {o.area} · {(o.days || []).join(', ')} · {o.fromTime}-{o.toTime}</span></div>
              <div><b data-testid="wo-headcount" style={{ fontSize: 22 }}>{inside.length}</b> <span className="muted">in now of {expected} expected · {left.length} left</span></div>
            </div>
            {o.equipment && <p className="muted" style={{ margin: '6px 0' }}>Tools and vehicles: {o.equipment}</p>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, margin: '8px 0' }}>{crew.map((p) => { const st = inside.includes(p) ? 'Inside' : left.includes(p) ? 'Exited' : 'Not arrived'; return <div key={p.id} className="gg-row" style={{ gap: 8, width: 210 }} data-testid="crew-member"><Photo src={p.photo} name={p.name} size={36} /><span><b>{p.name}</b><br /><small className="muted">{st}{st === 'Not arrived' && open && o.status === 'Active' ? ' · window open' : ''}</small></span></div>; })}</div>
            {crew.length < expected && <small className="muted">Roster has {crew.length} of {expected} names.</small>}
            {canEdit && <div className="gg-actions" style={{ display: 'flex', gap: 8, marginTop: 8 }}><button type="button" className="btn secondary" data-testid="wo-roster" onClick={() => setRoster(o)}>Edit roster</button><button type="button" className="btn secondary" onClick={() => setEdit(o)}>Edit order</button>{o.status === 'Active' && <button type="button" className="btn secondary" onClick={() => setEdit({ ...o, status: 'Closed' })}>Close</button>}</div>}
          </div>
        );
      })}
      {edit && <RecordModal collection={COLLECTIONS.GATE_WORKORDERS} label="Gate" record={edit} title={edit.id ? 'Edit work order' : 'New work order'} onClose={() => setEdit(null)} />}
      {roster && <Roster order={roster} onClose={() => setRoster(null)} />}
    </div>
  );
}
