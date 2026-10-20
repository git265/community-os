import React, { useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { COLLECTIONS } from '../lib/storage/index.js';

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

export function ChangesList({ changes }) {
  if (!changes || changes.length === 0) return <div className="muted">No field changes recorded.</div>;
  return (
    <table className="changes">
      <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.field}>
            <td><b>{c.label}</b></td>
            <td className="chg-from">{c.from}</td>
            <td className="chg-to">{c.to}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Footer shown on a record's detail/edit view: Id, created/last-updated by + date, revision, and a "Show history" button
 * (who changed what, when, before -> after). Only the Executive Committee, Super Admin and roles given "View audit log" see it;
 * everyone else sees nothing here. History loads only when asked for.
 */
export default function RecordMeta({ record }) {
  const { hasPermission, roleId, role } = useApp();
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false); // "Audit details" is collapsed until asked for
  const [history, setHistory] = useState(null);
  const canHistory = roleId === 'super_admin' || hasPermission('VIEW_AUDIT_LOG');
  const canSee = canHistory || role?.category === 'EC'; // Executive Committee + anyone given "View audit log"
  if (!canSee) return null;
  if (!record?.id) return <div className="record-meta muted">New record — an Id is assigned on save.</div>;

  async function toggle() {
    if (!open && !history && canHistory) {
      const res = await secureStorage.query(COLLECTIONS.AUDIT, { filters: { recordId: record.id }, sort: { key: 'when', dir: 'desc' }, pageSize: 100 });
      // Only what happened to THIS record: creation, and for each update just the fields that changed.
      setHistory(res.rows.filter((h) => h.action === 'Create' || h.action === 'Delete' || (h.action === 'Update' && h.changes?.length > 0)));
    }
    setOpen((o) => !o);
  }

  if (!shown) {
    return (
      <div className="record-meta collapsed">
        <button type="button" className="record-meta-toggle" data-testid="audit-details-toggle" aria-expanded="false" onClick={() => setShown(true)}>
          <span aria-hidden="true">▸</span> Audit details <small className="muted">· {record.shortId || 'Id'} · updated {record.lastUpdatedAt ? new Date(record.lastUpdatedAt).toLocaleDateString() : '—'}</small>
        </button>
      </div>
    );
  }

  return (
    <div className="record-meta" data-testid="audit-details">
      <button type="button" className="record-meta-toggle" data-testid="audit-details-toggle" aria-expanded="true" onClick={() => { setShown(false); setOpen(false); }}><span aria-hidden="true">▾</span> Audit details</button>
      <div><span>Id</span><b className="mono">{record.shortId || '—'}</b></div>
      <div><span>Last updated by</span><b>{record.lastUpdatedBy ?? '—'}</b></div>
      <div><span>Last updated</span><b>{fmt(record.lastUpdatedAt)}</b></div>
      <div><span>Created</span><b>{fmt(record.recordCreatedAt)}{record.recordCreatedBy ? ` · ${record.recordCreatedBy}` : ''}</b></div>
      {record.recVersion != null && <div><span>Revision</span><b>#{record.recVersion}</b></div>}
      {canHistory && <button type="button" className="btn secondary" style={{ padding: '4px 10px', fontSize: 13 }} data-testid="history-toggle" aria-expanded={open} onClick={toggle}>{open ? 'Hide history' : 'Show history'}</button>}
      {open && history && (
        <div className="record-history">
          {history.length === 0 && <div className="muted">No recorded changes.</div>}
          {history.map((h) => (
            <div key={h.id} className="record-history-item">
              <div><b>{h.action === 'Create' ? 'Created' : h.action === 'Delete' ? 'Deleted' : 'Changed'}</b> · {h.who} · <span className="muted">{fmt(h.when)}</span></div>
              {h.action === 'Update' && <ChangesList changes={h.changes} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
