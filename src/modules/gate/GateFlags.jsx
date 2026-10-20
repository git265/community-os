import React, { useEffect, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { resolveFlag, sweep } from '../../lib/gate/engine.js';
import { FLAG_RESOLUTIONS } from '../../lib/gate/constants.js';
import { Photo, StateTag, stamp, Countdown } from './gateUi.jsx';

function FlagCard({ f, canAct }) {
  const [res, setRes] = useState(FLAG_RESOLUTIONS[0]); const [why, setWhy] = useState(''); const [err, setErr] = useState('');
  async function close() { if (!why.trim()) { setErr('Give a reason. Every flag is closed with one.'); return; } await resolveFlag(f, res, why.trim()); }
  return (
    <div className={`gg-card ${f.state === 'Open' ? 'bad' : f.state === 'Watching' ? 'hot' : ''}`} data-testid="flag-card">
      <Photo src={f.photo} name={f.personName} size={72} />
      <div className="gg-main">
        <b>{f.type} <StateTag state={f.state} /> <small className="muted">· {f.gate} · {stamp(f.raisedAt)}</small></b>
        <span>{f.personName}{f.unit ? ` · ${f.unit}` : ''}</span>
        <small className="muted">{f.detail}</small>
        {f.state === 'Watching' && <small className="muted">Becomes a flag unless the guard registers them · <Countdown until={f.graceUntil} /></small>}
        {f.state === 'Closed' && <small className="muted">Closed by {f.resolvedBy}: <b>{f.resolution}</b> — {f.resolutionNote}</small>}
        {canAct && f.state !== 'Closed' && (
          <div className="gg-actions" style={{ alignItems: 'center' }}>
            <select aria-label="Resolution" data-testid="flag-resolution" value={res} onChange={(e) => setRes(e.target.value)} style={{ width: 'auto' }}>{FLAG_RESOLUTIONS.map((r) => <option key={r}>{r}</option>)}</select>
            <input aria-label="Reason" data-testid="flag-reason" placeholder="Reason (required)" value={why} onChange={(e) => { setWhy(e.target.value); setErr(''); }} style={{ flex: 1, minWidth: 160 }} />
            <button type="button" className="btn" data-testid="flag-close" onClick={close}>Close flag</button>
            {err && <div className="field-error" style={{ width: '100%' }}>{err}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function GateFlags({ canAct = true }) {
  const { records: flags } = useCollection(COLLECTIONS.GATE_FLAGS, 'Gate');
  const [tab, setTab] = useState('Open');
  useEffect(() => { sweep().catch(() => {}); const t = setInterval(() => sweep().catch(() => {}), 8000); return () => clearInterval(t); }, []);
  const count = (s) => flags.filter((f) => f.state === s).length;
  const shown = flags.filter((f) => f.state === tab).sort((a, b) => String(b.raisedAt).localeCompare(String(a.raisedAt)));
  const byType = Object.entries(flags.reduce((m, f) => ({ ...m, [f.type]: (m[f.type] || 0) + 1 }), {}));
  return (
    <div data-testid="gate-flags">
      <div className="card" style={{ marginBottom: 14 }}>
        <p className="muted hide-sm" style={{ margin: 0 }}>A ghost entry flag means the gate records and what the devices or cameras saw do not agree. Each flag carries the best photo, waits a short grace window, and is closed with a reason. Closed flags stay on record.</p>
        {byType.length > 0 && <p style={{ margin: '8px 0 0' }}>{byType.map(([t, n]) => <span key={t} className="tag" style={{ marginRight: 6 }}>{t} · {n}</span>)}</p>}
      </div>
      <div className="gg-chips" style={{ marginBottom: 12 }}>{['Open', 'Watching', 'Closed'].map((s) => <button key={s} type="button" className={tab === s ? 'on' : ''} data-testid={`flags-${s}`} onClick={() => setTab(s)}>{s} ({count(s)})</button>)}</div>
      {shown.length === 0 && <div className="empty card">{tab === 'Open' ? 'No open flags. Nothing is out of step.' : `No ${tab.toLowerCase()} flags.`}</div>}
      {shown.map((f) => <FlagCard key={f.id} f={f} canAct={canAct} />)}
    </div>
  );
}
