import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { uuid } from '../../lib/uuid.js';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const today = () => new Date().toISOString().slice(0, 10);
const dmy = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const FIELD_TYPES = [['number', 'Number'], ['text', 'Text'], ['yesno', 'Yes / No'], ['choice', 'Choice from a list'], ['date', 'Date']];
const fieldsOf = (t) => (Array.isArray(t?.fields) ? t.fields : []);
const show = (f, v) => (v === '' || v == null ? '—' : f.type === 'yesno' ? (v === true || v === 'Yes' ? 'Yes' : 'No') : f.type === 'date' ? dmy(v) : `${v}${f.unit && f.type === 'number' ? ` ${f.unit}` : ''}`);

/** Create / edit the logs: a name plus the fields each entry records. Super Admin (or MANAGE_UTILITY_TYPES). */
export function ManageLogs({ types, save, onClose, onPicked }) {
  const [edit, setEdit] = useState(null); // a type draft
  const [err, setErr] = useState('');
  const blank = { name: '', icon: '📝', description: '', frequency: 'Daily', active: true, fields: [{ key: 'f1', label: '', type: 'number', unit: '', required: false, options: '' }] };
  const setF = (i, patch) => setEdit((e) => ({ ...e, fields: e.fields.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));
  async function submit() {
    setErr('');
    const name = String(edit.name).trim();
    if (!name) return setErr('Name the log, e.g. Pest control');
    if (types.some((t) => t.id !== edit.id && t.name.toLowerCase() === name.toLowerCase())) return setErr(`${name} already exists`);
    const fields = edit.fields.filter((f) => String(f.label).trim()).map((f, i) => ({ key: f.key || `f${i + 1}`, label: String(f.label).trim(), type: f.type, unit: f.unit || '', required: !!f.required, options: f.type === 'choice' ? String(f.options || '').split(',').map((x) => x.trim()).filter(Boolean) : [] }));
    if (!fields.length) return setErr('Add at least one field to record');
    if (fields.some((f) => f.type === 'choice' && !f.options.length)) return setErr('A choice field needs its options, separated by commas');
    const rec = await save({ ...edit, name, fields });
    if (rec) { onPicked?.(rec.id); setEdit(null); }
  }
  return (
    <Modal title={edit ? (edit.id ? 'Edit log' : 'New log') : 'Manage logs'} subtitle="Logs are pages of dated entries: pest control, generator service, chemical dosing - anything the team has to keep a record of." onClose={onClose} wide>
      {err && <div className="notice error">{err}</div>}
      {!edit ? (
        <>
          <ul className="list" data-testid="log-type-list">
            {types.map((t) => <li key={t.id}><span>{t.icon} <b>{t.name}</b> <small className="muted">· {t.frequency} · {fieldsOf(t).length} fields{t.active === false ? ' · retired' : ''}</small></span>
              <span style={{ display: 'flex', gap: 6 }}><button type="button" className="btn secondary sm" onClick={() => setEdit({ ...t, fields: fieldsOf(t).map((f) => ({ ...f, options: (f.options || []).join(', ') })) })}>Edit</button>
                <button type="button" className="btn secondary sm" onClick={() => save({ ...t, active: t.active === false })}>{t.active === false ? 'Enable' : 'Retire'}</button></span></li>)}
            {types.length === 0 && <li className="muted">No custom logs yet.</li>}
          </ul>
          <div className="form-actions"><button className="btn" data-testid="new-log-type" onClick={() => setEdit(blank)}>+ New log</button><button className="btn secondary" onClick={onClose}>Close</button></div>
        </>
      ) : (
        <div data-testid="log-type-form">
          <div className="form-grid">
            <div className="field"><label>Log name *</label><input aria-label="Log name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>Icon</label><input aria-label="Icon" value={edit.icon} onChange={(e) => setEdit({ ...edit, icon: e.target.value })} maxLength={4} /></div>
            <div className="field"><label>How often</label><select aria-label="How often" value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })}>{['Daily', 'Weekly', 'Monthly', 'As needed'].map((x) => <option key={x}>{x}</option>)}</select></div>
            <div className="field"><label>What it is for</label><input aria-label="Description" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></div>
          </div>
          <h4 style={{ margin: '12px 0 4px' }}>What each entry records</h4>
          {edit.fields.map((f, i) => (
            <div key={i} className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', alignItems: 'end', marginBottom: 6 }}>
              <div className="field"><label>Field name</label><input aria-label={`Field ${i + 1} name`} value={f.label} onChange={(e) => setF(i, { label: e.target.value })} /></div>
              <div className="field"><label>Type</label><select aria-label={`Field ${i + 1} type`} value={f.type} onChange={(e) => setF(i, { type: e.target.value })}>{FIELD_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              {f.type === 'number' && <div className="field"><label>Unit</label><input aria-label={`Field ${i + 1} unit`} value={f.unit || ''} onChange={(e) => setF(i, { unit: e.target.value })} placeholder="kg, L, ppm…" /></div>}
              {f.type === 'choice' && <div className="field"><label>Options (comma separated)</label><input aria-label={`Field ${i + 1} options`} value={f.options || ''} onChange={(e) => setF(i, { options: e.target.value })} /></div>}
              <label className="check"><input type="checkbox" checked={!!f.required} onChange={(e) => setF(i, { required: e.target.checked })} /> Required</label>
              <button type="button" className="btn secondary sm" onClick={() => setEdit({ ...edit, fields: edit.fields.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <button type="button" className="btn secondary sm" data-testid="add-log-field" onClick={() => setEdit({ ...edit, fields: [...edit.fields, { key: `f${edit.fields.length + 1}-${uuid().slice(0, 4)}`, label: '', type: 'number', unit: '', required: false, options: '' }] })}>+ Add field</button>
          <div className="form-actions"><button className="btn" data-testid="save-log-type" onClick={submit}>Save log</button><button className="btn secondary" onClick={() => { setEdit(null); setErr(''); }}>Back</button></div>
        </div>
      )}
    </Modal>
  );
}

function EntryDialog({ type, entry, onClose, save }) {
  const fields = fieldsOf(type);
  const [date, setDate] = useState(entry?.date || today());
  const [vals, setVals] = useState(() => ({ ...(entry?.values || {}) }));
  const [note, setNote] = useState(entry?.note || '');
  const [files, setFiles] = useState(Array.isArray(entry?.attachments) ? entry.attachments : []);
  const [pending, setPending] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => entry?.id || uuid());
  async function submit() {
    setErr('');
    if (!date) return setErr('Choose the date');
    for (const f of fields) if (f.required && (vals[f.key] === '' || vals[f.key] == null)) return setErr(`${f.label} is required`);
    setBusy(true);
    try {
      let metas = files;
      if (pending.length) { const added = await persistPending(pending, { ownerType: 'logEntry', ownerId: id }); if (!added) { setBusy(false); return; } metas = [...files, ...added]; }
      const clean = Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, fields.find((f) => f.key === k)?.type === 'number' ? Number(v) : v]));
      const rec = await save({ ...(entry || {}), id, logId: type.id, date, values: clean, note: note.trim(), attachments: metas });
      setBusy(false);
      if (rec) onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${entry ? 'Edit' : 'New'} entry · ${type.name}`} onClose={onClose}>
      {err && <div className="notice error" data-testid="log-error">{err}</div>}
      <div className="form-grid" data-testid="log-entry-form">
        <div className="field"><label>Date *</label><input type="date" aria-label="Date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} /></div>
        {fields.map((f) => (
          <div className="field" key={f.key}><label>{f.label}{f.unit && f.type === 'number' ? ` (${f.unit})` : ''}{f.required ? ' *' : ''}</label>
            {f.type === 'yesno' ? <select aria-label={f.label} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}><option value="">—</option><option>Yes</option><option>No</option></select>
              : f.type === 'choice' ? <select aria-label={f.label} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })}><option value="">—</option>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select>
              : <input aria-label={f.label} type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} value={vals[f.key] ?? ''} onChange={(e) => setVals({ ...vals, [f.key]: e.target.value })} />}
          </div>
        ))}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Remarks</label><input aria-label="Remarks" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      </div>
      <div className="field" style={{ marginTop: 8 }}><label>Photos &amp; documents</label><AttachmentList items={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} /><AttachmentPicker pending={pending} onChange={setPending} label="Add photo" compact /></div>
      <div className="form-actions"><button className="btn" disabled={busy} data-testid="log-save" onClick={submit}>{busy ? 'Saving…' : 'Save entry'}</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

/** One custom log: a table (cards on a phone) of its entries, filtered by year and month, newest first. */
export default function CustomLog({ type }) {
  const { records: all, save } = useCollection(C.LOG_ENTRIES, 'Log Entries');
  const canWrite = canWriteCollection(C.LOG_ENTRIES, getPrincipal());
  const rows = useMemo(() => all.filter((e) => e.logId === type.id), [all, type.id]);
  const years = useMemo(() => [...new Set(rows.map((r) => String(r.date).slice(0, 4)))].sort().reverse(), [rows]);
  const [year, setYear] = useState('last12');   // opens on the last 12 months of entries
  const [month, setMonth] = useState('');
  const [dlg, setDlg] = useState(null);
  const [n, setN] = useState(40);
  const y = year || years[0] || '';
  const since = useMemo(() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0, 10); }, []);
  const inYear = (r) => (y === 'last12' ? String(r.date) >= since : !y || String(r.date).startsWith(y));
  const list = useMemo(() => rows.filter((r) => inYear(r) && (!month || String(r.date).slice(5, 7) === month)).sort((a, b) => String(b.date).localeCompare(String(a.date))), [rows, y, month, since]); // eslint-disable-line react-hooks/exhaustive-deps
  const fields = fieldsOf(type);
  const more = useRef(null);
  useEffect(() => { setN(40); }, [y, month, type.id]);
  return (
    <div data-testid="custom-log">
      <div className="card" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ flex: 1, minWidth: 180 }}><h3 style={{ margin: 0 }}>{type.icon} {type.name}</h3><div className="muted" style={{ fontSize: 13 }}>{type.description || `${type.frequency} log`} · {rows.length} entr{rows.length === 1 ? 'y' : 'ies'}</div></div>
          {years.length > 0 && <select aria-label="Year" data-testid="clog-year" value={y} onChange={(e) => setYear(e.target.value)} style={{ width: 'auto' }}><option value="last12">Last 12 months</option>{years.map((v) => <option key={v}>{v}</option>)}</select>}
          <select aria-label="Month" data-testid="clog-month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }}><option value="">All months</option>{MON.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select>
          {canWrite && <button className="btn" data-testid="add-log-entry" onClick={() => setDlg({})}>+ Add entry</button>}
        </div>
      </div>
      {list.length === 0 ? <div className="empty">No entries{month || y ? ' for this period' : ' yet'}.</div> : (
        <div className="card"><div className="table-wrap"><table className="resp-table" data-testid="clog-table">
          <thead><tr><th>Date</th>{fields.map((f) => <th key={f.key}>{f.label}</th>)}<th>Remarks</th><th>Files</th></tr></thead>
          <tbody>{list.slice(0, n).map((r) => (
            <tr key={r.id} className="clickable" data-testid="clog-row" onClick={() => setDlg(r)}>
              <td data-label="Date"><b>{dmy(r.date)}</b></td>
              {fields.map((f) => <td key={f.key} data-label={f.label}>{show(f, r.values?.[f.key])}</td>)}
              <td data-label="Remarks">{r.note || '—'}</td><td data-label="Files">{(r.attachments || []).length ? `📎 ${(r.attachments || []).length}` : '—'}</td>
            </tr>))}</tbody></table></div>
          {list.length > n && <button type="button" className="btn secondary" style={{ marginTop: 8 }} ref={more} onClick={() => setN((x) => x + 60)}>Show more ({list.length - n} older)</button>}
        </div>
      )}
      {dlg && <EntryDialog type={type} entry={dlg.id ? dlg : null} save={save} onClose={() => setDlg(null)} />}
    </div>
  );
}
