import React, { useState } from 'react';
import { useApp, useCollection } from '../context/AppContext.jsx';
import ServerTable from './ServerTable.jsx';
import { usePhone } from './Tabs.jsx';
import Modal from './Modal.jsx';
import DynamicForm from './DynamicForm.jsx';
import { canWriteCollection } from '../lib/security/authz.js';
import { getPrincipal } from '../lib/security/principal.js';

/**
 * Generic list+edit page driven entirely by a section's schema.
 *
 * Optional props layer in the mockup's per-page chrome without any module
 * losing the "every field editable / custom attributes / role access" core:
 *  - statCards(records)   -> [{ label, value, sub }] rendered above the table
 *  - search               -> adds a free-text box filtering visible columns
 *  - filters              -> [{ key, label }] adds a dropdown per field,
 *                             options pulled straight from the schema
 *  - onBeforeSave(draft, records) -> return an error string to block a save
 *    (e.g. Amenities uses this for double-booking clash detection)
 */
export default function SectionPage({
  sectionId,
  title,
  description,
  statCards,
  search = true,
  filters = [],
  dateFields = [],
  periodFilter = null,
  defaultRange = '',
  baseSort = null,
  onBeforeSave,
  headerExtra,
  recordName,
  formHelp,
  formExtra,
}) {
  const { roleId, schemaFor } = useApp();
  const { records, save } = useCollection(sectionId, title);
  const [editing, setEditing] = useState(null); // null | {} (new) | record
  // the open record always shows its latest saved state (a payment recorded from inside it must flip its status at once)
  const live = editing?.id ? records.find((r) => r.id === editing.id) || editing : editing;
  const [error, setError] = useState('');
  // on a computer an existing record opens beside the list (split view); a new one stays a pop-up
  const phone = usePhone();
  const docked = !!editing?.id && !phone;

  const schema = schemaFor(sectionId);

  if (!schema) return null;

  const canCreate = canWriteCollection(sectionId, getPrincipal());
  const noun = recordName || schema.label;
  const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
  const cards = statCards ? statCards(records) : null;

  async function handleSave(draft) {
    if (onBeforeSave) {
      const err = onBeforeSave(draft, records);
      if (err) {
        setError(err);
        return;
      }
    }
    setError('');
    const saved = await save(draft);
    if (saved) setEditing(null); // null = denied (toast shown), keep the form open
  }

  return (
    <div className={docked ? 'list-docked' : undefined}>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {headerExtra}
          {canCreate && <button className="btn" onClick={() => setEditing({})}>+ Add</button>}
        </div>
      </div>

      {cards && (
        <div className="grid metrics" style={{ marginBottom: 16 }}>
          {cards.map((c) => (
            <div className="card metric" key={c.label}>
              <div className="label">{c.label}</div>
              <div className="value">{c.value}</div>
              {c.sub && <div className="muted">{c.sub}</div>}
            </div>
          ))}
        </div>
      )}

      <div className="card">
        <ServerTable
          collection={sectionId}
          schema={schema}
          search={search}
          filters={filters}
          dateFields={dateFields}
          periodFilter={periodFilter}
          defaultRange={defaultRange}
          baseSort={baseSort}
          showId
          consumeNavSearch
          onRowClick={setEditing}
          rowClassName={(r) => (r.id === editing?.id ? 'row-sel' : '')}
          cardsAlways={docked}
        />
      </div>

      {editing && (() => null)()}
      {editing && (
        <Modal
          dock={!!editing.id}
          title={editing.id ? (canCreate ? `Edit ${noun}` : `${Noun} details`) : `New ${noun}`}
          subtitle={!editing.id ? (formHelp || `Fill in the details below to add a ${noun.toLowerCase()}.`) : canCreate ? `Update this ${noun.toLowerCase()}. Changes are saved to the audit trail.` : `Read-only view of this ${noun.toLowerCase()}.`}
          onClose={() => { setEditing(null); setError(''); }}>
          {error && <div className="notice error">{error}</div>}
          <DynamicForm
            schema={schema}
            roleId={roleId}
            key={`${live.id || 'new'}:${live.recVersion || 0}`}
            record={live}
            readOnly={!canCreate}
            extra={formExtra ? formExtra(live) : null}
            onSave={handleSave}
            onCancel={() => { setEditing(null); setError(''); }}
          />
        </Modal>
      )}
    </div>
  );
}
