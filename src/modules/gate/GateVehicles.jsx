import React, { useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import RecordModal from '../billing/RecordModal.jsx';
import { StateTag } from './gateUi.jsx';

/** The plate list: residents' and drivers' cars, blocked vehicles, and regular goods vehicles that open on a plate read. */
export default function GateVehicles({ canEdit = false }) {
  const { records } = useCollection(COLLECTIONS.GATE_VEHICLES, 'Gate');
  const [q, setQ] = useState(''); const [edit, setEdit] = useState(null);
  const rows = [...records].filter((v) => !q || `${v.plate} ${v.owner} ${v.unit}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => String(a.plate).localeCompare(String(b.plate)));
  return (
    <div className="card" data-testid="gate-vehicles">
      <div className="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input className="search" aria-label="Search vehicles" placeholder="Search plate, owner, villa" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
        {canEdit && <button type="button" className="btn" data-testid="veh-add" onClick={() => setEdit({ status: 'Active', vehicleClass: 'Resident' })}>+ Vehicle</button>}
      </div>
      {rows.length === 0 && <div className="empty">No vehicles.</div>}
      {rows.map((v) => (
        <div className="gg-mini" key={v.id} data-testid="veh-row" onClick={() => canEdit && setEdit(v)}>
          <span style={{ fontSize: 22 }}>{v.recurringGoods ? '🚚' : '🚗'}</span>
          <div className="gg-main"><b>{v.plate}</b><small className="muted">{[v.owner, v.unit, v.vehicleClass, v.recurringGoods ? `regular goods vehicle, ${v.usualPeople || '?'} people` : ''].filter(Boolean).join(' · ')}</small></div>
          {v.status === 'Blocked' ? <StateTag state="Blocked" /> : v.recurringGoods ? <span className="tag green">opens on plate</span> : null}
        </div>
      ))}
      {edit && <RecordModal collection={COLLECTIONS.GATE_VEHICLES} label="Gate" record={edit} title={edit.id ? `Edit ${edit.plate}` : 'Add a vehicle'} subtitle="A Vendor vehicle marked as regular opens the gate on a plate read." allowDelete onClose={() => setEdit(null)} />}
    </div>
  );
}
