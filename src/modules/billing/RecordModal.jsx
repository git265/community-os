import React, { useState } from 'react';
import Modal from '../../components/Modal.jsx';
import DynamicForm from '../../components/DynamicForm.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { useDeleteVerdict, DeleteBlockedNote } from '../../components/DeleteGuard.jsx';

/**
 * Edit / add one record of a finance collection in a popup, built from its schema.
 *   editable  - keys that stay editable on an EXISTING record (others are shown read-only)
 *   hide      - keys left out of the form (their value is kept, e.g. the financial year)
 *   beforeSave(draft, old) -> draft   last-minute changes (e.g. keep the earlier balance as history)
 *   allowDelete  adds a Delete button on existing records
 */
export default function RecordModal({ collection, label, record, title, subtitle, editable, hide = [], beforeSave, allowDelete = false, onSaved, onClose }) {
  const { roleId, schemaFor } = useApp();
  const { save, remove } = useCollection(collection, label);
  const [error, setError] = useState('');
  const base = schemaFor(collection);
  const canWrite = canWriteCollection(collection, getPrincipal());
  const isNew = !record.id;
  const verdict = useDeleteVerdict(collection, record);
  const schema = {
    ...base,
    fields: base.fields.map((f) => ({
      ...f,
      hidden: f.hidden || hide.includes(f.key),
      ...(!isNew && editable && !editable.includes(f.key) ? { editableBy: [] } : {}),
    })),
  };

  async function handleSave(draft) {
    setError('');
    const out = beforeSave ? beforeSave({ ...draft }, isNew ? null : record) : draft;
    if (typeof out === 'string') { setError(out); return; }
    const saved = await save(out);
    if (saved) { try { await onSaved?.(saved, isNew ? null : record); } catch { /* ignore */ } onClose(true); }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete this ${label.toLowerCase()} entry?`)) return;
    await remove(record.id);
    onClose(true);
  }

  return (
    <Modal title={title || (isNew ? `New ${label}` : `Edit ${label}`)} subtitle={subtitle} onClose={() => onClose(false)}>
      {error && <div className="notice error">{error}</div>}
      <DynamicForm noDelete={allowDelete} schema={schema} roleId={roleId} record={record} readOnly={!canWrite} onSave={handleSave} onCancel={() => onClose(false)}
        deleteSlot={allowDelete && canWrite && !isNew && verdict.checked && !verdict.blocked ? <button type="button" className="btn secondary" data-testid="delete-entry" onClick={handleDelete}>Delete this entry</button> : null}
        belowActions={allowDelete && canWrite && !isNew && verdict.blocked ? <DeleteBlockedNote message={verdict.message} /> : null} />
    </Modal>
  );
}
