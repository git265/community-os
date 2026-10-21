import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import ServerTable from '../../components/ServerTable.jsx';
import AdminDelete from '../../components/AdminDelete.jsx';
import DynamicForm from '../../components/DynamicForm.jsx';
import Modal from '../../components/Modal.jsx';
import { peopleOf, ownersOf } from '../../lib/people.js';
import { accessImpact } from '../../lib/propertyServer.js';
import { phoneKey, validatePhone } from '../../lib/phone.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { uuid } from '../../lib/uuid.js';
import { DueDetailModal, PayDueModal } from '../../components/PayDue.jsx';
import { creditBalance, todayIso } from '../../lib/finance/rules.js';
import { money as fmtMoney } from '../../lib/locale.js';
import TicketsModule from '../tickets/TicketsModule.jsx';
import BookingDetail from '../amenities/BookingDetail.jsx';
import FilePreview from '../../components/FilePreview.jsx';
import SettleDues from './SettleDues.jsx';
import DocumentPreview from '../../components/DocumentPreview.jsx';
import { unitStatement } from '../../lib/documents/builders.js';
import { fyStartMonth } from '../../lib/locale.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'dues', label: 'Dues' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'documents', label: 'Documents' },
  { id: 'amenities', label: 'Amenities' },
  { id: 'activity', label: 'Activity' },
];

const money = (n) => fmtMoney(n);
const phoneLink = (p) => (p ? <a href={`tel:${p}`} onClick={(e) => e.stopPropagation()}>{p}</a> : '—');

/** One villa/unit: summary + Dues / Tickets / Documents / Amenities (+ Activity for the EC). Click any row for its details. */
/** Read-only details of any record, shown with the same schema-driven fields as its own screen. */
function RecordDetailModal({ collection, record, title, onClose, extra = null }) {
  const { roleId, schemaFor } = useApp();
  const schema = schemaFor(collection);
  if (!schema) return null;
  return (
    <Modal title={title} subtitle="Details (read-only)." onClose={onClose}>
      {extra}
      <DynamicForm schema={schema} roleId={roleId} record={record} readOnly onSave={() => {}} onCancel={onClose} />
    </Modal>
  );
}

/** Pick a period, preview and print a unit's statement of account. */
function StatementDialog({ unit, onClose }) {
  const today = todayIso();
  const fy = (() => { const m = fyStartMonth(); const y = new Date().getFullYear() - (new Date().getMonth() + 1 < m ? 1 : 0); return `${y}-${String(m).padStart(2, '0')}-01`; })();
  const [from, setFrom] = useState(fy); const [to, setTo] = useState(today); const [html, setHtml] = useState('');
  async function make() { setHtml(await unitStatement(unit, from, to)); }
  if (html) return <DocumentPreview title={`Statement · ${unit}`} html={html} fileName={`statement-${unit}`} onClose={onClose} />;
  return (
    <Modal title={`Statement of account · ${unit}`} subtitle="Bills, payments, advances and the running balance for a period." onClose={onClose}>
      <div className="form-grid">
        <div className="field"><label>From</label><input type="date" data-testid="st-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="field"><label>To</label><input type="date" data-testid="st-to" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></div>
      </div>
      <div className="form-actions"><button type="button" className="btn" data-testid="st-make" onClick={make}>Prepare statement</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function ActivityDetailModal({ entry, onClose }) {
  return (
    <Modal title={`${entry.what} · ${entry.action}`} subtitle="Who changed what, and when." onClose={onClose}>
      <div className="ro-block">
        <div className="kv"><span>When</span><b>{new Date(entry.when).toLocaleString()}</b><span>By</span><b>{entry.who}</b><span>Record</span><b>{entry.recordShortId || '—'}</b><span>Summary</span><b>{entry.summary || '—'}</b></div>
      </div>
      {entry.changes?.length > 0 && (
        <table className="changes"><thead><tr><th>Field</th><th>From</th><th>To</th></tr></thead>
          <tbody>{entry.changes.map((c, i) => <tr key={i}><td>{c.label}</td><td>{c.from}</td><td>{c.to}</td></tr>)}</tbody></table>
      )}
      <div className="form-actions"><button className="btn secondary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

function UnitDetail({ unit, onEdit, canEdit, canSeePrivate }) {
  const { role, roleId, currentUser, hasPermission } = useApp();
  const [tab, setTab] = useState('overview');
  const [detail, setDetail] = useState(null); // { kind, rec }
  const isEC = role?.category === 'EC';
  const isResident = role?.category === 'Resident';
  const finance = roleId === 'super_admin' || hasPermission('MANAGE_DUES') || hasPermission('MANAGE_UTILITY_BILLING');
  const canPayRow = (d) => !['Paid', 'Cancelled'].includes(d.status) && ((!!currentUser?.unit && d.unit === currentUser.unit) || (!isResident && finance));   // their own unit's: any owner, a committee member too
  const tabs = TABS.filter((t) => t.id !== 'activity' || isEC); // activity trail is for the EC only
  // only THIS unit's rows are read (a server query filtered on the unit), not every bill, task, document and booking of the community
  const dues = useUnitRows(COLLECTIONS.DUES, unit.unit);
  const tickets = useUnitRows(COLLECTIONS.TICKETS, unit.unit);
  const documents = useUnitRows(COLLECTIONS.DOCUMENTS, unit.unit);
  const bookings = useUnitRows(COLLECTIONS.AMENITIES, unit.unit);
  const credits = useUnitRows(COLLECTIONS.UNIT_CREDITS, unit.unit);
  const { save: saveBooking } = useCollection(COLLECTIONS.AMENITIES, 'Amenities');
  // the amenity catalogue and settings: only when a booking is opened
  const { records: catalog } = useCollection(COLLECTIONS.AMENITY_TYPES, 'Amenity Catalog', { enabled: detail?.kind === 'booking' });
  const { records: amSettings } = useCollection(COLLECTIONS.AMENITY_SETTINGS, 'Amenity Settings', { enabled: detail?.kind === 'booking' });

  // Portal access of each person (signed up, invited, deactivated) needs the users list: read only when asked for
  const [showPortal, setShowPortal] = useState(false);
  const [portalUsers, setPortalUsers] = useState([]);
  useEffect(() => { setShowPortal(false); setPortalUsers([]); }, [unit.id]);
  useEffect(() => { if (canEdit && showPortal) secureStorage.list(COLLECTIONS.USERS).then(setPortalUsers).catch(() => {}); }, [canEdit, showPortal, unit.id, unit.ownerPhone, unit.tenantPhone, unit.people]);
  const mine = (list) => list.filter((r) => r.unit === unit.unit);
  const myDues = mine(dues), myTickets = mine(tickets), myDocs = mine(documents), myBookings = mine(bookings);
  const unpaid = myDues.filter((d) => !['Paid', 'Cancelled'].includes(d.status));
  const openTickets = myTickets.filter((t) => !['Closed', 'Cancelled'].includes(t.status));

  const today = todayIso();
  const sum = (l) => l.reduce((n, d) => n + (Number(d.amount) || 0), 0);
  const overdue = unpaid.filter((d) => d.dueDate && d.dueDate < today);
  const penalty = unpaid.filter((d) => d.category === 'Late fee');
  const advance = Math.max(0, creditBalance(credits, unit.unit));
  const held = myBookings.filter((b) => b.depositStatus === 'Held');
  const isStaff = !isResident && (hasPermission('MANAGE_AMENITIES') || isEC || roleId === 'super_admin');
  const ownUnit = !!currentUser?.unit && unit.unit === currentUser.unit;
  const canSettle = unpaid.length > 0 && (ownUnit || (!isResident && finance));

  const tag = (v, cls = '') => <span className={`tag ${cls}`}>{v}</span>;

  return (
    <div>
      <div className="property-title">
        <div>
          <h2 style={{ margin: 0 }}>{unit.unit} {unit.occupancy && <span className="tag">{unit.occupancy}</span>}</h2>
          <div className="muted">{[unit.zone, unit.bedrooms ? `${unit.bedrooms} BHK` : '', unit.areaSqft ? `${unit.areaSqft} sq ft` : '', unit.owner].filter(Boolean).join(' · ')}</div>
        </div>
        {canEdit && <button className="btn secondary" onClick={() => onEdit(unit)}>Edit</button>}
      </div>

      <div className="tabs">
        {tabs.map((t) => <button key={t.id} className={t.id === tab ? 'active' : ''} onClick={() => setTab(t.id)}>{t.label}</button>)}
      </div>

      {tab === 'overview' && (
        <>
          <div className="people">
            <div className="person" data-testid="unit-people">
              <small className="muted">OWNERS &amp; OCCUPANTS</small>
              {peopleOf(unit).map((x) => {
                const u = portalUsers.find((y) => y.phone && phoneKey(y.phone) === phoneKey(x.phone));
                const st = !x.phone ? '' : u ? (u.status === 'Active' ? 'Active' : u.status === 'Invited' ? 'Invited' : 'Deactivated') : 'No account';
                return (
                  <div key={x.slot} style={{ marginTop: 4 }}>
                    <b>{x.name}</b> <small className="muted">· {x.relation}</small>{x.phone && <> · {phoneLink(x.phone)}</>}
                    {canEdit && showPortal && st && <span className={`tag ${st === 'Active' ? 'green' : st === 'Invited' ? 'blue' : 'red'}`} style={{ marginLeft: 6 }} title="Portal access for this phone number">{st === 'Invited' ? 'Invite sent' : `Portal: ${st}`}</span>}
                  </div>
                );
              })}
              {canEdit && !showPortal && peopleOf(unit).some((x) => x.phone) && <button type="button" className="link-btn" data-testid="portal-show" style={{ display: 'block', marginTop: 4 }} onClick={() => setShowPortal(true)}>Show portal access</button>}
              <small className="muted" style={{ display: 'block', marginTop: 6 }}>{ownersOf(unit).length > 1 ? `${ownersOf(unit).length} owners — any one of them can cast the villa's single e-vote.` : 'One vote per villa in e-voting (owners only).'}</small>
            </div>
            <div className="person">
              <small className="muted">RESIDENTS & VEHICLES</small><br />
              {unit.residentsCount || 0} resident{unit.residentsCount === 1 ? '' : 's'}<br />
              <span className="muted">{unit.vehiclesCount || 0} vehicle{unit.vehiclesCount === 1 ? '' : 's'} · {unit.domesticStaffCount || 0} domestic staff</span>
            </div>
          </div>
          {canSeePrivate && (
            <div className="unit-cards">
              <button className="unit-card" onClick={() => setTab('dues')}><small className="muted">DUES OUTSTANDING</small><b>{money(unpaid.reduce((s, d) => s + (Number(d.amount) || 0), 0))}</b><small className="muted">{unpaid.length} unpaid</small></button>
              <button className="unit-card" onClick={() => setTab('tickets')}><small className="muted">OPEN TICKETS</small><b>{openTickets.length}</b><small className="muted">{myTickets.length} total</small></button>
              <button className="unit-card" onClick={() => setTab('documents')}><small className="muted">DOCUMENTS</small><b>{myDocs.length}</b></button>
              <button className="unit-card" onClick={() => setTab('amenities')}><small className="muted">BOOKINGS</small><b>{myBookings.length}</b></button>
              {isEC && <button className="unit-card" onClick={() => setTab('activity')}><small className="muted">ACTIVITY</small><b>Recent →</b></button>}
            </div>
          )}
        </>
      )}

      {tab !== 'overview' && !canSeePrivate && <div className="empty">This unit's {tab} are private.</div>}

      {canSeePrivate && tab === 'dues' && (
        <>
          <div className="unit-cards dues-summary" data-testid="dues-summary">
            <div className="unit-card"><small className="muted">TOTAL DUES</small><b data-testid="sum-total">{money(sum(unpaid))}</b><small className="muted">{unpaid.length} unpaid bill(s)</small></div>
            <div className="unit-card"><small className="muted">OVERDUE</small><b className={overdue.length ? 'due-over' : ''} data-testid="sum-overdue">{money(sum(overdue))}</b><small className="muted">{overdue.length} past due date</small></div>
            <div className="unit-card"><small className="muted">PENALTY</small><b data-testid="sum-penalty">{money(sum(penalty))}</b><small className="muted">late fees outstanding</small></div>
            <div className="unit-card"><small className="muted">ADVANCE</small><b className={advance ? 'ok' : ''} data-testid="sum-advance">{money(advance)}</b><small className="muted">credit on account</small></div>
            <div className="unit-card"><small className="muted">SECURITY DEPOSIT</small><b data-testid="sum-deposit">{money(sum(held.map((b) => ({ amount: b.depositAmount }))))}</b><small className="muted">{held.length} held for bookings</small></div>
          </div>
          <div style={{ margin: '10px 0', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn secondary" data-testid="statement-open" onClick={() => setDetail({ kind: 'statement' })}>📄 Statement</button>
            {canSettle && <button type="button" className="btn" data-testid="settle-dues" onClick={() => setDetail({ kind: 'settle' })}>{isResident || ownUnit ? 'Pay all dues' : 'Settle dues'}</button>}
          </div>
          {false && <div style={{ margin: '10px 0' }}><button type="button" className="btn" data-testid="settle-dues" onClick={() => setDetail({ kind: 'settle' })}>{isResident ? 'Pay all dues' : 'Settle dues'}</button></div>}
          <ServerTable compact search={false} collection={COLLECTIONS.DUES} baseFilters={{ unit: unit.unit }} baseSort={{ key: 'dueDate', dir: 'desc' }} pageSizeDefault={10}
            onRowClick={(d) => setDetail({ kind: 'due', rec: d })}
            columns={[
              { key: 'shortId', label: 'Bill #' },
              { key: 'category', label: 'Category' },
              { key: 'billedMonth', label: 'Month' },
              { key: 'amount', label: 'Amount', render: (d) => money(d.amount) },
              { key: 'dueDate', label: 'Payable by', render: (d) => <span className={d.status !== 'Paid' && d.dueDate && d.dueDate < today ? 'due-over' : ''}>{d.dueDate || '—'}</span> },
              { key: 'status', label: 'Status', render: (d) => tag(d.status, d.status === 'Paid' ? 'green' : 'red') },
              { key: 'pay', label: '', sortable: false, render: (d) => (canPayRow(d) ? <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); setDetail({ kind: 'pay', rec: d }); }}>{isResident ? 'Pay now' : 'Record payment'}</button> : null) },
            ]} emptyText="No dues recorded for this unit." />
        </>
      )}
      {canSeePrivate && tab === 'tickets' && (
        <ServerTable compact search={false} collection={COLLECTIONS.TICKETS} baseFilters={{ unit: unit.unit }} baseSort={{ key: 'recordCreatedAt', dir: 'desc' }} pageSizeDefault={10}
          onRowClick={(t) => setDetail({ kind: 'ticket', rec: t })}
          columns={[
            { key: 'ticketNumber', label: 'Ticket #' },
            { key: 'title', label: 'Issue' },
            { key: 'category', label: 'Category' },
            { key: 'assignedTo', label: 'Assigned', render: (t) => t.assignedTo || 'Unassigned' },
            { key: 'status', label: 'Status', render: (t) => tag(t.status) },
          ]} emptyText="No maintenance tickets for this unit." />
      )}
      {canSeePrivate && tab === 'documents' && (
        <ServerTable compact search={false} collection={COLLECTIONS.DOCUMENTS} baseFilters={{ unit: unit.unit }} pageSizeDefault={10}
          onRowClick={(d) => setDetail({ kind: 'doc', rec: d })}
          columns={[
            { key: 'shortId', label: 'Doc #' },
            { key: 'title', label: 'Document' },
            { key: 'category', label: 'Category' },
            { key: 'version', label: 'Version' },
            { key: 'access', label: 'Group', render: (d) => d.access ?? '—' },
          ]} emptyText="No documents linked to this unit." />
      )}
      {canSeePrivate && tab === 'amenities' && (
        <ServerTable compact search={false} collection={COLLECTIONS.AMENITIES} baseFilters={{ unit: unit.unit }} baseSort={{ key: 'date', dir: 'desc' }} pageSizeDefault={10}
          onRowClick={(b) => setDetail({ kind: 'booking', rec: b })}
          columns={[
            { key: 'shortId', label: 'Booking #' },
            { key: 'amenity', label: 'Amenity' },
            { key: 'date', label: 'Date' },
            { key: 'slot', label: 'Slot' },
            { key: 'status', label: 'Status', render: (b) => tag(b.status) },
          ]} emptyText="No bookings for this unit." />
      )}
      {canSeePrivate && isEC && tab === 'activity' && (
        <>
          <div className="tab-head"><b>Activity for {unit.unit}</b><span className="muted">What changed, who changed it, and when</span></div>
          <ServerTable compact search={false} collection={COLLECTIONS.AUDIT} baseFilters={{ unit: unit.unit }} baseSort={{ key: 'when', dir: 'desc' }} pageSizeDefault={10}
            onRowClick={(a) => setDetail({ kind: 'activity', rec: a })}
            dateFields={[{ key: 'when', label: 'Date' }]}
            columns={[
              { key: 'when', label: 'When', render: (a) => new Date(a.when).toLocaleString() },
              { key: 'who', label: 'By' },
              { key: 'what', label: 'Area' },
              { key: 'action', label: 'Action', render: (a) => tag(a.action, a.action === 'Denied' ? 'red' : 'blue') },
              { key: 'changes', label: 'What changed', sortable: false, render: (a) => (a.changes?.length ? a.changes.map((c) => `${c.label}: ${c.from} → ${c.to}`).join('; ') : a.summary) },
            ]} emptyText="No recorded activity yet." />
        </>
      )}
      {detail?.kind === 'due' && <DueDetailModal due={detail.rec} onClose={() => setDetail(null)} />}
      {detail?.kind === 'pay' && <PayDueModal due={detail.rec} onClose={() => setDetail(null)} />}
      {detail?.kind === 'statement' && <StatementDialog unit={unit.unit} onClose={() => setDetail(null)} />}
      {detail?.kind === 'settle' && <SettleDues unit={unit.unit} dues={myDues} credit={advance} resident={isResident || ownUnit} onClose={() => setDetail(null)} />}
      {detail?.kind === 'ticket' && <TicketsModule embeddedRef={detail.rec.ticketNumber || detail.rec.id} onEmbeddedClose={() => setDetail(null)} />}
      {detail?.kind === 'booking' && (() => { const live = bookings.find((x) => x.id === detail.rec.id) || detail.rec; return <BookingDetail booking={live} amenity={catalog.find((a) => a.name === live.amenity)} settings={amSettings[0] || {}} isStaff={isStaff} today={today} onClose={() => setDetail(null)} onAction={async (r) => !!(await saveBooking(r))} />; })()}
      {detail?.kind === 'doc' && <RecordDetailModal collection={COLLECTIONS.DOCUMENTS} record={detail.rec} title={`${detail.rec.shortId ? detail.rec.shortId + ' · ' : ''}${detail.rec.title}`} onClose={() => setDetail(null)} extra={detail.rec.fileId ? <p><button type="button" className="btn secondary" data-testid="doc-preview" onClick={() => setDetail({ kind: 'preview', rec: detail.rec })}>👁 Preview {detail.rec.fileName}</button></p> : null} />}
      {detail?.kind === 'preview' && <FilePreview meta={{ fileId: detail.rec.fileId, name: detail.rec.fileName || detail.rec.title, mime: detail.rec.mime || '', size: (detail.rec.fileSize || 0) * 1024 }} onClose={() => setDetail({ kind: 'doc', rec: detail.rec })} />}
      {detail?.kind === 'record' && <RecordDetailModal collection={detail.collection} record={detail.rec} title={detail.title} onClose={() => setDetail(null)} />}
      {detail?.kind === 'activity' && <ActivityDetailModal entry={detail.rec} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** One unit's rows of a collection, read with a server query filtered on the unit (re-read when the collection changes). */
function useUnitRows(collection, unit) {
  const [rows, setRows] = useState([]);
  useEffect(() => {
    let on = true;
    const go = () => secureStorage.query(collection, { page: 1, pageSize: 1000, filters: { unit } }).then((r) => { if (on) setRows(r?.rows || r?.items || []); }).catch(() => { if (on) setRows([]); });
    if (unit) go(); else setRows([]);
    const h = (e) => { if (e.detail?.collection === collection && unit) go(); };
    window.addEventListener('communityos:changed', h);
    return () => { on = false; window.removeEventListener('communityos:changed', h); };
  }, [collection, unit]);
  return rows;
}

export default function PropertiesModule({ onNavigate }) {
  const { roleId, role, currentUser, schemaFor, tabAllowed } = useApp();
  const { records: properties, save } = useCollection(COLLECTIONS.PROPERTIES, 'Properties & Residents');
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} | record
  const [viewRaw, setView] = useState('units');
  const view = tabAllowed(`properties.${viewRaw}`) ? viewRaw : (tabAllowed('properties.units') ? 'units' : 'owners');
  const [showDirectory, setShowDirectory] = useState(false);

  const isResident = role?.category === 'Resident';
  const schema = schemaFor(COLLECTIONS.PROPERTIES);
  const canCreate = canWriteCollection(COLLECTIONS.PROPERTIES, getPrincipal());
  const myProperty = useMemo(() => properties.find((p) => p.unit === currentUser?.unit) ?? null, [properties, currentUser]);
  if (!schema) return null;
  const selected = isResident ? null : properties.find((p) => p.id === selectedId) ?? null;

  const directoryColumns = [
    { key: 'unit', label: 'Unit', render: (p) => <b>{p.unit}</b> },
    { key: 'owner', label: 'Owner', render: (p) => <span>{p.owner}</span> },
    { key: 'ownerPhone', label: 'Phone', render: (p) => phoneLink(p.ownerPhone) },
    { key: 'call', label: '', sortable: false, render: (p) => (p.ownerPhone ? <a className="call-btn" href={`tel:${p.ownerPhone}`} aria-label={`Call ${p.owner || p.ownerPhone}`} title="Call" onClick={(e) => e.stopPropagation()}>📞</a> : null) },
  ];

  // old records kept a "secondary owner" in two columns: show it as the first additional owner
  const openEditor = (rec) => setEditing(rec && rec.id && !Array.isArray(rec.people) && rec.secondaryOwner
    ? { ...rec, people: [{ id: uuid(), relation: 'Additional owner', name: rec.secondaryOwner, phone: rec.secondaryOwnerPhone || '', email: '' }] } : rec);

  async function saveProperty(draft) {
    const saved = await save(draft);
    if (saved) setEditing(null);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{isResident ? 'My home & directory' : 'Properties & residents'}</h1>
          <p>{isResident ? 'Your home and the community contact directory.' : 'A unified record for every villa and apartment.'}</p>
        </div>
        {canCreate && <button className="btn" onClick={() => setEditing({})}>+ Add property</button>}
      </div>

      {isResident && (
        <>
          {myProperty ? (
            <div className="card" style={{ marginBottom: 16 }}>
              <UnitDetail unit={myProperty} canSeePrivate canEdit={false} />
            </div>
          ) : (
            <div className="notice">No home is linked to this login.</div>
          )}
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div>
                <h2 style={{ margin: 0 }}>Contact directory</h2>
                <p className="muted" style={{ margin: '2px 0 0' }}>Name and phone number of every home in the community.</p>
              </div>
              <button className="btn secondary" onClick={() => setShowDirectory((v) => !v)}>{showDirectory ? 'Hide directory' : 'View all contacts'}</button>
            </div>
            {showDirectory && (
              <div style={{ marginTop: 12 }}>
                <ServerTable
                  collection={COLLECTIONS.PROPERTIES}
                  columns={directoryColumns}
                  baseSort={{ key: 'unit', dir: 'asc' }}
                  searchKeys={['unit', 'owner', 'ownerPhone', 'zone']}
                  filters={[{ key: 'type', label: 'All types', options: ['Villa', 'Apartment'] }]}
                />
              </div>
            )}
          </div>
        </>
      )}

      {!isResident && (
        <>
          <div className="tabs" style={{ margin: '0 0 4px' }}>
            {tabAllowed('properties.units') && <button className={view === 'units' ? 'active' : ''} onClick={() => setView('units')}>Units</button>}
            {tabAllowed('properties.owners') && <button className={view === 'owners' ? 'active' : ''} onClick={() => setView('owners')}>Owners</button>}
          </div>
          <div className="card">
            {view === 'units' ? (
              <ServerTable
                collection={COLLECTIONS.PROPERTIES}
                schema={schema}
                showId
                baseSort={{ key: 'unit', dir: 'asc' }}
                filters={[
                  { key: 'type', label: 'All property types' },
                  { key: 'occupancy', label: 'All occupancy' },
                  { key: 'zone', label: 'All zones', options: [...new Set(properties.map((p) => p.zone).filter(Boolean))].sort() },
                ]}
                dateFields={[{ key: 'possessionDate', label: 'Possession date' }]}
                onRowClick={(r) => setSelectedId(r.id)}
              />
            ) : (
              <ServerTable
                collection={COLLECTIONS.PROPERTIES}
                columns={[
                  { key: 'owner', label: 'Primary owner', render: (p) => <b>{p.owner}</b> },
                  { key: 'ownerPhone', label: 'Phone', render: (p) => phoneLink(p.ownerPhone) },
                  { key: 'tenant', label: 'Tenant', render: (p) => (p.tenant ? <span>{p.tenant} <small className="muted">{p.tenantPhone}</small></span> : '—') },
                  { key: 'people', label: 'Additional owners / contacts', sortable: false, render: (p) => ((p.people || []).length ? (p.people || []).map((x) => x.name).join(', ') : (p.secondaryOwner || '—')) },
                  { key: 'unit', label: 'Unit' },
                ]}
                baseSort={{ key: 'owner', dir: 'asc' }}
                searchKeys={['owner', 'tenant', 'unit', 'ownerPhone']}
              />
            )}
          </div>
        </>
      )}

      {selected && (
        <Modal title={selected.unit} subtitle="Owner, occupancy and unit details." onClose={() => setSelectedId(null)}>
          <div style={{ textAlign: 'right' }}><AdminDelete collection={COLLECTIONS.PROPERTIES} id={selected.id} label="property" onDone={() => setSelectedId(null)} /></div>
          <UnitDetail unit={selected} canSeePrivate canEdit={canCreate} onEdit={(u) => { setSelectedId(null); openEditor(u); }} />
        </Modal>
      )}

      {editing && (
        <Modal title={editing.id ? `Edit ${editing.unit}` : 'Add a unit to the directory'} subtitle="Register a villa or apartment with its owner and occupancy details." onClose={() => setEditing(null)}>
          <DynamicForm schema={schema} roleId={roleId} record={editing} onSave={saveProperty} onCancel={() => setEditing(null)} impact={(draft) => accessImpact(editing.id ? editing : null, draft)} />
        </Modal>
      )}
    </div>
  );
}
