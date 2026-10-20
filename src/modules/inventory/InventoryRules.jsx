import React, { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { DEFAULT_RULES, classify } from '../../lib/inventoryImport.js';

/** Rules the Excel import uses to tag each item with a category: words in the description -> category. Includes a tester. */
export default function InventoryRules({ onClose }) {
  const { schemaFor } = useApp();
  const { records: rules, save, remove, refresh } = useCollection(C.INVENTORY_RULES, 'Inventory import rules');
  const categories = schemaFor(C.INVENTORY)?.fields.find((f) => f.key === 'category')?.options || [];
  const canEdit = canWriteCollection(C.INVENTORY_RULES, getPrincipal());
  const [editing, setEditing] = useState(null);
  const [test, setTest] = useState('');
  const [fileCat, setFileCat] = useState('');
  const sorted = useMemo(() => [...rules].sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || String(a.name).localeCompare(b.name)), [rules]);
  const effective = rules.length ? rules : DEFAULT_RULES;
  const hit = test.trim() ? classify({ item: test, fileCategory: fileCat }, effective, categories) : null;
  async function restore() {
    const have = new Set(rules.map((r) => String(r.name).toLowerCase()));
    for (const r of DEFAULT_RULES) if (!have.has(r.name.toLowerCase())) await save({ matchOn: 'Item description', active: true, ...r });
    refresh();
  }
  const kw = (r) => (Array.isArray(r.keywords) ? r.keywords : String(r.keywords || '').split(',')).filter(Boolean);
  return (
    <Modal title="Inventory import rules" subtitle="When an Excel list is imported, each item is filed under the category of the first rule whose words appear in its description. Higher priority wins." onClose={onClose} wide>
      <div className="notice" data-testid="rules-tester" style={{ marginBottom: 10 }}>
        <b>Try it</b>
        <div className="exp-tools" style={{ marginTop: 6 }}>
          <input aria-label="Test item description" data-testid="rule-test-item" value={test} onChange={(e) => setTest(e.target.value)} placeholder="Type an item, e.g. 'Submersible pump 1HP'" />
          <input aria-label="Test category column" data-testid="rule-test-cat" value={fileCat} onChange={(e) => setFileCat(e.target.value)} placeholder="Category from the file (optional)" />
        </div>
        {hit && <div data-testid="rule-test-result" style={{ marginTop: 6 }}>→ <b>{hit.category}</b>{hit.how === 'rule' ? <> · rule “{hit.rule}” matched “{hit.keyword}”</> : hit.how === 'file-category' ? <> · the file’s own category</> : <> · no rule matches, so it would be filed as General for you to check</>}</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 8px' }}>
        {canEdit && <button type="button" className="btn" data-testid="rule-add" onClick={() => setEditing({ matchOn: 'Item description', active: true, priority: 50, keywords: [] })}>+ Add rule</button>}
        {canEdit && <button type="button" className="btn secondary" data-testid="rule-restore" onClick={restore}>Restore standard rules</button>}
      </div>
      {sorted.length === 0 ? <div className="empty">No rules saved yet — the standard rules are used until you add your own.</div> : (
        <ul className="list" data-testid="rule-list">
          {sorted.map((r) => (
            <li key={r.id} data-testid="rule-row" style={{ cursor: canEdit ? 'pointer' : 'default', opacity: r.active === false ? 0.55 : 1 }} onClick={() => canEdit && setEditing(r)}>
              <span><b>{r.name}</b> <span className="tag blue">{r.category}</span> <small className="muted">priority {r.priority ?? 0}{r.matchOn === 'Category column in the file' ? ' · matches the file’s category column' : ''}{r.active === false ? ' · off' : ''}</small><br /><small className="muted">{kw(r).join(', ')}</small></span>
            </li>
          ))}
        </ul>
      )}
      {editing && <RecordModal collection={C.INVENTORY_RULES} label="Inventory import rules" record={editing} title={editing.id ? 'Edit rule' : 'Add a rule'} subtitle="Items whose description contains any of the words are filed under the category." allowDelete={!!editing.id} onSaved={refresh} onClose={() => setEditing(null)} />}
    </Modal>
  );
}
