import React, { useState } from 'react';
import { fmtDateTime } from '../../lib/locale.js';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { GATE_NAMES } from '../../lib/gate/constants.js';

export default function GateIncidents({ canReport = true }) {
  const { records: incidents, save } = useCollection(COLLECTIONS.INCIDENTS, 'Security Incidents');
  const [open, setOpen] = useState(false); const [f, setF] = useState({ title: '', gate: GATE_NAMES[0], description: '' }); const [err, setErr] = useState('');
  async function submit(e) { e.preventDefault(); if (!f.title.trim()) { setErr('Incident is required'); return; } if (String(f.description || '').length > 8000) { setErr('Keep the description to 8,000 characters'); return; } await save({ ...f, reportedAt: new Date().toISOString(), assignedCommittee: '', status: 'Open' }); setF({ title: '', gate: GATE_NAMES[0], description: '' }); setOpen(false); setErr(''); }
  return (
    <div className="card" data-testid="gate-incidents">
      <div className="gg-row" style={{ justifyContent: 'space-between' }}><div><h2 style={{ margin: 0 }}>Incidents</h2><p className="muted" style={{ margin: '4px 0 12px' }}>Log a security incident and hand it to the right committee.</p></div>{canReport && <button type="button" className="btn secondary" onClick={() => setOpen((v) => !v)}>+ Report incident</button>}</div>
      {open && (
        <form className="form-grid" onSubmit={submit} style={{ marginBottom: 14 }}>
          <div className={`field${err ? ' invalid' : ''}`}><label>Incident *</label><input value={f.title} onChange={(e) => setF((s) => ({ ...s, title: e.target.value }))} />{err && <div className="field-error">{err}</div>}</div>
          <div className="field"><label>Gate / location</label><select value={f.gate} onChange={(e) => setF((s) => ({ ...s, gate: e.target.value }))}>{GATE_NAMES.map((g) => <option key={g}>{g}</option>)}</select></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Description</label><textarea rows={2} value={f.description} onChange={(e) => setF((s) => ({ ...s, description: e.target.value }))} /></div>
          <div className="form-actions"><button type="submit" className="btn">Submit</button><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button></div>
        </form>
      )}
      {incidents.length === 0 ? <div className="empty">No incidents reported.</div> : (
        <ul className="list" style={{ display: 'block' }}>{[...incidents].reverse().map((i) => (
          <li key={i.id} style={{ display: 'block', padding: '12px 0' }}>
            <span className={`tag ${i.status === 'Resolved' ? 'green' : i.status === 'EC review' ? 'orange' : 'gg-tag-coral'}`}>{i.status}</span>
            <p style={{ margin: '8px 0 2px' }}><b>{i.title}</b></p><small className="muted">{i.gate} · Reported {/^\d{4}-\d{2}-\d{2}T/.test(String(i.reportedAt || '')) ? fmtDateTime(i.reportedAt) : i.reportedAt}{i.assignedCommittee ? ` · ${i.assignedCommittee}` : ''}</small>
            {i.description && <p className="muted" style={{ margin: '6px 0' }}>{i.description}</p>}
            {canReport && i.status !== 'Resolved' && <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>{i.status === 'Open' && <button type="button" className="btn secondary" onClick={() => save({ ...i, assignedCommittee: 'Security Committee', status: 'EC review' })}>Assign committee</button>}<button type="button" className="btn secondary" onClick={() => save({ ...i, status: 'Resolved' })}>Mark resolved</button></div>}
          </li>))}</ul>
      )}
    </div>
  );
}
