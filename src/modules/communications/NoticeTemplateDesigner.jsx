import React, { useRef, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canEdit } from '../../lib/access/permissions.js';
import { DEFAULT_UTILITY_TYPES } from '../../lib/utilityTypes.js';

/** Tokens the app fills in itself when a bill is published (their library value is only a fallback). */
export const AUTO_TOKENS = ['SOCIETY_NAME', 'UTILITY_TYPE', 'AMOUNT', 'MONTH', 'DUE_DATE', 'UNIT', 'PREVIOUS_READING', 'CURRENT_READING', 'UNITS_CONSUMED', 'RATE', 'FIXED_CHARGE', 'TAX'];
const bare = (t) => String(t).replace(/^\{\{|\}\}$/g, '');

/** scope 'utility' = bill templates incl. the generic 'Any' one (Utilities page); 'announcement' = notices & announcements (Communications). */
export default function NoticeTemplateDesigner({ scope = 'all' }) {
  const { roleId, schemaFor } = useApp();
  const { records: templates, save: saveTemplate } = useCollection(COLLECTIONS.NOTICE_TEMPLATES, 'Notice Templates');
  const { records: mergeFields, save: saveMergeField, remove: removeMergeField } = useCollection(COLLECTIONS.MERGE_FIELDS, 'Merge Field Library');
  const { records: utilRows } = useCollection(COLLECTIONS.UTILITY_TYPES, 'Utility Types');
  const billTypes = (utilRows.length ? utilRows : DEFAULT_UTILITY_TYPES).filter((u) => u.active !== false).map((u) => `${u.name} bill`);
  const usedFor = scope === 'utility' ? ['Any', ...billTypes] : scope === 'announcement' ? ['Announcement'] : ['Any', ...billTypes, 'Announcement'];
  const defaultFor = scope === 'announcement' ? 'Announcement' : 'Any';
  const inScope = (t) => scope === 'all' || (scope === 'utility' ? (!t.appliesTo || t.appliesTo === 'Any' || / bill$/.test(t.appliesTo)) : t.appliesTo === 'Announcement');
  const [editingField, setEditingField] = useState(null);
  const bodyRef = useRef(null);

  const schema = schemaFor(COLLECTIONS.NOTICE_TEMPLATES);
  const canManage = schema?.fields.some((f) => canEdit(f, roleId));

  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ name: '', appliesTo: 'Any', logo: '🏠', headerText: '', body: '' });
  const [newField, setNewField] = useState({ token: '', label: '', defaultValue: '' });
  const [errs, setErrs] = useState({});
  const [mfErrs, setMfErrs] = useState({});

  if (!canManage) return null;

  function edit(t) {
    setErrs({});
    setEditingId(t.id);
    setDraft({ name: t.name, appliesTo: t.appliesTo || 'Any', logo: t.logo, headerText: t.headerText, body: t.body });
  }
  function newTemplate() {
    setErrs({});
    setEditingId('new');
    setDraft({ name: '', appliesTo: defaultFor, logo: '🏠', headerText: '', body: '' });
  }

  function insertToken(token) {
    const el = bodyRef.current;
    if (!el) {
      setDraft((d) => ({ ...d, body: d.body + token }));
      return;
    }
    const start = el.selectionStart ?? draft.body.length;
    const end = el.selectionEnd ?? draft.body.length;
    const next = draft.body.slice(0, start) + token + draft.body.slice(end);
    setDraft((d) => ({ ...d, body: next }));
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + token.length; });
  }

  async function save() {
    const er = {};
    if (!draft.name.trim()) er.name = 'Template name is required';
    if (!draft.body.trim()) er.body = 'Body is required';
    const known = new Set(mergeFields.map((f) => bare(f.token)));
    const unknown = [...new Set([...(draft.body + ' ' + draft.headerText).matchAll(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].filter((t) => !known.has(t));
    if (unknown.length) er.body = `Unknown merge field${unknown.length > 1 ? 's' : ''}: ${unknown.map((t) => `{{${t}}}`).join(', ')} — add ${unknown.length > 1 ? 'them' : 'it'} to the Merge field library below, or fix the spelling.`;
    setErrs(er);
    if (Object.keys(er).length) return;
    await saveTemplate({ ...draft, id: editingId === 'new' ? undefined : editingId });
    setEditingId(null);
  }

  async function addMergeField(e) {
    e.preventDefault();
    const er = {};
    if (!newField.label.trim()) er.label = 'Label is required';
    if (!newField.token.trim()) er.token = 'Token name is required';
    const token = newField.token.startsWith('{{') ? newField.token : `{{${newField.token.toUpperCase().replace(/\s+/g, '_')}}}`;
    if (newField.token.trim() && !/^\{\{[A-Z0-9_]+\}\}$/.test(token)) er.token = 'Use capital letters, numbers and underscores only, e.g. GAS_METER_NO';
    else if (mergeFields.some((f) => f.token === token)) er.token = `${token} already exists`;
    setMfErrs(er);
    if (Object.keys(er).length) return;
    await saveMergeField({ token, label: newField.label, defaultValue: newField.defaultValue || '' });
    setNewField({ token: '', label: '', defaultValue: '' });
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{scope === 'utility' ? 'Utility bill templates' : scope === 'announcement' ? 'Announcement templates' : 'Notice templates'}</h2>
        <p className="muted" style={{ margin: "-4px 0 12px" }}>Reusable letters with {"{{FIELD}}"} placeholders — used when bills and announcements are published.</p>
        <button className="btn secondary" onClick={newTemplate}>+ New template</button>
      </div>

      {templates.filter(inScope).length === 0 ? (
        <div className="empty">No templates yet.</div>
      ) : (
        <ul className="list">
          {templates.filter(inScope).map((t) => (
            <li key={t.id} style={{ cursor: 'pointer' }} onClick={() => edit(t)}>
              <span>{t.logo} <b>{t.name}</b> <small className="muted">· {t.appliesTo || 'Any'}</small></span>
              <span className="muted">{t.headerText}</span>
            </li>
          ))}
        </ul>
      )}

      {editingId && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <div className="form-grid">
            <div className={`field${errs.name ? ' invalid' : ''}`}><label>Template name *</label><input value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />{errs.name && <div className="field-error">{errs.name}</div>}</div>
            <div className="field"><label>Used for</label><select value={draft.appliesTo} onChange={(e) => setDraft((d) => ({ ...d, appliesTo: e.target.value }))}>{[...new Set([...usedFor, draft.appliesTo])].map((o) => <option key={o}>{o}</option>)}</select></div>
            <div className="field"><label>Logo (emoji)</label><input value={draft.logo} onChange={(e) => setDraft((d) => ({ ...d, logo: e.target.value }))} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Header text</label><input value={draft.headerText} onChange={(e) => setDraft((d) => ({ ...d, headerText: e.target.value }))} /></div>
          </div>

          <div style={{ margin: '12px 0 6px', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mergeFields.map((f) => (
              <button key={f.id} type="button" className="tag blue" style={{ cursor: 'pointer' }} onClick={() => insertToken(f.token)}>
                {f.label}
              </button>
            ))}
          </div>
          <div className={`field${errs.body ? ' invalid' : ''}`}>
            <label>Body *</label>
            <textarea ref={bodyRef} rows={6} value={draft.body} onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))} />
            {errs.body && <div className="field-error">{errs.body}</div>}
          </div>
          <p className="muted">Click a merge field chip above to insert it at the cursor.</p>

          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button className="btn" onClick={save}>Save template</button>
            <button className="btn secondary" onClick={() => setEditingId(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <h3 style={{ margin: '0 0 8px' }}>Merge field library</h3>
        <p className="muted" style={{ margin: "-4px 0 12px" }}>Placeholders usable inside any template, written as {"{{TOKEN}}"}. <b>Automatic</b> fields (bill amount, month, readings, rate…) are filled in by the app for every utility, Gas included; the value shown here is only a fallback. <b>Custom</b> fields always use the default value you set (for example an office phone number or bank details), and can be edited or removed.</p>
        <table className="resp-table" data-testid="merge-library"><thead><tr><th>Label</th><th>Token</th><th>Default value</th><th>Type</th><th /></tr></thead>
          <tbody>
            {mergeFields.map((f) => {
              const auto = AUTO_TOKENS.includes(bare(f.token));
              const ed = editingField?.id === f.id;
              return (
                <tr key={f.id}>
                  <td data-label="Label">{ed ? <input aria-label="Field label" value={editingField.label} onChange={(e) => setEditingField((x) => ({ ...x, label: e.target.value }))} /> : f.label}</td>
                  <td data-label="Token"><code>{f.token}</code></td>
                  <td data-label="Default value">{ed ? <input aria-label="Field default value" value={editingField.defaultValue || ''} onChange={(e) => setEditingField((x) => ({ ...x, defaultValue: e.target.value }))} /> : (f.defaultValue || <span className="muted">—</span>)}</td>
                  <td data-label="Type"><span className={`tag ${auto ? 'blue' : ''}`}>{auto ? 'Automatic' : 'Custom'}</span></td>
                  <td data-label="">
                    {ed ? <><button type="button" className="btn sm" onClick={async () => { if (await saveMergeField({ ...f, label: editingField.label, defaultValue: editingField.defaultValue })) setEditingField(null); }}>Save</button> <button type="button" className="btn secondary sm" onClick={() => setEditingField(null)}>Cancel</button></>
                      : <><button type="button" className="btn secondary sm" onClick={() => setEditingField({ id: f.id, label: f.label, defaultValue: f.defaultValue || '' })}>Edit</button>{!auto && <> <button type="button" className="btn secondary sm" onClick={async () => { const used = templates.filter((t) => `${t.body} ${t.headerText}`.includes(f.token)); if (used.length && !window.confirm(`${f.token} is used in: ${used.map((t) => t.name).join(', ')}. Delete it anyway? Those templates will show the raw token.`)) return; await removeMergeField(f.id); }}>Delete</button></>}</>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <form style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }} onSubmit={addMergeField}>
          <div className={`field${mfErrs.label ? ' invalid' : ''}`}><label>Label *</label><input placeholder="e.g. Amount" value={newField.label} onChange={(e) => setNewField((f) => ({ ...f, label: e.target.value }))} />{mfErrs.label && <div className="field-error">{mfErrs.label}</div>}</div>
          <div className={`field${mfErrs.token ? ' invalid' : ''}`}><label>Token *</label><input placeholder="TOKEN_NAME" value={newField.token} onChange={(e) => setNewField((f) => ({ ...f, token: e.target.value }))} />{mfErrs.token && <div className="field-error">{mfErrs.token}</div>}</div>
          <div className="field"><label>Default value</label><input placeholder="optional" value={newField.defaultValue} onChange={(e) => setNewField((f) => ({ ...f, defaultValue: e.target.value }))} /></div>
          <button type="submit" className="btn secondary" style={{ marginTop: 22 }}>+ Add field</button>
        </form>
      </div>
    </div>
  );
}
