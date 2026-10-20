import React, { useMemo, useState } from 'react';
import { COND_COLOR } from '../infra/infraModel.js';
import { specSummary } from '../../lib/assets/specs.js';
import Combobox from '../../components/Combobox.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { repairKindOf, assetCategories } from '../../lib/assets/repairKind.js';

/**
 * Pick the asset a task is about, from the asset register (Infrastructure). Typing a name that is not in the register is not accepted:
 * the person picks an existing asset, clears it, or (if allowed) adds it to the register with the same form Infrastructure uses -
 * so kinds and places come from the same lists everywhere and are never re-typed here.
 * value: { assetId, assetName }
 */
export default function AssetField({ value, onChange, invalid = false, required = false, category = '', cats = [] }) {
  const [showAll, setShowAll] = useState(false);
  const { records: assets, refresh, save: saveAsset } = useCollection(C.EQUIPMENT, 'Equipment & Assets');
  const [adding, setAdding] = useState(null);
  const canAdd = canWriteCollection(C.EQUIPMENT, getPrincipal());
  const byCat = category && !showAll ? assets.filter((a) => assetCategories(a, cats).includes(category) || a.id === value.assetId) : assets;
  const options = useMemo(() => [...byCat].sort((a, b) => String(a.name).localeCompare(String(b.name))).map((a) => ({ value: a.id, label: a.name, hint: [a.type, a.area].filter(Boolean).join(' · ') })), [byCat]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = assets.find((a) => a.id === value.assetId);
  const offBase = !!(picked && category && !assetCategories(picked, cats).includes(category)); // the asset is not filed under this task category
  const fileHere = async () => { const out = await saveAsset({ ...picked, alsoCategories: [...(picked.alsoCategories || []), category] }); if (out && !out.error) refresh?.(); };
  const typed = !value.assetId && value.assetName ? value.assetName : '';
  function change(v) {
    const a = assets.find((x) => x.id === v);
    if (a) onChange({ assetId: a.id, assetName: a.name, asset: a });
    else onChange({ assetId: '', assetName: v || '', asset: null });
  }
  return (
    <div className={`field${invalid || typed ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }} data-testid="asset-field">
      <label>Asset {required ? '*' : '(optional)'}</label>
      <Combobox value={value.assetId || value.assetName || ''} onChange={change} options={options} allowCustom placeholder="Search the asset register — e.g. Street lights, Borewell 2…" invalid={!!typed} />
      {category && <small className="muted" data-testid="asset-filter-note">{showAll ? 'Showing every asset. ' : `Showing ${options.length} asset${options.length === 1 ? '' : 's'} for ${category}. `}<button type="button" className="link-btn" data-testid="asset-show-all" onClick={() => setShowAll((x) => !x)}>{showAll ? `Only ${category}` : 'Show all assets'}</button></small>}
      {picked && <small className="muted" data-testid="asset-picked"><span className="dot" style={{ background: COND_COLOR[picked.status] || '#9aa4b2', width: 9, height: 9, borderRadius: 5, display: 'inline-block', marginRight: 4 }} />{picked.status || 'Working'} · {[picked.type, picked.area, picked.location].filter(Boolean).join(' · ')}{specSummary(picked) ? ` · ${specSummary(picked, 3)}` : ''}. Its condition follows this task.</small>}
      {offBase && (
        <div className="notice" data-testid="asset-offcat" style={{ marginTop: 6 }}>
          “{picked.name}” is filed under {assetCategories(picked, cats).join(' / ') || 'no category'}, not {category}.{' '}
          {canAdd && <button type="button" className="link-btn" data-testid="asset-file-here" onClick={fileHere}>Also file it under {category}</button>}
        </div>
      )}
      {typed && (
        <div className="field-error" data-testid="asset-missing">
          “{typed}” is not in the asset register. Pick one from the list{canAdd ? ', ' : ' or '}clear it
          {canAdd && <> or <button type="button" className="link-btn" data-testid="asset-add" onClick={() => setAdding({ name: typed, quantity: 1, status: 'Working' })}>add it to the register</button></>}.
          {' '}<button type="button" className="link-btn" onClick={() => onChange({ assetId: '', assetName: '', asset: null })}>Clear</button>
        </div>
      )}
      {adding && <RecordModal collection={C.EQUIPMENT} label="Equipment & Assets" record={adding} title="Add to the asset register" subtitle="The same record as in Infrastructure." onSaved={(saved) => { refresh?.(); onChange({ assetId: saved.id, assetName: saved.name, asset: saved }); }} onClose={() => setAdding(null)} />}
    </div>
  );
}
