import React, { useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { parseVersion, restoreVersion } from '../../lib/infra/mapVersions.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Every change to where an asset sits (or how the plan is set up), newest first, each with who and when. "Put back" restores what
 * it was before that change; the restore is itself recorded, so nothing is ever lost.
 * props: recordId, canEdit, save (the collection's save), onRestored(text)
 */
export default function MapHistory({ recordId, canEdit, save, onRestored, title = 'Change history', open = false, limit = 12 }) {
  const { records } = useCollection(COLLECTIONS.MAP_VERSIONS, 'Map change history');
  const [busy, setBusy] = useState('');
  const rows = records.filter((r) => r.recordId === recordId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (!rows.length) return null;
  async function putBack(v) {
    setBusy(v.id);
    const out = await restoreVersion(v, save);
    setBusy('');
    onRestored?.(out ? 'Put back as it was before that change.' : 'That version could not be restored (the record may no longer exist).', !!out);
  }
  return (
    <details open={open} className="map-history" data-testid="map-history" style={{ marginTop: 12 }}>
      <summary><b>{title}</b> <small className="muted">· {rows.length}</small></summary>
      <ul className="list" style={{ display: 'block', margin: '6px 0 0' }}>
        {rows.slice(0, limit).map((v) => (
          <li key={v.id} data-testid="history-row" style={{ display: 'block', padding: '6px 0' }}>
            <div>{v.summary || v.action}</div>
            <small className="muted">{when(v.at)} · {v.by}</small>
            {canEdit && parseVersion(v).before && <div><button type="button" className="btn secondary sm" data-testid="history-restore" disabled={!!busy} onClick={() => putBack(v)} style={{ marginTop: 4 }}>{busy === v.id ? 'Putting back…' : v.action === 'delete' ? 'Bring it back' : 'Put back as before'}</button></div>}
          </li>
        ))}
      </ul>
      {rows.length > limit && <small className="muted">Showing the latest {limit} of {rows.length}.</small>}
    </details>
  );
}
