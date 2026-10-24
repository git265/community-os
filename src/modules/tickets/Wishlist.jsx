import { localDay } from '../../lib/locale.js';
import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import RichText from '../../components/RichText.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import { Chips, Segmented } from '../../components/ui.jsx';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { tell } from '../../lib/net/activity.js';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';
import { TICKET_CATEGORIES } from '../../lib/schema/registry.js';
import { uuid } from '../../lib/uuid.js';
import { assigneesForCategory, isInternalType, todayIso } from './ticketEngine.js';

const OPEN = ['Submitted', 'Under review'];
const STATUSES = ['Submitted', 'Under review', 'Planned', 'Done', 'Declined'];
const TONE = { Submitted: 'blue', 'Under review': 'amber', Planned: 'green', Done: 'green', Declined: 'red', Withdrawn: '' };
const label = () => new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const plainDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d); };

/**
 * Wishlist: ideas raised by residents or the EC. One vote per villa. The EC reviews, plans, declines (with a reason) or
 * converts an idea into a real task of any configured task type, keeping a link back to the idea.
 */
export default function Wishlist() {
  const { role, roleId, currentUser, hasPermission } = useApp();
  const { records: wishes, save: saveWish, remove: removeWish } = useCollection(COLLECTIONS.WISHES, 'Wishlist');
  const { save: saveTicket } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const { records: tickets } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const { records: taskTypes } = useCollection(COLLECTIONS.TASK_TYPES, 'Task Types');
  const { records: coverage } = useCollection(COLLECTIONS.CATEGORY_MAP, 'Category Coverage');
  const { records: vendors } = useCollection(COLLECTIONS.VENDORS, 'Vendors');
  const { records: ecRoles } = useCollection(COLLECTIONS.EC_ROLES, 'EC Roster');
  const { records: handymen } = useCollection(COLLECTIONS.HANDYMEN, 'Field Staff');
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users');
  const { roles } = useApp();

  const me = currentUser?.name || role?.name || '';
  const myUnit = currentUser?.unit || '';
  const isVendor = role?.category === 'Vendor';
  const canManage = role?.category === 'EC' || hasPermission('MANAGE_TICKETS') || roleId === 'super_admin';
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('votes');
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState({ title: '', description: '', category: '', location: '' });
  const [pending, setPending] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const categories = useMemo(() => [...new Set([...TICKET_CATEGORIES, ...coverage.map((c) => c.category).filter(Boolean)])], [coverage]);
  const visible = wishes.filter((w) => w.status !== 'Withdrawn' || w.raisedBy === me);
  const counts = { all: visible.filter((w) => w.status !== 'Withdrawn').length, open: visible.filter((w) => OPEN.includes(w.status)).length, Planned: visible.filter((w) => w.status === 'Planned').length, Done: visible.filter((w) => w.status === 'Done').length, Declined: visible.filter((w) => w.status === 'Declined').length, mine: visible.filter((w) => w.raisedBy === me).length };
  const list = visible
    .filter((w) => (filter === 'all' ? w.status !== 'Withdrawn' : filter === 'open' ? OPEN.includes(w.status) : filter === 'mine' ? w.raisedBy === me : w.status === filter))
    .sort((a, b) => (sort === 'votes' ? (b.votes || []).length - (a.votes || []).length : 0) || String(b.createdStamp || b.createdAt || '').localeCompare(String(a.createdStamp || a.createdAt || '')) || 0);
  const maxVotes = Math.max(0, ...wishes.map((w) => (w.votes || []).length));

  const hasVoted = (w) => !!myUnit && (w.votes || []).includes(myUnit);
  const votingOpen = (w) => !['Done', 'Declined', 'Withdrawn'].includes(w.status);
  async function toggleVote(w) {
    if (!myUnit || !votingOpen(w)) return;
    const votes = hasVoted(w) ? (w.votes || []).filter((u) => u !== myUnit) : [...(w.votes || []), myUnit];
    await saveWish({ ...w, votes });
  }

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!form.title.trim()) errs.title = 'Give your idea a short title';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const id = uuid();
    let metas;
    try { metas = pending.length ? await persistPending(pending, { ownerType: 'wish', ownerId: id }) : []; } catch (e) { setBusy(false); tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error'); return; }
    if (!metas) { setBusy(false); return; }
    const saved = await saveWish({
      id, title: form.title.trim(), description: isEmptyHtml(form.description) ? '' : form.description, category: form.category, location: form.location.trim(),
      unit: myUnit, raisedBy: me, raisedByRole: roleId, status: 'Submitted', votes: myUnit ? [myUnit] : [], attachments: metas, createdAt: label(), createdStamp: new Date().toISOString(),
    });
    setBusy(false);
    if (!saved) return;
    setForm({ title: '', description: '', category: '', location: '' }); setPending([]); setErrors({}); setAdding(false);
  }

  const open = wishes.find((w) => w.id === openId) || null;

  return (
    <div className="wishlist" data-testid="wishlist">
      <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <p className="hint" style={{ margin: 0, flex: '1 1 220px' }}>Ideas for the community — a bench, a gym machine, a speed bump. Vote with your villa; the committee reviews the most wanted first.</p>
        {!isVendor && <button className="btn" data-testid="wish-add" onClick={() => setAdding(true)}>+ Add an idea</button>}
      </div>
      <Chips label="Filter ideas" value={filter} onChange={setFilter} options={[
        { value: 'all', label: `All (${counts.all})` }, { value: 'open', label: `Open for voting (${counts.open})` }, { value: 'Planned', label: `Planned (${counts.Planned})` },
        { value: 'Done', label: `Done (${counts.Done})` }, { value: 'Declined', label: `Declined (${counts.Declined})` }, { value: 'mine', label: `My ideas (${counts.mine})` }]} />
      <div style={{ margin: '8px 0' }}><Segmented label="Sort ideas" value={sort} onChange={setSort} options={[{ value: 'votes', label: 'Most wanted' }, { value: 'new', label: 'Newest' }]} /></div>

      {list.length === 0 && <p className="hint" data-testid="wish-empty">No ideas here yet.{!isVendor && ' Be the first — tap “+ Add an idea”.'}</p>}
      <div className="wish-grid" style={{ display: 'grid', gap: 10 }}>
        {list.map((w) => {
          const n = (w.votes || []).length;
          return (
            <div key={w.id} className="wish-card card" data-testid="wish-card" style={{ padding: 12, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <button type="button" className={`wish-vote${hasVoted(w) ? ' on' : ''}`} data-testid="wish-vote" aria-pressed={hasVoted(w)} disabled={!myUnit || !votingOpen(w)}
                title={!myUnit ? 'Voting is per villa — your login has no villa' : hasVoted(w) ? 'Remove your villa’s vote' : 'Add your villa’s vote'}
                onClick={() => toggleVote(w)} style={{ minWidth: 54, padding: '6px 4px', borderRadius: 10, border: '1px solid var(--line, #d0d7e2)', background: hasVoted(w) ? 'var(--blue, #2563eb)' : '#fff', color: hasVoted(w) ? '#fff' : 'inherit', cursor: myUnit && votingOpen(w) ? 'pointer' : 'default' }}>
                <div style={{ fontSize: 16 }}>▲</div><b data-testid="wish-count">{n}</b>
              </button>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => setOpenId(w.id)}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{w.title}</b>
                  <span className={`tag ${TONE[w.status] || ''}`} data-testid="wish-status">{w.status}</span>
                  {n > 0 && n === maxVotes && OPEN.includes(w.status) && <span className="tag amber">Most wanted</span>}
                  {w.convertedTicketNo && <span className="tag green">→ {w.convertedTicketNo}</span>}
                </div>
                {w.description && <div className="clamp3" style={{ marginTop: 4 }}><RichText html={w.description} /></div>}
                <div className="hint" style={{ marginTop: 4, fontSize: 12 }}>
                  {[w.category, w.location, `by ${w.raisedBy}${w.unit ? ` · ${w.unit}` : ''}`, w.createdAt, w.estimate ? `≈ ${Number(w.estimate).toLocaleString()}` : ''].filter(Boolean).join(' · ')}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {adding && (
        <Modal title="Add an idea" subtitle="Tell the committee what would make the community better." onClose={() => setAdding(false)}>
          <form className="form-grid" onSubmit={submit} noValidate>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Idea *</label>
              <input aria-label="Idea" data-testid="wish-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Benches near the walking track" />
              {errors.title && <div className="field-error">{errors.title}</div>}
            </div>
            <div className="field"><label>Area</label>
              <select aria-label="Area" value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                <option value="">— any —</option>{categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div className="field"><label>Where (optional)</label>
              <input aria-label="Where" value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Park, Gate 2" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Details</label>
              <RichTextEditor value={form.description} onChange={(h) => setForm((f) => ({ ...f, description: h }))} placeholder="Why is it useful? Who benefits?" minHeight={80} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Pictures</label><AttachmentPicker pending={pending} onChange={setPending} /></div>
            <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn secondary" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn" data-testid="wish-submit" disabled={busy}>{busy ? 'Saving…' : 'Submit idea'}</button>
            </div>
          </form>
        </Modal>
      )}

      {open && (
        <WishDetail wish={open} canManage={canManage} me={me} myUnit={myUnit} votingOpen={votingOpen(open)} hasVoted={hasVoted(open)} onVote={() => toggleVote(open)}
          onClose={() => setOpenId(null)} save={saveWish} remove={async (id) => { await removeWish(id); setOpenId(null); }}
          convert={{ taskTypes, coverage, vendors, ecRoles, handymen, users, roles, tickets, categories, saveTicket }} />
      )}
    </div>
  );
}

function WishDetail({ wish: w, canManage, me, votingOpen, hasVoted, myUnit, onVote, onClose, save, remove, convert }) {
  const [status, setStatus] = useState(w.status);
  const [note, setNote] = useState(w.decisionNote || '');
  const [estimate, setEstimate] = useState(w.estimate || '');
  const [err, setErr] = useState('');
  const [converting, setConverting] = useState(false);
  const mine = w.raisedBy === me;
  const n = (w.votes || []).length;

  async function saveDecision() {
    if (status === 'Declined' && !note.trim()) { setErr('Give a reason for declining — residents will see it'); return; }
    setErr('');
    const ok = await save({ ...w, status, decisionNote: note.trim(), estimate: estimate === '' ? '' : Number(estimate) });
    if (ok) onClose();
  }
  async function withdraw() { const ok = await save({ ...w, status: 'Withdrawn' }); if (ok) onClose(); }

  return (
    <Modal title={w.title} subtitle={`Idea ${w.shortId || ''} · by ${w.raisedBy}${w.unit ? ` · ${w.unit}` : ''} · ${w.createdAt || ''}`} onClose={onClose}>
      <div data-testid="wish-detail">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <span className={`tag ${TONE[w.status] || ''}`}>{w.status}</span>
          <button className="btn secondary" data-testid="wish-vote-detail" disabled={!myUnit || !votingOpen} onClick={onVote}>{hasVoted ? '▲ Voted — tap to remove' : '▲ Vote for this'} ({n})</button>
          {!myUnit && <small className="hint">Voting is per villa; your login has no villa.</small>}
        </div>
        {w.description ? <RichText html={w.description} /> : <p className="hint">No further details.</p>}
        {[w.category, w.location].filter(Boolean).length > 0 && <p className="hint">{[w.category, w.location].filter(Boolean).join(' · ')}</p>}
        {(w.attachments || []).length > 0 && <AttachmentList items={w.attachments} />}
        {w.convertedTicketNo && <p className="notice-banner" data-testid="wish-converted">Converted to {w.convertedType || 'a task'} <b>{w.convertedTicketNo}</b>.</p>}
        {w.decisionNote && !canManage && <p><b>Committee note:</b> {w.decisionNote}</p>}
        {canManage && n > 0 && <p className="hint">Voted by: {(w.votes || []).join(', ')}</p>}

        {canManage && (
          <div className="card" style={{ padding: 10, marginTop: 10 }} data-testid="wish-manage">
            <b>Committee decision</b>
            <div className="form-grid" style={{ marginTop: 6 }}>
              <div className="field"><label>Status</label>
                <select aria-label="Wish status" value={status} onChange={(e) => setStatus(e.target.value)}>{[...STATUSES, ...(w.status === 'Withdrawn' ? ['Withdrawn'] : [])].map((s) => <option key={s}>{s}</option>)}</select>
              </div>
              <div className="field"><label>Rough cost estimate</label><input type="number" min="0" aria-label="Estimate" value={estimate} onChange={(e) => setEstimate(e.target.value)} /></div>
              <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note / reason {status === 'Declined' ? '*' : ''}</label>
                <textarea aria-label="Decision note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown to residents" />
              </div>
            </div>
            {err && <div className="field-error">{err}</div>}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
              <button className="btn" data-testid="wish-save-decision" onClick={saveDecision}>Save decision</button>
              {!w.convertedTicketId && !['Declined', 'Withdrawn', 'Done'].includes(w.status) && <button className="btn secondary" data-testid="wish-convert" onClick={() => setConverting(true)}>Convert to task…</button>}
              <button className="btn secondary" onClick={() => { if (window.confirm('Delete this idea?')) remove(w.id); }}>Delete</button>
            </div>
          </div>
        )}
        {!canManage && mine && w.status === 'Submitted' && (
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn secondary" data-testid="wish-withdraw" onClick={withdraw}>Withdraw my idea</button>
          </div>
        )}
      </div>
      {converting && <ConvertDialog wish={w} cfg={convert} save={save} onClose={() => setConverting(false)} onDone={onClose} />}
    </Modal>
  );
}

function ConvertDialog({ wish: w, cfg, save, onClose, onDone }) {
  const { taskTypes, coverage, vendors, ecRoles, handymen, users, roles, tickets, categories, saveTicket } = cfg;
  const { roleId, currentUser, role } = useApp();
  const me = currentUser?.name || role?.name || '';
  const [typeName, setTypeName] = useState(taskTypes.find((t) => /purchase|capital/i.test(t.name))?.name || taskTypes[0]?.name || '');
  const [category, setCategory] = useState(w.category || '');
  const [sla, setSla] = useState(plainDays(14));
  const [assignedTo, setAssignedTo] = useState('');
  const [priority, setPriority] = useState('Medium');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const tt = taskTypes.find((t) => t.name === typeName);
  const internal = isInternalType(tt);
  const needsPick = tt?.assignmentMode === 'Direct assign' || internal;
  const pool = assigneesForCategory({ category, internal, coverage, vendors, ecRoles, handymen, users, roles });

  async function go() {
    if (!tt) { setErr('Pick a task type'); return; }
    if (!category) { setErr('Pick a category'); return; }
    if (needsPick && !assignedTo) { setErr('Pick who it is assigned to'); return; }
    if (!sla || sla < todayIso()) { setErr('SLA due must be today or a future date'); return; }
    setBusy(true);
    let status = 'Open'; let who = '';
    if (needsPick) { status = 'Assigned'; who = assignedTo; }   // otherwise it joins the category's queue (the next free technician takes it)
    const votes = (w.votes || []).length;
    const ticket = await saveTicket({
      taskType: typeName, title: w.title, unit: w.unit || 'Common area', category, subCategory: '', priority, status, assignedTo: who, slaDueAt: sla,
      description: `${w.description || ''}<p><i>From wishlist idea ${w.shortId || ''} — ${votes} villa vote${votes === 1 ? '' : 's'}.${w.decisionNote ? ` Committee note: ${w.decisionNote}` : ''}</i></p>`,
      scope: 'Community', location: w.location || '', affectedUnits: [], hasPhotos: false, awaitingParts: false, materialsCost: 0, paymentStatus: 'Not Paid', residentRating: 0,
      ...(w.estimate ? { financial: true } : {}), createdBy: me, createdByRole: roleId, createdAt: label(), wishId: w.id,
    });
    if (!ticket) { setBusy(false); return; }
    await save({ ...w, status: 'Planned', convertedTicketId: ticket.id, convertedTicketNo: ticket.ticketNumber || ticket.shortId || '', convertedType: typeName });
    setBusy(false);
    onDone();
  }

  return (
    <Modal title="Convert to task" subtitle="Creates a real task and keeps a link back to this idea." onClose={onClose}>
      <div className="form-grid" data-testid="wish-convert-dialog">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Task type</label>
          <select aria-label="Task type" data-testid="convert-type" value={typeName} onChange={(e) => { setTypeName(e.target.value); setAssignedTo(''); }}>{taskTypes.map((t) => <option key={t.id} value={t.name}>{t.icon ? `${t.icon} ` : ''}{t.name}</option>)}</select>
        </div>
        <div className="field"><label>Category</label>
          <select aria-label="Category" value={category} onChange={(e) => { setCategory(e.target.value); setAssignedTo(''); }}><option value="">— pick —</option>{categories.map((c) => <option key={c}>{c}</option>)}</select>
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
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn" data-testid="convert-go" disabled={busy} onClick={go}>{busy ? 'Creating…' : 'Create task'}</button>
        </div>
      </div>
    </Modal>
  );
}
