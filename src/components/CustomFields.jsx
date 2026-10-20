import React from 'react';
import { useApp } from '../context/AppContext.jsx';
import { canEdit, canView } from '../lib/access/permissions.js';
import { TagsInput } from './DynamicForm.jsx';

/**
 * The custom attributes a Super Admin added to a section (Studio), for screens that are built by hand rather than from the schema
 * (maintenance tasks, amenity bookings, meter readings). Shows only fields the current role may view; editable only if it may edit.
 * `value` is the record/draft; `onChange(key, newValue)` updates it.
 */
export default function CustomFields({ sectionId, value = {}, onChange, title = 'Additional details' }) {
  const { schemaFor, roleId } = useApp();
  const schema = schemaFor(sectionId);
  const fields = (schema?.fields || []).filter((f) => f.isCustom && canView(f, roleId));
  if (!fields.length) return null;
  return (
    <div className="custom-fields" data-testid="custom-fields">
      <h4 style={{ margin: '12px 0 6px' }}>{title}</h4>
      <div className="form-grid">
        {fields.map((f) => {
          const editable = canEdit(f, roleId) && !!onChange;
          const v = value[f.key] ?? (f.type === 'boolean' ? false : f.type === 'tags' ? [] : '');
          const set = (x) => onChange(f.key, x);
          let input;
          if (!editable) input = <div className="ro-value">{f.type === 'boolean' ? (v ? 'Yes' : 'No') : Array.isArray(v) ? v.join(', ') || '—' : String(v || '—')}</div>;
          else if (f.type === 'select') input = <select aria-label={f.label} value={v} onChange={(e) => set(e.target.value)}><option value="">Select…</option>{(f.options || []).map((o) => <option key={o}>{o}</option>)}</select>;
          else if (f.type === 'boolean') input = <input aria-label={f.label} type="checkbox" checked={!!v} onChange={(e) => set(e.target.checked)} />;
          else if (f.type === 'number') input = <input aria-label={f.label} type="number" value={v} onChange={(e) => set(e.target.value === '' ? '' : Number(e.target.value))} />;
          else if (f.type === 'date') input = <input aria-label={f.label} type="date" value={v} onChange={(e) => set(e.target.value)} />;
          else if (f.type === 'textarea') input = <textarea aria-label={f.label} rows={3} value={v} onChange={(e) => set(e.target.value)} />;
          else if (f.type === 'tags') input = <TagsInput list={Array.isArray(v) ? v : []} onChange={set} label={f.label} />;
          else input = <input aria-label={f.label} type="text" value={v} onChange={(e) => set(e.target.value)} />;
          return <div className="field" key={f.key} style={['textarea', 'tags'].includes(f.type) ? { gridColumn: '1 / -1' } : undefined}><label>{f.label}{f.required ? ' *' : ''}</label>{input}</div>;
        })}
      </div>
    </div>
  );
}
