import { categoryFor, repairKindOf } from '../../lib/assets/repairKind.js';
import React, { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import { AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { TICKET_CATEGORIES } from '../../lib/schema/registry.js';
import { uuid } from '../../lib/uuid.js';
import { assigneesForCategory, creatableTaskTypes, isInternalType, pickAssignee, todayIso } from '../tickets/ticketEngine.js';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';

const plainDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const label = () => new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export { categoryFor, repairKindOf } from '../../lib/assets/repairKind.js';

/**
 * Raise a maintenance task from an asset. The task keeps the asset id, so the asset shows "Under repair" while it is open,
 * its cost rolls up to the asset, and closing it asks whether the asset is working again.
 */
export default function AssetTaskDialog({ asset, source = '', onClose, onDone, impact = null, mapPoint = null }) {
  const { roleId, role, roles, currentUser } = useApp();
  const { records: tickets, save: saveTicket } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const { records: taskTypes } = useCollection(COLLECTIONS.TASK_TYPES, 'Task Types');
  const { records: coverage } = useCollection(COLLECTIONS.CATEGORY_MAP, 'Category Coverage');
  const { records: vendors } = useCollection(COLLECTIONS.VENDORS, 'Vendors');
  const { records: ecRoles } = useCollection(COLLECTIONS.EC_ROLES, 'EC Roster');
  const { records: handymen } = useCollection(COLLECTIONS.HANDYMEN, 'Field Staff');
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users');
  const { save: saveLog } = useCollection(COLLECTIONS.INFRA_LOG, 'Condition log');
  const types = useMemo(() => creatableTaskTypes(taskTypes, role), [taskTypes, role]);
  const cats = useMemo(() => [...new Set([...TICKET_CATEGORIES, ...coverage.map((c) => c.category).filter(Boolean)])], [coverage]);
  const me = currentUser?.name || role?.name || '';
  const same = tickets.filter((t) => t.assetId === asset.id && !['Closed', 'Cancelled'].includes(t.status));
  const [typeName, setTypeName] = useState('');
  const [category, setCategory] = useState(() => repairKindOf(asset, TICKET_CATEGORIES));
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(asset.status === 'Out of service' ? 'High' : 'Medium');
  const [sla, setSla] = useState(plainDays(3));
  const [assignedTo, setAssignedTo] = useState('');
  const [pending, setPending] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const typeSel = typeName || types.find((t) => /maint|repair|facility|general/i.test(t.name))?.name || types[0]?.name || '';
  const tt = types.find((t) => t.name === typeSel);
  const internal = isInternalType(tt);
  const needsPick = tt?.assignmentMode === 'Direct assign' || internal;
  const pool = assigneesForCategory({ category, internal, coverage, vendors, ecRoles, handymen, users, roles });

  async function go() {
    if (!tt) { setErr('Your role cannot raise a maintenance task'); return; }
    if (title.trim().length < 3) { setErr('Say what is wrong in the title'); return; }
    if (!category) { setErr('Pick a category'); return; }
    if (needsPick && !assignedTo) { setErr('Pick who it is assigned to'); return; }
    if (!sla || sla < todayIso()) { setErr('SLA due must be today or a future date'); return; }
    setBusy(true);
    try {
      let status = 'Open'; let who = '';
      if (needsPick) { status = 'Assigned'; who = assignedTo; }
      else { const a = pickAssignee(handymen, tickets, category); if (a) { status = 'Assigned'; who = a.name; } }
      const id = uuid();
      const metas = pending.length ? await persistPending(pending, { ownerType: 'ticket', ownerId: id }) : [];
      if (!metas) { setBusy(false); return; }
      const where0 = [asset.area, asset.location].filter(Boolean).join(' / ');
      const geoLL = mapPoint?.geo ? mapPoint.geo.toLL(mapPoint.x, mapPoint.y) : null;
      const spot = mapPoint ? `Site map position ${mapPoint.x}, ${mapPoint.y}${geoLL ? ` (${geoLL[0].toFixed(5)}, ${geoLL[1].toFixed(5)})` : ''}${mapPoint.away && asset.id ? `, ${mapPoint.away} from ${asset.name}` : ''}` : '';
      const where = [where0, spot].filter(Boolean).join(' / ');
      const affected = impact?.units || [];
      const intro = [spot && `<p><b>Reported from the site map:</b> ${spot}.</p>`, impact?.valve && `<p><b>Close first:</b> ${impact.valve.name}.</p>`, affected.length && `<p><b>Affected (${affected.length}):</b> ${affected.slice(0, 40).join(', ')}${affected.length > 40 ? '…' : ''}</p>`].filter(Boolean).join('');
      const saved = await saveTicket({
        id, taskType: typeSel, title: `${asset.name}: ${title.trim()}`, description: (isEmptyHtml(description) ? '' : description) + intro,
        unit: 'Common area', category, subCategory: '', priority, status, assignedTo: who, slaDueAt: sla, scope: 'Community', location: where || asset.name, affectedUnits: affected,
        attachments: metas, hasPhotos: metas.some((m) => /^image\//.test(m.type || m.mimeType || '')), awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 0,
        createdBy: me, createdByRole: roleId, createdAt: label(), ...(asset.id ? { assetId: asset.id, assetName: asset.name, assetRef: asset.shortId || '' } : {}), source,
      });
      if (!saved) { setBusy(false); setErr('The task could not be saved. You may not be allowed to raise tasks.'); return; }
      if (asset.id) await saveLog({ assetId: asset.id, assetName: asset.name, date: todayIso(), condition: 'Under repair', source: 'Task opened', note: `${asset.name}: ${title.trim()}`, by: me, ticketId: saved.id });
      setBusy(false);
      onDone?.(saved);
    } catch (e) { setErr(e?.message || String(e)); } finally { setBusy(false); }
  }

  return (
    <Modal title="Raise a maintenance task" subtitle={`For ${asset.name}. The task stays linked to the asset.`} onClose={onClose}>
      <div className="form-grid" data-testid="asset-task-dialog">
        {same.length > 0 && (
          <div className="notice" style={{ background: "#fff8e6", borderColor: "#f3dc9c", color: "#8a5a00", gridColumn: '1 / -1' }} data-testid="asset-task-dup">
            {same.length === 1 ? 'A task is already open on this asset' : `${same.length} tasks are already open on this asset`}: {same.map((t) => `${t.ticketNumber || ''} ${t.title}`).join('; ')}. Check it is not the same fault before adding another.
          </div>
        )}
        {(impact?.valve || (impact?.units || []).length > 0) && (
          <div className="notice" style={{ gridColumn: '1 / -1' }} data-testid="asset-task-impact">
            {(impact.units || []).length > 0 && <div><b>{impact.units.length}</b> unit{impact.units.length === 1 ? '' : 's'} will be marked as affected{impact.blocks?.length ? ` (${impact.blocks.join(', ')})` : ''}.</div>}
            {impact.valve && <div>🚰 The task will say: close <b>{impact.valve.name}</b> first.</div>}
          </div>
        )}
        <div className="field"><label>Asset</label><input aria-label="Asset" data-testid="asset-task-asset" value={`${asset.name}${asset.shortId ? ` · ${asset.shortId}` : ''}`} disabled readOnly /></div>
        <div className="field"><label>Location</label><input aria-label="Location" data-testid="asset-task-location" value={[asset.area, asset.location].filter(Boolean).join(' / ') || 'Common area'} disabled readOnly /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>What is wrong *</label>
          <div className="gg-row" style={{ flexWrap: 'nowrap' }}><span className="tag" data-testid="asset-task-prefix" style={{ whiteSpace: 'nowrap', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{asset.name}:</span><input aria-label="Task title" data-testid="asset-task-title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ flex: 1 }} /></div>
        </div>
        <div className="field"><label>Task type</label>
          <select aria-label="Task type" value={typeSel} onChange={(e) => { setTypeName(e.target.value); setAssignedTo(''); }}>{types.map((t) => <option key={t.id} value={t.name}>{t.icon ? `${t.icon} ` : ''}{t.name}</option>)}</select>
        </div>
        <div className="field"><label>Category (the asset's kind of repair)</label>
          <select aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setAssignedTo(''); }}><option value="">— pick —</option>{cats.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        <div className="field"><label>Priority</label>
          <select aria-label="Priority" value={priority} onChange={(e) => setPriority(e.target.value)}>{['Low', 'Medium', 'High', 'Critical'].map((p) => <option key={p}>{p}</option>)}</select>
        </div>
        <div className="field"><label>SLA due</label><input type="date" aria-label="SLA due" min={todayIso()} value={sla} onChange={(e) => setSla(e.target.value)} /></div>
        {needsPick && (
          <div className="field"><label>Assigned to</label>
            <select aria-label="Assigned to" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}><option value="">— pick —</option>{pool.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
          </div>
        )}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Details</label><RichTextEditor value={description} onChange={setDescription} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Photos</label><AttachmentPicker pending={pending} onChange={setPending} /></div>
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }} data-testid="asset-task-error">{err}</div>}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" data-testid="asset-task-go" disabled={busy} onClick={go}>{busy ? 'Creating…' : 'Create task'}</button>
        </div>
      </div>
    </Modal>
  );
}
