import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { SegTabs } from '../../components/ui.jsx';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { DEFAULT_SCHEMAS } from '../../lib/schema/registry.js';
import ServerTable from '../../components/ServerTable.jsx';
import { usePhone } from '../../components/Tabs.jsx';
import { ChangesList } from '../../components/RecordMeta.jsx';
import Modal from '../../components/Modal.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';

const COLUMNS = [
  { key: 'when', label: 'Date / time', render: (r) => new Date(r.when).toLocaleString() },
  { key: 'who', label: 'Who' },
  { key: 'what', label: 'Section' },
  { key: 'action', label: 'Action', render: (r) => <span className={`tag ${r.action === 'Denied' ? 'red' : r.action === 'Delete' ? 'amber' : 'blue'}`}>{r.action}</span> },
  { key: 'recordShortId', label: 'Id', className: 'mono' },
  { key: 'summary', label: 'Record' },
  { key: 'changes', label: 'Fields changed', sortable: false, render: (r) => (r.changes?.length ? r.changes.map((c) => c.label).join(', ') : '—') },
];

const COVERAGE_WINDOW = 2000; // newest entries only: the trail is big and paged on the server

/** Which parts of the app have their changes in the audit trail, with how many entries each has. */
function Coverage() {
  const [rows, setRows] = useState(null);
  useEffect(() => { secureStorage.query(COLLECTIONS.AUDIT, { page: 1, pageSize: COVERAGE_WINDOW, sort: { key: 'when', dir: 'desc' } }).then((r) => setRows(r.rows || r.items || [])).catch(() => setRows([])); }, []);
  const list = useMemo(() => {
    const by = new Map();
    (rows || []).forEach((r) => { const k = r.what || r.collection; const e = by.get(k) || { n: 0, last: '' }; e.n += 1; if (String(r.when) > e.last) e.last = r.when; by.set(k, e); });
    const names = new Set(DEFAULT_SCHEMAS.map((s) => s.label));
    const out = DEFAULT_SCHEMAS.filter((s) => s.id !== COLLECTIONS.AUDIT).map((s) => ({ name: s.label, ...(by.get(s.label) || { n: 0, last: '' }) }));
    [...by.keys()].filter((k) => !names.has(k)).forEach((k) => out.push({ name: k, ...by.get(k) }));
    return out.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  }, [rows]);
  if (!rows) return <div className="card"><span className="muted">Loading…</span></div>;
  return (
    <div className="card" data-testid="audit-coverage">
      <h3 style={{ marginTop: 0 }}>What the audit trail covers</h3>
      <p className="muted" style={{ marginTop: 0 }}>Counts are for the latest {COVERAGE_WINDOW.toLocaleString()} entries.</p>
      <ul style={{ margin: '0 0 10px', paddingLeft: 18 }} className="muted">
        <li>Every create, update and delete on every page and tab, including bulk imports (one entry per import), cascaded deletes, and file uploads on the record.</li>
        <li>Blocked attempts (“Denied”), sign-in and sign-out, role and permission changes, Studio / schema changes, notification settings, automatic clock-outs and online payments.</li>
        <li>Not logged: just viewing or downloading a page, and “mark as read” on notifications.</li>
      </ul>
      <div className="table-wrap"><table className="resp-table"><thead><tr><th>Section</th><th>Entries</th><th>Last change</th></tr></thead>
        <tbody>{list.map((r) => <tr key={r.name} data-testid="coverage-row"><td data-label="Section"><b>{r.name}</b></td><td data-label="Entries">{r.n || <span className="muted">none yet</span>}</td><td data-label="Last change">{r.last ? new Date(r.last).toLocaleString() : '—'}</td></tr>)}</tbody></table></div>
    </div>
  );
}

export default function AuditModule() {
  const [selected, setSelected] = useState(null);
  const { tabAllowed } = useApp();
  const [tab, setTab] = useState('log');
  const phone = usePhone();
  const docked = !!selected && !phone;   // a computer: the entry opens beside the list
  return (
    <div className={docked ? 'list-docked' : undefined}>
      <div className="page-head">
        <div>
          <h1>Audit trail</h1>
          <p>Every create, update, delete and blocked attempt — with the exact fields that changed. Newest first.</p>
        </div>
      </div>

      <SegTabs label="Audit trail views" value={tab} onChange={setTab} tabs={[{ key: 'log', label: 'Trail' }, { key: 'coverage', label: 'Coverage' }].filter((t) => tabAllowed(`audit.${t.key}`))} />
      {tab === 'coverage' && <Coverage />}
      {tab === 'log' && <div className="card">
        <ServerTable
          collection={COLLECTIONS.AUDIT}
          columns={COLUMNS}
          baseSort={{ key: 'when', dir: 'desc' }}
          filters={[
            { key: 'action', label: 'All actions', options: ['Create', 'Update', 'Delete', 'Denied', 'Sign-in', 'Sign-out'] },
            { key: 'what', label: 'All sections', options: ['Maintenance', 'Properties & Residents', 'Billing & Finance', 'Amenities', 'Documents', 'Communications', 'Vendors', 'Utility Readings', 'Inventory', 'Ticket Discussion', 'Task Types', 'Quotations', 'Category Coverage', 'Payments Cross-check', 'Users', 'Roles & Permissions', 'Sign-in', 'Notification Settings', 'Attendance', 'Cultural Donations'] },
          ]}
          dateFields={[{ key: 'when', label: 'Date' }]}
          searchKeys={['who', 'what', 'action', 'summary', 'recordShortId']}
          onRowClick={setSelected}
          rowClassName={(a) => (a.id === selected?.id ? 'row-sel' : '')}
          cardsAlways={docked}
        />
      </div>}

      {selected && (
        <Modal dock title="Audit entry" subtitle="Who did what, when, and exactly which fields changed." onClose={() => setSelected(null)}>
          <ul className="list">
            <li><span>When</span><b>{new Date(selected.when).toLocaleString()}</b></li>
            <li><span>Who</span><b>{selected.who}</b></li>
            <li><span>Section</span><b>{selected.what}</b></li>
            <li><span>Action</span><b>{selected.action}</b></li>
            <li><span>Record</span><b>{selected.summary}</b></li>
            <li><span>Id</span><b className="mono">{selected.recordShortId || '—'}</b></li>
            {selected.unit && <li><span>Unit</span><b>{selected.unit}</b></li>}
          </ul>
          {(selected.action === 'Update' || ((selected.action === 'Create' || selected.action === 'Delete') && (selected.changes || []).length > 0)) ? (<><h3 style={{ margin: '14px 0 6px' }}>{selected.action === 'Update' ? 'Changed fields' : selected.action === 'Create' ? 'Values when created' : 'Values when deleted'}</h3><ChangesList changes={selected.changes} /></>) : <p className="muted" style={{ marginTop: 12 }}>{selected.action === 'Denied' ? selected.summary : `Record ${selected.action === 'Create' ? 'created' : 'deleted'}.`}</p>}
        </Modal>
      )}
    </div>
  );
}
