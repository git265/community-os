import React, { useState } from 'react';
import { useApp } from '../../context/AppContext.jsx';
import { addCustomField, updateFieldAccess, removeField, updateField, setFieldAccessFor } from '../../lib/schema/schemaStore.js';
import { CATEGORIES } from '../../lib/access/roles.js';
import Combobox from '../../components/Combobox.jsx';

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean', 'textarea', 'tags'];

export default function StudioModule() {
  const { schemas, refreshSchemas, roles } = useApp();
  const [sectionId, setSectionId] = useState(schemas[0]?.id);
  const [newField, setNewField] = useState({ key: '', label: '', type: 'text', optionsText: '', required: false, showInTable: false });
  const [defEdit, setDefEdit] = useState(null);
  const [saved, setSaved] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [errs, setErrs] = useState({});

  const section = schemas.find((s) => s.id === sectionId) ?? schemas[0];
  const editingField = section?.fields.find((f) => f.key === editingKey);

  async function handleAddField(e) {
    e.preventDefault();
    const er = {};
    if (!newField.key.trim()) er.key = 'Field key is required';
    if (!newField.label.trim()) er.label = 'Label is required';
    setErrs(er);
    if (Object.keys(er).length) return;
    const options = newField.type === 'select' ? newField.optionsText.split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    if (newField.type === 'select' && (options || []).length < 2) return setErrs({ options: 'A drop-down needs at least two options, separated by commas' });
    if (section.fields.some((f) => f.key === newField.key)) return setErrs({ key: 'That key already exists in this section' });
    const { optionsText, ...rest } = newField; // eslint-disable-line no-unused-vars
    await addCustomField(section.id, {
      ...rest, ...(options ? { options } : {}),
      viewableBy: roles.map((r) => r.id),
      editableBy: ['super_admin'],
    });
    setNewField({ key: '', label: '', type: 'text', optionsText: '', required: false, showInTable: false });
    await refreshSchemas();
  }

  async function toggleAccess(field, roleId, kind) {
    const list = kind === 'view' ? field.viewableBy : field.editableBy;
    const next = list.includes(roleId) ? list.filter((r) => r !== roleId) : [...list, roleId];
    await updateFieldAccess(section.id, field.key, kind === 'view' ? { viewableBy: next } : { editableBy: next });
    await refreshSchemas();
  }

  if (!section) return null;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>No-code studio</h1>
          <p>Add custom attributes and control who can view or edit each field.</p>
        </div>
      </div>

      <div className="card studio-picker">
        <label htmlFor="studio-section">Page / tab to customise</label>
        <div data-testid="studio-section"><Combobox value={section.id} options={schemas.map((x) => ({ value: x.id, label: x.label, hint: x.id }))} placeholder="Type to find a page or tab…" onChange={(v) => { if (v) { setSectionId(v); setEditingKey(null); } }} /></div>
        <small className="muted">{schemas.length} pages and tabs — pick one to see its fields.</small>
      </div>

      <div className="card">
        <h2>{section.label} · fields</h2>
        <table className="stack-table">
          <thead><tr><th>Field</th><th>Type</th><th>Viewable by</th><th>Editable by</th><th></th></tr></thead>
          <tbody>
            {section.fields.map((f) => (
              <tr key={f.key} onClick={() => { setEditingKey(f.key); setDefEdit(null); setSaved(''); }}>
                <td data-label="Field"><b>{f.label}</b> {f.isCustom && <span className="tag blue">Custom</span>}</td>
                <td data-label="Type">{f.type}</td>
                <td data-label="Viewable by">{f.viewableBy.length} / {roles.length} roles</td>
                <td data-label="Editable by">{f.editableBy.length} / {roles.length} roles</td>
                <td>
                  {f.isCustom && (
                    <button
                      className="btn secondary"
                      onClick={async (e) => { e.stopPropagation(); await removeField(section.id, f.key); await refreshSchemas(); }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editingField && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>{editingField.label} · role access</h2>
            <button className="btn secondary" onClick={() => setEditingKey(null)}>Close</button>
          </div>
          {saved && <div className="notice" data-testid="studio-saved">✔ {saved}</div>}
          <div className="form-grid" style={{ marginBottom: 12 }} data-testid="field-definition">
            <div className="field"><label>Label</label><input aria-label="Field label" value={defEdit?.label ?? editingField.label} onChange={(e) => setDefEdit({ ...(defEdit || {}), label: e.target.value })} /></div>
            <div className="field"><label>Required on forms</label><input aria-label="Field required" type="checkbox" checked={defEdit?.required ?? !!editingField.required} onChange={(e) => setDefEdit({ ...(defEdit || {}), required: e.target.checked })} /></div>
            <div className="field"><label>Show as a table column</label><input aria-label="Field in table" type="checkbox" checked={defEdit?.showInTable ?? !!editingField.showInTable} onChange={(e) => setDefEdit({ ...(defEdit || {}), showInTable: e.target.checked })} /></div>
            {editingField.type === 'select' && editingField.isCustom && <div className="field"><label>Drop-down options (comma separated)</label><input aria-label="Field options" value={defEdit?.optionsText ?? (editingField.options || []).join(', ')} onChange={(e) => setDefEdit({ ...(defEdit || {}), optionsText: e.target.value })} /></div>}
            <div className="form-actions"><button className="btn" disabled={!defEdit} data-testid="save-field-def" onClick={async () => { const { optionsText, ...rest } = defEdit; await updateField(section.id, editingField.key, { ...rest, ...(optionsText !== undefined ? { options: optionsText.split(',').map((x) => x.trim()).filter(Boolean) } : {}) }); setDefEdit(null); setSaved('Field saved'); await refreshSchemas(); }}>Save field</button></div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }} data-testid="bulk-access">
            <span className="muted" style={{ fontSize: 13 }}>Set for whole group:</span>
            {CATEGORIES.map((c) => {
              const ids = roles.filter((r) => r.category === c && r.id !== 'super_admin').map((r) => r.id);
              const bulk = async (o) => { await setFieldAccessFor(section.id, editingField.key, ids, o); await refreshSchemas(); };
              return (
                <span key={c} className="seg-mini">
                  <b style={{ fontSize: 12 }}>{c}</b>
                  <button type="button" className="btn secondary sm" aria-label={`${c} can view`} onClick={() => bulk({ view: true })}>View ✓</button>
                  <button type="button" className="btn secondary sm" aria-label={`${c} can edit`} onClick={() => bulk({ edit: true })}>Edit ✓</button>
                  <button type="button" className="btn secondary sm" aria-label={`${c} no access`} onClick={() => bulk({ view: false })}>None</button>
                </span>
              );
            })}
          </div>
          <div className="table-wrap">
            <table className="stack-table access-table">
              <thead><tr><th>Role</th><th>Group</th><th>View</th><th>Edit</th></tr></thead>
              <tbody>
                {roles.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Role">{r.name}</td>
                    <td data-label="Group" className="muted">{r.category}</td>
                    <td data-label="View"><input type="checkbox" checked={editingField.viewableBy.includes(r.id)} onChange={() => toggleAccess(editingField, r.id, 'view')} /></td>
                    <td data-label="Edit"><input type="checkbox" checked={editingField.editableBy.includes(r.id)} onChange={() => toggleAccess(editingField, r.id, 'edit')} disabled={!editingField.viewableBy.includes(r.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>Add a custom field to {section.label}</h2>
        <p className="muted" style={{ margin: "-4px 0 12px" }}>The new field shows up in this section’s forms and tables straight away. Set who can see and edit it.</p>
        <form className="form-grid" onSubmit={handleAddField}>
          <div className={`field${errs.key ? ' invalid' : ''}`}>
            <label>Field key (no spaces) *</label>
            <input
              value={newField.key}
              onChange={(e) => setNewField((f) => ({ ...f, key: e.target.value.replace(/\s+/g, '_') }))}
              placeholder="evChargerVendor"
            />
            {errs.key && <div className="field-error">{errs.key}</div>}
          </div>
          <div className={`field${errs.label ? ' invalid' : ''}`}>
            <label>Label *</label>
            <input
              value={newField.label}
              onChange={(e) => setNewField((f) => ({ ...f, label: e.target.value }))}
              placeholder="EV charger vendor"
            />
            {errs.label && <div className="field-error">{errs.label}</div>}
          </div>
          <div className="field">
            <label>Type</label>
            <select value={newField.type} onChange={(e) => setNewField((f) => ({ ...f, type: e.target.value }))}>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          {newField.type === 'select' && <div className={`field${errs.options ? ' invalid' : ''}`}><label>Drop-down options (comma separated) *</label><input aria-label="New field options" value={newField.optionsText} onChange={(e) => setNewField((f) => ({ ...f, optionsText: e.target.value }))} placeholder="Gold, Silver, Bronze" />{errs.options && <div className="field-error">{errs.options}</div>}</div>}
          <div className="field"><label>Required on forms</label><input aria-label="New field required" type="checkbox" checked={newField.required} onChange={(e) => setNewField((f) => ({ ...f, required: e.target.checked }))} /></div>
          <div className="field"><label>Show as a table column</label><input aria-label="New field in table" type="checkbox" checked={newField.showInTable} onChange={(e) => setNewField((f) => ({ ...f, showInTable: e.target.checked }))} /></div>
          <div className="form-actions">
            <button type="submit" className="btn">Add field</button>
          </div>
        </form>
        <p className="muted">New fields default to view access for every role, edit access for Super Admin only — adjust above.</p>
      </div>
    </div>
  );
}
