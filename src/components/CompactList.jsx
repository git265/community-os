import React, { useState } from 'react';
import { useApp, useCollection } from '../context/AppContext.jsx';
import { canEdit } from '../lib/access/permissions.js';
import DynamicForm from './DynamicForm.jsx';

/** A small editable list for a schema, used inside a dashboard-style card
 * (Governance's committee roster / sub-committees / approvals panels) rather
 * than a full page+table like SectionPage - same schema/access/custom-field
 * engine underneath, just a compact presentation. */
export default function CompactList({ sectionId, title, renderRow }) {
  const { roleId, schemaFor } = useApp();
  const { records, save } = useCollection(sectionId, title);
  const [editing, setEditing] = useState(null);

  const schema = schemaFor(sectionId);
  if (!schema) return null;
  const canManage = schema.fields.some((f) => canEdit(f, roleId));

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        {canManage && <button className="btn secondary" onClick={() => setEditing({})}>+ Add</button>}
      </div>
      {records.length === 0 ? (
        <div className="empty">Nothing yet.</div>
      ) : (
        <ul className="list">
          {records.map((r) => (
            <li key={r.id} style={canManage ? { cursor: 'pointer' } : undefined} onClick={() => canManage && setEditing(r)}>
              {renderRow(r)}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <DynamicForm
            schema={schema}
            roleId={roleId}
            record={editing}
            onSave={async (draft) => { await save(draft); setEditing(null); }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
    </div>
  );
}
