import React, { useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';

const STAGE_OPTIONS = ['No', 'Optional', 'Yes'];
const BLANK = { residentDefault: false, name: '', icon: '🔧', creatorScope: 'Resident', assignmentMode: 'Role queue (staff accepts)', quotationStage: 'No', ecApprovalStage: 'No', treasurerStage: 'No', invoiceStage: 'No', paymentStage: 'No', residentVisible: true, active: true };   // active: a new type is in use (the server keeps a missing flag as off)

/**
 * Super-Admin/Facility-Manager config for the Task/Ticket engine: adding a
 * row here (e.g. "Pest Control") is how a new workflow shows up across the
 * app with no code change - see ticketEngine.js for how these settings are
 * applied, and TicketsModule.jsx for where they're read.
 */
const SCOPES = ['Resident', 'EC / Staff', 'Anyone'];
const MODES = ['Role queue (staff accepts)', 'Direct assign'];
const STAGES = [['quotationStage', 'Quotation'], ['ecApprovalStage', 'EC approval'], ['treasurerStage', 'Treasurer authorization'], ['invoiceStage', 'Invoice'], ['paymentStage', 'Payment']];

/** One form for adding and editing a task type, so every setting is available in both places. */
function TypeForm({ value, onChange, nameLocked, nameErr }) {
  const set = (patch) => onChange({ ...value, ...patch });
  return (
    <div className="form-grid">
      <div className={`field${nameErr ? ' invalid' : ''}`}><label>Name *</label>
        <input aria-label="Type name" maxLength={60} value={value.name} disabled={nameLocked} onChange={(e) => set({ name: e.target.value })} placeholder="Pest Control" />
        {nameLocked && <small className="muted">Tasks already use this name, so it can’t be renamed. Add a new type instead.</small>}
        {nameErr && <div className="field-error">{nameErr}</div>}
      </div>
      <div className="field"><label>Icon (emoji)</label><input aria-label="Icon" maxLength={8} value={value.icon || ''} onChange={(e) => set({ icon: e.target.value })} /></div>
      <div className="field"><label>Who can create</label>
        <select aria-label="Who can create" value={value.creatorScope} onChange={(e) => set({ creatorScope: e.target.value })}>{SCOPES.map((o) => <option key={o}>{o}</option>)}</select>
      </div>
      <div className="field"><label>Assignment</label>
        <select aria-label="Assignment" value={value.assignmentMode} onChange={(e) => set({ assignmentMode: e.target.value })}>{MODES.map((o) => <option key={o}>{o}</option>)}</select>
      </div>
      {STAGES.map(([k, lbl]) => (
        <div className="field" key={k}><label>{lbl}</label>
          <select aria-label={lbl} value={value[k] || 'No'} onChange={(e) => set({ [k]: e.target.value })}>{STAGE_OPTIONS.map((o) => <option key={o}>{o}</option>)}</select>
        </div>
      ))}
      <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
        <input type="checkbox" checked={!!value.residentVisible} onChange={(e) => set({ residentVisible: e.target.checked })} style={{ width: 'auto' }} />
        Residents can see tickets of this type
      </label>
      <label className="field" style={{ display: 'flex', alignItems: 'center', gap: 8, flexDirection: 'row' }}>
        <input type="checkbox" aria-label="Used for residents' own requests" checked={!!value.residentDefault} onChange={(e) => set({ residentDefault: e.target.checked })} style={{ width: 'auto' }} />
        Used for residents’ own requests (only one type)
      </label>
    </div>
  );
}

/**
 * Super-Admin/Facility-Manager config for the Task/Ticket engine: adding a
 * row here (e.g. "Pest Control") is how a new workflow shows up across the
 * app with no code change - see ticketEngine.js for how these settings are
 * applied, and TicketsModule.jsx for where they're read.
 */
export default function TaskTypesPanel() {
  const { records: taskTypes, save, remove } = useCollection(COLLECTIONS.TASK_TYPES, 'Task Types');
  const { records: tickets } = useCollection(COLLECTIONS.TICKETS, 'Maintenance');
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [creating, setCreating] = useState(null);
  const [nameErr, setNameErr] = useState('');
  const [msg, setMsg] = useState('');

  const usedBy = (t) => tickets.filter((x) => x.taskType === t.name).length;
  const editing = taskTypes.find((t) => t.id === editingId);

  // only one type is the default for residents' own requests: the new default is saved first, so a refused save never leaves residents with none
  async function saveWithDefault(rec) {
    const out = await save(rec);
    if (out && rec.residentDefault) for (const o of taskTypes) if (o.id !== rec.id && o.residentDefault) await save({ ...o, residentDefault: false });
    return out;
  }
  // the server's rules, checked here first so the message sits on the form
  const typeError = (t) => {
    const n = String(t.name || '').trim();
    if (!n) return 'Name is required';
    if (n.length < 2 || n.length > 60) return 'A name has 2 to 60 characters';
    if (String(t.icon || '').length > 8) return 'The icon is one emoji (up to 8 characters)';
    if (t.residentDefault && !t.residentVisible) return 'The type used for residents’ requests must be visible to residents - tick “Residents can see” too';
    return '';
  };
  const nameClash = (name, id) => taskTypes.some((t) => t.id !== id && t.name.trim().toLowerCase() === name.trim().toLowerCase());

  async function createType(e) {
    e.preventDefault();
    const bad = typeError(creating); if (bad) return setNameErr(bad);
    if (nameClash(creating.name, null)) return setNameErr('A task type with this name already exists');
    setNameErr('');
    if (await saveWithDefault({ ...creating, name: creating.name.trim() })) setCreating(null);
  }
  async function saveEdit() {
    const bad = typeError(draft); if (bad) return setNameErr(bad);
    if (nameClash(draft.name, draft.id)) return setNameErr('A task type with this name already exists');
    setNameErr('');
    if (await saveWithDefault({ ...draft, name: draft.name.trim() })) { setEditingId(null); setDraft(null); }
  }
  async function del() {
    const n = usedBy(editing);
    if (n) { setMsg(`${n} task${n === 1 ? '' : 's'} use this type, so it can’t be deleted. Untick “Residents can see” or stop using it instead.`); return; }
    if (editing.residentDefault) { setMsg('This is the type used for residents’ own requests. Choose another type for that first.'); return; }
    await remove(editing.id); setEditingId(null); setDraft(null); setMsg('');
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 style={{ margin: 0 }}>Task types</h2>
          <p style={{ margin: '5px 0 0' }}>Task type decides the workflow - who can raise it, whether staff accept from a role queue or EC assigns directly, and which financial stages apply. Add as many as your community needs.</p>
        </div>
        <button className="btn" data-testid="add-task-type" onClick={() => { setNameErr(''); setMsg(''); setEditingId(null); setCreating({ ...BLANK }); }}>+ Add task type</button>
      </div>

      <div className="card table-wrap">
        <table>
          <thead><tr><th>Type</th><th>Who can create</th><th>Assignment</th><th>Financial stages</th><th>Resident-visible</th><th>Tasks</th></tr></thead>
          <tbody>
            {taskTypes.map((t) => {
              const stages = STAGES.filter(([k]) => t[k] && t[k] !== 'No').length;
              return (
                <tr key={t.id} onClick={() => { setNameErr(''); setMsg(''); setCreating(null); setDraft({ ...t }); setEditingId(t.id); }}>
                  <td><b>{t.icon} {t.name}</b>{t.residentDefault && <span className="tag blue" style={{ marginLeft: 6 }}>Resident requests</span>}</td>
                  <td className="muted">{t.creatorScope}</td>
                  <td className="muted">{t.assignmentMode}</td>
                  <td>{stages > 0 ? <span className="tag blue">{stages} stage{stages === 1 ? '' : 's'}</span> : <span className="muted">None</span>}</td>
                  <td>{t.residentVisible ? <span className="tag green">Yes</span> : <span className="tag red">No</span>}</td>
                  <td className="muted">{usedBy(t)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && draft && (
        <div className="card" style={{ marginTop: 16 }} data-testid="type-editor">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{editing.icon} {editing.name}</h3>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn secondary" data-testid="type-delete" onClick={del}>Delete</button>
              <button className="btn secondary" onClick={() => { setDraft(null); setEditingId(null); }}>Close</button>
            </div>
          </div>
          {msg && <div className="field-error" data-testid="type-msg" style={{ marginTop: 8 }}>{msg}</div>}
          <div style={{ marginTop: 14 }}><TypeForm value={draft} onChange={setDraft} nameLocked={usedBy(editing) > 0} nameErr={nameErr} /></div>
          <div className="form-actions" style={{ marginTop: 12 }}><button className="btn" data-testid="type-save" onClick={saveEdit}>Save changes</button></div>
        </div>
      )}

      {creating && (
        <div className="card" style={{ marginTop: 16 }} data-testid="type-creator">
          <h3 style={{ marginTop: 0 }}>Add a task type</h3>
          <p className="muted" style={{ margin: "-4px 0 12px" }}>A task type decides who can raise it and which approval steps it goes through.</p>
          <form onSubmit={createType}>
            <TypeForm value={creating} onChange={setCreating} nameErr={nameErr} />
            <div className="form-actions" style={{ marginTop: 12 }}>
              <button type="submit" className="btn" data-testid="type-create">Create</button>
              <button type="button" className="btn secondary" onClick={() => setCreating(null)}>Cancel</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
