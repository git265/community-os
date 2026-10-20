import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { COND_COLOR, effectiveCondition, faultyOf, openTicketsByAsset, units } from '../infra/infraModel.js';
import AssetTaskDialog from '../infra/AssetTaskDialog.jsx';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';

const BAD = ['Needs attention', 'Under repair', 'Out of service'];

/** Collapsed strip above the task list: assets that need attention, with their open task or a one-tap "Raise task". */
export default function FaultyAssets({ tickets, onOpenTicket }) {
  const { records: assets } = useCollection(C.EQUIPMENT, 'Equipment & Assets');
  const [open, setOpen] = useState(false);
  const [raise, setRaise] = useState(null);
  const canRaise = canWriteCollection(C.TICKETS, getPrincipal());
  const rows = useMemo(() => {
    const byAsset = openTicketsByAsset(tickets); const ids = new Set(byAsset.keys());
    return assets.map((a) => ({ a, c: effectiveCondition(a, ids), t: (byAsset.get(a.id) || [])[0] })).filter((x) => BAD.includes(x.c))
      .sort((x, y) => BAD.indexOf(y.c) - BAD.indexOf(x.c) || String(x.a.name).localeCompare(String(y.a.name)));
  }, [assets, tickets]);
  if (!rows.length) return null;
  const cnt = (c) => rows.filter((x) => x.c === c).length;
  return (
    <div className="card" style={{ marginBottom: 12, padding: 10 }} data-testid="faulty-assets">
      <button type="button" className="record-meta-toggle" data-testid="faulty-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ width: '100%', textAlign: 'left' }}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> <b>Assets needing attention ({rows.length})</b>
        <small className="muted"> · {cnt('Out of service')} out of service · {cnt('Under repair')} under repair · {cnt('Needs attention')} need attention</small>
      </button>
      {open && (
        <ul className="list" style={{ marginTop: 8 }}>
          {rows.map(({ a, c, t }) => (
            <li key={a.id} data-testid="faulty-row" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="dot" style={{ background: COND_COLOR[c], width: 10, height: 10, borderRadius: 5, display: 'inline-block' }} />
              <span style={{ flex: 1, minWidth: 160 }}><b>{a.name}</b><br /><small className="muted">{[a.type, a.area].filter(Boolean).join(' · ')} · {c}{units(a) > 1 && faultyOf(a) > 0 ? ` · ${faultyOf(a)} of ${units(a)} faulty` : ''}</small></span>
              {t ? <button type="button" className="btn secondary sm" onClick={() => onOpenTicket(t.id)}>{t.ticketNumber || 'Open task'}</button>
                : canRaise && <button type="button" className="btn sm" data-testid="faulty-raise" onClick={() => setRaise(a)}>Raise task</button>}
            </li>
          ))}
        </ul>
      )}
      {raise && <AssetTaskDialog asset={raise} onClose={() => setRaise(null)} onDone={() => setRaise(null)} />}
    </div>
  );
}
