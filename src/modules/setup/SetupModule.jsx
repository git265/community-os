import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { SegTabs } from '../../components/ui.jsx';
import SectionPage from '../../components/SectionPage.jsx';
import DynamicForm from '../../components/DynamicForm.jsx';
import Modal from '../../components/Modal.jsx';
import UnitImport from './UnitImport.jsx';
import { propertyTypes, getCommunityConfig } from '../../lib/locale.js';
import { letterheadFrom } from '../../lib/documents/letterhead.js';
import { receiptHtml, statementHtml } from '../../lib/documents/templates.js';
import { region } from '../../lib/region/regions.js';
import { currentLists, cleanLists, SHIFT_COLOURS, GENERIC_HEADS, GENERIC_RULES, DEFAULT_INCOME_HEADS, DEFAULT_EXPENSE_HEADS, DEFAULT_NEUTRAL_HEADS } from '../../lib/lists/configLists.js';

/** How many units to create in one go, at most (the list below shows a preview first). */
const BULK_MAX = 3000;

function BlocksTab() {
  const { roleId, schemaFor } = useApp();
  const schema = schemaFor(COLLECTIONS.BLOCKS);
  const { records: blocks, save, remove } = useCollection(COLLECTIONS.BLOCKS, 'Blocks & Towers');
  const { records: props, refresh: refreshProps } = useCollection(COLLECTIONS.PROPERTIES, 'Properties & Residents');
  const canEdit = canWriteCollection(COLLECTIONS.BLOCKS, getPrincipal());
  const [editing, setEditing] = useState(null);
  const [bulk, setBulk] = useState(null);
  const [imp, setImp] = useState(false);
  const [msg, setMsg] = useState('');

  const stats = useMemo(() => {
    const m = new Map();
    props.forEach((p) => {
      const k = p.zone || '';
      const s = m.get(k) || { units: 0, occupied: 0, vacant: 0 };
      s.units += 1; if (p.occupancy === 'Vacant') s.vacant += 1; else s.occupied += 1;
      m.set(k, s);
    });
    return m;
  }, [props]);
  const unassigned = stats.get('')?.units || 0;
  const orphans = [...stats.keys()].filter((k) => k && !blocks.some((b) => b.name === k));

  async function delBlock(b) {
    if ((stats.get(b.name)?.units || 0) > 0) return setMsg(`${b.name} still has ${stats.get(b.name).units} units. Move them to another block first.`);
    if (!window.confirm(`Delete ${b.name}?`)) return undefined;
    await remove(b.id); return undefined;
  }
  async function adoptOrphans() {
    for (const name of orphans) await save({ name, kind: 'Other', plannedUnits: stats.get(name).units, active: true });
    setMsg(`Added ${orphans.length} block${orphans.length > 1 ? 's' : ''} found on existing units.`);
  }

  return (
    <div data-testid="setup-blocks">
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div><h2 style={{ margin: 0 }}>Blocks, towers &amp; phases</h2><p className="muted" style={{ margin: '2px 0 0' }}>Group the community&apos;s units. Announcements, dues, reports and block-limited staff all work by block.</p></div>
          {canEdit && <div style={{ display: 'flex', gap: 8 }}><button className="btn secondary" data-testid="import-units" onClick={() => setImp(true)}>Import units from Excel</button><button className="btn secondary" data-testid="bulk-units" onClick={() => setBulk({ block: blocks[0]?.name || '', type: propertyTypes()[0], prefix: '', from: 1, to: 10, pad: 0, occupancy: 'Vacant' })}>Add units in bulk</button><button className="btn" data-testid="add-block" onClick={() => setEditing({ active: true })}>+ Add block</button></div>}
        </div>
        {msg && <div className="notice" style={{ marginTop: 8 }} data-testid="blocks-msg">{msg}</div>}
        {orphans.length > 0 && canEdit && <div className="notice" style={{ marginTop: 8 }}>Units use {orphans.length} block name{orphans.length > 1 ? 's' : ''} that {orphans.length > 1 ? 'are' : 'is'} not in this list: <b>{orphans.join(', ')}</b>. <button className="link-btn" data-testid="adopt-blocks" onClick={adoptOrphans}>Add {orphans.length > 1 ? 'them' : 'it'}</button></div>}
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="resp-table">
            <thead><tr><th>Block</th><th>Code</th><th>Kind</th><th>Units</th><th>Planned</th><th>Occupied</th><th>Vacant</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {blocks.map((b) => { const s = stats.get(b.name) || { units: 0, occupied: 0, vacant: 0 }; return (
                <tr key={b.id} data-testid="block-row">
                  <td data-label="Block"><b>{b.name}</b>{b.active === false ? <span className="tag orange" style={{ marginLeft: 6 }}>Inactive</span> : null}</td><td data-label="Code">{b.code || '—'}</td><td data-label="Kind">{b.kind || '—'}</td>
                  <td data-label="Units"><b>{s.units}</b></td><td data-label="Planned">{b.plannedUnits || '—'}</td><td data-label="Occupied">{s.occupied}</td><td data-label="Vacant">{s.vacant}</td>
                  {canEdit && <td><button className="btn secondary sm" onClick={() => setEditing(b)}>Edit</button> <button className="btn secondary sm" onClick={() => delBlock(b)}>Delete</button></td>}
                </tr>
              ); })}
              {blocks.length === 0 && <tr><td colSpan={8} className="empty">No blocks yet. Add your blocks / towers, or leave this empty for a single-block community.</td></tr>}
              {unassigned > 0 && <tr><td data-label="Block"><i>No block set</i></td><td /><td /><td data-label="Units"><b>{unassigned}</b></td><td /><td /><td /><td /></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && schema && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'Add a block'} subtitle="A block, tower, phase or villa lane." onClose={() => setEditing(null)}>
          <DynamicForm schema={schema} roleId={roleId} record={editing} onSave={async (d) => { if (await save(d)) setEditing(null); }} onCancel={() => setEditing(null)} />
        </Modal>
      )}

      {imp && <UnitImport existing={props} blocks={blocks} onClose={() => setImp(false)} onDone={refreshProps} />}

      {bulk && (
        <Modal title="Add units in bulk" subtitle="Creates a numbered range of units in one block. Owner details are filled in later (or import them from Excel)." onClose={() => setBulk(null)}>
          <BulkUnits draft={bulk} setDraft={setBulk} blocks={blocks} existing={props} onDone={async (n) => { setBulk(null); setMsg(`Added ${n} units.`); await refreshProps(); }} />
        </Modal>
      )}
    </div>
  );
}

function BulkUnits({ draft, setDraft, blocks, existing, onDone }) {
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const from = Number(draft.from) || 0; const to = Number(draft.to) || 0;
  const label = (n) => `${draft.prefix}${draft.pad ? String(n).padStart(Number(draft.pad), '0') : n}`;
  const have = useMemo(() => new Set(existing.map((p) => p.unit)), [existing]);
  const names = []; for (let n = from; n <= to && names.length <= BULK_MAX; n += 1) names.push(label(n));
  const fresh = names.filter((u) => !have.has(u));
  const tooMany = names.length > BULK_MAX; const bad = !draft.block || to < from || tooMany;
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function go() {
    setBusy(true); setErr('');
    try {
      const rows = fresh.map((unit) => ({ unit, type: draft.type, zone: draft.block, occupancy: draft.occupancy, owner: 'To be updated', ownerPhone: '', people: [] }));
      const n = await secureStorage.importMany(COLLECTIONS.PROPERTIES, rows, { label: 'Properties & Residents', summary: `Added ${rows.length} units to ${draft.block} (${rows[0]?.unit} … ${rows[rows.length - 1]?.unit})` });
      onDone(n);
    } catch (e) { setErr(e.message || 'Could not add the units'); setBusy(false); }
  }
  return (
    <div data-testid="bulk-form">
      <div className="form-grid">
        <div className="field"><label>Block *</label><select aria-label="Block" value={draft.block} onChange={(e) => set('block', e.target.value)}><option value="">Select…</option>{blocks.map((b) => <option key={b.id}>{b.name}</option>)}</select></div>
        <div className="field"><label>Property type</label><select aria-label="Property type" value={draft.type} onChange={(e) => set('type', e.target.value)}>{propertyTypes().map((t) => <option key={t}>{t}</option>)}</select></div>
        <div className="field"><label>Unit prefix</label><input aria-label="Prefix" value={draft.prefix} onChange={(e) => set('prefix', e.target.value)} placeholder="e.g. A-  or  Villa " /></div>
        <div className="field"><label>Zero-pad to</label><input aria-label="Pad" type="number" min="0" max="6" value={draft.pad} onChange={(e) => set('pad', e.target.value)} /></div>
        <div className="field"><label>From number</label><input aria-label="From" type="number" value={draft.from} onChange={(e) => set('from', e.target.value)} /></div>
        <div className="field"><label>To number</label><input aria-label="To" type="number" value={draft.to} onChange={(e) => set('to', e.target.value)} /></div>
        <div className="field"><label>Occupancy</label><select aria-label="Occupancy" value={draft.occupancy} onChange={(e) => set('occupancy', e.target.value)}><option>Vacant</option><option>Owner occupied</option></select></div>
      </div>
      <p className="muted" data-testid="bulk-preview">{tooMany ? `That is more than ${BULK_MAX} units at once.` : to < from ? '“To” must not be smaller than “From”.' : `${fresh.length} new unit${fresh.length === 1 ? '' : 's'}: ${fresh.slice(0, 3).join(', ')}${fresh.length > 3 ? ` … ${fresh[fresh.length - 1]}` : ''}${names.length - fresh.length ? ` · ${names.length - fresh.length} already exist and are skipped` : ''}`}</p>
      {err && <div className="field-error">{err}</div>}
      <div className="form-actions"><button className="btn" data-testid="bulk-go" disabled={bad || !fresh.length || busy} onClick={go}>{busy ? 'Adding…' : `Add ${fresh.length} units`}</button></div>
    </div>
  );
}

function FacilitiesTab() {
  return (
    <div data-testid="setup-facilities">
      <SectionPage sectionId={COLLECTIONS.FACILITIES} title="Facilities & Locations" description="Clubhouses, pools, courts, STP/WTP, gates, parking areas … Anywhere a place is chosen (amenity bookings, electricity bills, inventory, assets) offers this list." filters={[{ key: 'kind', label: 'All kinds' }, { key: 'block', label: 'All blocks' }]} baseSort={{ key: 'name', dir: 'asc' }} recordName="facility" />
    </div>
  );
}

function SettingsTab() {
  const { roleId, schemaFor } = useApp();
  const schema = schemaFor(COLLECTIONS.COMMUNITY_CONFIG);
  const { records, save, loading } = useCollection(COLLECTIONS.COMMUNITY_CONFIG, 'Community setup');
  const [saved, setSaved] = useState(false);
  if (!schema || loading) return null;
  const row = { ...getCommunityConfig(), ...(records[0] || {}) }; // today's values (or the defaults) are what the form starts from
  return (
    <div className="card" data-testid="setup-settings">
      <h2 style={{ margin: 0 }}>Money, financial year &amp; property types</h2>
      <p className="muted">How amounts and the financial year look for this community. Changing the financial-year start moves the FY filters, the budget and the maintenance-fee periods.</p>
      <DynamicForm key={row.id || 'new'} schema={schema} roleId={roleId} record={row} noDelete onSave={async (d) => { if (await save(d)) { setSaved(true); setTimeout(() => window.location.reload(), 600); } }} onCancel={() => {}} />
      {saved && <div className="notice" data-testid="settings-saved">Saved — reloading to apply…</div>}
    </div>
  );
}


const DETAIL_KEYS = ['legalName', 'address', 'registrationNo', 'panNo', 'taxRegistered', 'taxId', 'contactPhone', 'contactEmail', 'website', 'signatory', 'receiptThanks', 'receiptFooter', 'statementNote', 'payInstructions'];

/** Who the community is on paper: name, address, registration, optional tax number, and the wording of receipts and statements - with a live preview. */
function DetailsTab() {
  const { records, save, loading } = useCollection(COLLECTIONS.COMMUNITY_CONFIG, 'Community setup');
  const [d, setD] = useState(null);
  const [view, setView] = useState('receipt');
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const row = records[0];
  React.useEffect(() => { if (!loading) setD((x) => x || Object.fromEntries(DETAIL_KEYS.map((k) => [k, row?.[k] ?? '']))); }, [loading, row?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (loading || !d) return null;
  const set = (k, v) => { setSaved(false); setD((x) => ({ ...x, [k]: v })); };
  const registered = d.taxRegistered !== 'No';
  const lh = letterheadFrom(d);
  const today = new Date().toISOString();
  const html = view === 'receipt'
    ? receiptHtml({ lh, kind: 'Receipt', no: 'R-0001', unit: 'Villa 12', payer: 'Sample Resident', forWhat: 'Maintenance · October', issuedAt: today, lines: [{ label: 'Maintenance · October', amount: 4500 }], total: 4500, payment: { mode: 'UPI', ref: 'UTR 1234' } })
    : statementHtml({ lh, unit: 'Villa 12', owner: 'Sample Resident', from: '2026-04-01', to: '2026-10-17', opening: 0, rows: [{ date: '2026-10-01', ref: 'B-101', desc: 'Maintenance · October', debit: 4500, credit: 0, balance: 4500 }], closing: 4500, summary: [{ label: 'Billed', value: 4500 }, { label: 'Paid', value: 0 }], generatedAt: today });
  async function submit() {
    setErr('');
    if (!String(d.legalName).trim()) return setErr('Enter the name to print on receipts and statements.');
    if (registered && d.taxId && region().tax.idLabel === 'GSTIN' && !/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/i.test(String(d.taxId).trim())) return setErr('A GSTIN has 15 characters, like 36AABCL1234F1Z5. Check it, or choose “No” above if the community is not registered.');
    const ok = await save({ ...(row || {}), ...d, taxId: registered ? String(d.taxId).trim().toUpperCase() : d.taxId });
    if (ok) { setSaved(true); setTimeout(() => window.location.reload(), 600); } else setErr('Could not save.');
    return undefined;
  }
  const F = ({ k, label, hint, area, ...rest }) => (
    <div className="field"><label>{label}</label>{area ? <textarea rows={3} aria-label={label} value={d[k] || ''} onChange={(e) => set(k, e.target.value)} {...rest} /> : <input aria-label={label} value={d[k] || ''} onChange={(e) => set(k, e.target.value)} {...rest} />}{hint && <small className="muted">{hint}</small>}</div>
  );
  return (
    <div data-testid="setup-details" className="details-grid">
      <div className="card">
        <h2 style={{ margin: 0 }}>Community details</h2>
        <p className="muted">Printed at the top of every receipt, invoice and statement. Change it here once; nothing else needs editing.</p>
        <div className="form-grid">
          <F k="legalName" label="Name on receipts & statements" data-testid="det-name" />
          <F k="registrationNo" label="Registration number" />
          <div style={{ gridColumn: '1 / -1' }}><F k="address" label="Address" area data-testid="det-address" /></div>
          <F k="contactPhone" label="Office phone" />
          <F k="contactEmail" label="Office e-mail" />
          <F k="website" label="Website (optional)" />
          <F k="panNo" label="PAN (optional)" />
        </div>
        <h3 style={{ marginBottom: 4 }}>{region().tax.name} registration</h3>
        <div className="chip-row" role="group" aria-label="Registered for tax">
          <button type="button" className={`chip-btn${registered ? ' on' : ''}`} data-testid="det-reg-yes" aria-pressed={registered} onClick={() => set('taxRegistered', 'Yes')}>Registered</button>
          <button type="button" className={`chip-btn${!registered ? ' on' : ''}`} data-testid="det-reg-no" aria-pressed={!registered} onClick={() => set('taxRegistered', 'No')}>Not registered</button>
        </div>
        {registered
          ? <div className="field" style={{ marginTop: 8 }}><label>{region().tax.idLabel}</label><input aria-label={region().tax.idLabel} data-testid="det-taxid" value={d.taxId || ''} onChange={(e) => set('taxId', e.target.value)} placeholder="e.g. 36AABCL1234F1Z5" /><small className="muted">Shown on receipts, invoices and booking bills. Leave blank to show nothing.</small></div>
          : <p className="muted" style={{ marginTop: 6 }}>No tax number is printed anywhere. If you do not charge {region().tax.name}, also set the {region().tax.name} rate to 0 on your amenities.</p>}
        <h3 style={{ marginBottom: 4 }}>Wording</h3>
        <div className="form-grid">
          <F k="signatory" label="Signature line (e.g. Treasurer)" />
          <F k="receiptThanks" label="Line above the signature" placeholder="Received with thanks" />
          <div style={{ gridColumn: '1 / -1' }}><F k="receiptFooter" label="Footer note" /></div>
          <div style={{ gridColumn: '1 / -1' }}><F k="payInstructions" label="How to pay (on statements and unpaid invoices)" area hint="Bank account, UPI id, office hours. Leave blank to print nothing." /></div>
          <div style={{ gridColumn: '1 / -1' }}><F k="statementNote" label="Note at the end of every statement" area /></div>
        </div>
        {err && <div className="field-error" data-testid="det-error">{err}</div>}
        <div className="form-actions"><button type="button" className="btn" data-testid="det-save" onClick={submit}>Save details</button></div>
        {saved && <div className="notice" data-testid="det-saved">Saved — reloading to apply…</div>}
      </div>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <h3 style={{ margin: 0 }}>Preview</h3>
          <div className="chip-row"><button type="button" className={`chip-btn${view === 'receipt' ? ' on' : ''}`} data-testid="det-v-receipt" onClick={() => setView('receipt')}>Receipt</button><button type="button" className={`chip-btn${view === 'statement' ? ' on' : ''}`} data-testid="det-v-statement" onClick={() => setView('statement')}>Statement</button></div>
        </div>
        <p className="muted" style={{ margin: '4px 0 8px' }}>Updates as you type. Sample figures.</p>
        <iframe title="Document preview" srcDoc={html} data-testid="det-preview" style={{ width: '100%', height: 520, border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
      </div>
    </div>
  );
}

const lines = (arr) => arr.join('\n');
const fromLines = (t) => String(t || '').split('\n').map((x) => x.trim()).filter(Boolean);

/** Shift types, amenity time slots, ticket categories and document groups: the lists that differ from one community to the next. */
function ListsTab() {
  const { roles } = useApp();
  const { records, save, loading } = useCollection(COLLECTIONS.COMMUNITY_CONFIG, 'Community setup');
  const [l, setL] = useState(() => currentLists());
  const [slotsText, setSlotsText] = useState(() => lines(currentLists().slots));
  const [catsText, setCatsText] = useState(() => lines(currentLists().ticketCategories));
  const [incText, setIncText] = useState(() => lines(currentLists().incomeHeads));
  const [expText, setExpText] = useState(() => lines(currentLists().expenseHeads));
  const [neuText, setNeuText] = useState(() => lines(currentLists().neutralHeads));
  const [depText, setDepText] = useState(() => lines(currentLists().depositTypes));
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  if (loading) return null;
  const preset = (inc, exp, neu) => { setIncText(lines(inc)); setExpText(lines(exp)); setNeuText(lines(neu)); };
  const allHeads = [...fromLines(incText), ...fromLines(expText), ...fromLines(neuText)];
  const setRule = (i, k, v) => setL((x) => ({ ...x, bankRules: x.bankRules.map((r, j) => (j === i ? { ...r, [k]: v } : r)) }));
  const setShift = (i, k, v) => setL((x) => ({ ...x, shifts: x.shifts.map((s, j) => (j === i ? { ...s, [k]: v } : s)) }));
  const setGroup = (i, k, v) => setL((x) => ({ ...x, docGroups: x.docGroups.map((g, j) => (j === i ? { ...g, [k]: v } : g)) }));
  const roleOpts = [{ id: 'group:EC', name: 'All Executive Committee roles' }, ...(roles || []).filter((r) => r.id !== 'super_admin').map((r) => ({ id: r.id, name: r.name }))];
  async function persist(next) {
    const clean = cleanLists(next);
    const ok = await save({ ...(records[0] || {}), customLists: JSON.stringify(clean) });
    if (ok) { setSaved(true); setTimeout(() => window.location.reload(), 600); } else setErr('Could not save the lists.');
  }
  function submit() {
    setErr('');
    const bad = l.shifts.find((s) => s.key.trim() && s.key !== 'Off' && !/^\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}$/.test(s.time.trim()));
    if (bad) return setErr(`Write the time of the “${bad.key}” shift like 06:00–14:00.`);
    const badSlot = fromLines(slotsText).find((x) => !/^\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}$/.test(x));
    if (badSlot) return setErr(`Write each amenity slot like 08:00–09:00 (“${badSlot}” is not).`);
    persist({ ...l, slots: fromLines(slotsText).map((x) => x.replace(/\s*-\s*/, '–')), ticketCategories: fromLines(catsText), incomeHeads: fromLines(incText), expenseHeads: fromLines(expText), neutralHeads: fromLines(neuText), depositTypes: fromLines(depText) });
  }
  function reset() { persist({}); }
  return (
    <div data-testid="setup-lists">
      <div className="card">
        <h2 style={{ margin: 0 }}>Shift types</h2>
        <p className="muted">The shifts you can roster staff on. “Off” is always kept. The time is shown on the roster and used for attendance.</p>
        {l.shifts.map((s, i) => (
          <div key={i} className="form-grid" style={{ alignItems: 'end', marginBottom: 6 }} data-testid="shift-row">
            <div className="field"><label>Name</label><input aria-label={`Shift name ${i + 1}`} value={s.key} disabled={s.key === 'Off'} onChange={(e) => setShift(i, 'key', e.target.value)} /></div>
            <div className="field"><label>Time</label><input aria-label={`Shift time ${i + 1}`} value={s.time} disabled={s.key === 'Off'} placeholder="06:00–14:00" onChange={(e) => setShift(i, 'time', e.target.value)} /></div>
            <div className="field"><label>Colour</label><select aria-label={`Shift colour ${i + 1}`} value={s.cls} onChange={(e) => setShift(i, 'cls', e.target.value)}>{SHIFT_COLOURS.map((c) => <option key={c} value={c}>{c || 'none'}</option>)}</select></div>
            {s.key !== 'Off' && <button type="button" className="btn secondary sm" onClick={() => setL((x) => ({ ...x, shifts: x.shifts.filter((_, j) => j !== i) }))}>Remove</button>}
          </div>
        ))}
        <button type="button" className="btn secondary sm" data-testid="shift-add" onClick={() => setL((x) => ({ ...x, shifts: [{ key: '', time: '', cls: 'blue' }, ...x.shifts] }))}>+ Add a shift</button>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>Amenity time slots</h2>
        <p className="muted">The hourly slots offered when an amenity is booked by the hour. One per line, like 08:00–09:00.</p>
        <textarea aria-label="Amenity slots" data-testid="slots-text" rows={6} style={{ width: '100%' }} value={slotsText} onChange={(e) => setSlotsText(e.target.value)} />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>Ticket categories</h2>
        <p className="muted">What a resident or staff member can raise a maintenance ticket about, and the trades field staff are listed under. One per line.</p>
        <textarea aria-label="Ticket categories" data-testid="cats-text" rows={7} style={{ width: '100%' }} value={catsText} onChange={(e) => setCatsText(e.target.value)} />
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>Document groups</h2>
        <p className="muted">Who a document is for. The six standard groups always exist; add your own and choose the roles that can open them (admins always can).</p>
        {l.docGroups.map((g, i) => (
          <div key={i} className="ro-block" style={{ marginBottom: 8 }} data-testid="docgroup-row">
            <div style={{ display: 'flex', gap: 8 }}>
              <input aria-label={`Group name ${i + 1}`} style={{ flex: 1 }} value={g.name} placeholder="e.g. Treasurer + Auditor" onChange={(e) => setGroup(i, 'name', e.target.value)} />
              <button type="button" className="btn secondary sm" onClick={() => setL((x) => ({ ...x, docGroups: x.docGroups.filter((_, j) => j !== i) }))}>Remove</button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {roleOpts.map((r) => <label key={r.id} className="pick-row" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}><input type="checkbox" checked={g.roles.includes(r.id)} onChange={(e) => setGroup(i, 'roles', e.target.checked ? [...g.roles, r.id] : g.roles.filter((x) => x !== r.id))} /> {r.name}</label>)}
            </div>
          </div>
        ))}
        <button type="button" className="btn secondary sm" data-testid="docgroup-add" onClick={() => setL((x) => ({ ...x, docGroups: [...x.docGroups, { name: '', roles: [] }] }))}>+ Add a document group</button>
      </div>
      <div className="card" style={{ marginTop: 12 }} data-testid="heads-card">
        <h2 style={{ margin: 0 }}>Accounts &amp; budget heads</h2>
        <p className="muted">What money is for. Every bank statement line is filed under one head, and budget lines pick the heads they count. “Other income” and “Other expense” always exist for anything unmatched. Pick a starting set, then edit freely.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <button type="button" className="btn secondary sm" data-testid="heads-generic" onClick={() => { preset(GENERIC_HEADS.income, GENERIC_HEADS.expense, GENERIC_HEADS.neutral); setL((x) => ({ ...x, bankRules: GENERIC_RULES.map((r) => ({ ...r })) })); }}>Use a general HOA / condo set (with starter rules)</button>
          <button type="button" className="btn secondary sm" data-testid="heads-india" onClick={() => { preset(DEFAULT_INCOME_HEADS, DEFAULT_EXPENSE_HEADS, DEFAULT_NEUTRAL_HEADS); setL((x) => ({ ...x, bankRules: [] })); }}>Use the original La Paloma set</button>
        </div>
        <div className="form-grid">
          <div className="field"><label>Income heads (one per line)</label><textarea aria-label="Income heads" data-testid="inc-text" rows={8} value={incText} onChange={(e) => setIncText(e.target.value)} /></div>
          <div className="field"><label>Expense heads (one per line)</label><textarea aria-label="Expense heads" data-testid="exp-text" rows={8} value={expText} onChange={(e) => setExpText(e.target.value)} /></div>
          <div className="field"><label>Not income or spend (transfers, deposits)</label><textarea aria-label="Neutral heads" data-testid="neu-text" rows={8} value={neuText} onChange={(e) => setNeuText(e.target.value)} /></div>
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }} data-testid="rules-card">
        <h2 style={{ margin: 0 }}>Bank statement matching rules</h2>
        <p className="muted">When a statement is imported, a line whose narration or party contains the words below is filed under that head. Your rules are tried first, then the built-in ones for heads you still use. Start the words and end with “/” to use a pattern, like /water\s+bill/.</p>
        {l.bankRules.map((r, i) => (
          <div key={i} className="form-grid" style={{ alignItems: 'end', marginBottom: 6 }} data-testid="rule-row">
            <div className="field"><label>Contains</label><input aria-label={`Rule words ${i + 1}`} value={r.match} placeholder="e.g. PLUMBER" onChange={(e) => setRule(i, 'match', e.target.value)} /></div>
            <div className="field"><label>File under</label><select aria-label={`Rule head ${i + 1}`} value={r.head} onChange={(e) => setRule(i, 'head', e.target.value)}><option value="">Choose a head</option>{allHeads.map((h) => <option key={h}>{h}</option>)}</select></div>
            <div className="field"><label>Only for</label><select aria-label={`Rule direction ${i + 1}`} value={r.only} onChange={(e) => setRule(i, 'only', e.target.value)}><option value="">Deposits and withdrawals</option><option value="in">Deposits (money in)</option><option value="out">Withdrawals (money out)</option></select></div>
            <button type="button" className="btn secondary sm" onClick={() => setL((x) => ({ ...x, bankRules: x.bankRules.filter((_, j) => j !== i) }))}>Remove</button>
          </div>
        ))}
        <button type="button" className="btn secondary sm" data-testid="rule-add" onClick={() => setL((x) => ({ ...x, bankRules: [...x.bankRules, { match: '', head: '', only: '' }] }))}>+ Add a rule</button>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h2 style={{ margin: 0 }}>Deposit &amp; investment types</h2>
        <p className="muted">The types you can choose when recording a fixed deposit or other investment. One per line.</p>
        <textarea aria-label="Deposit types" data-testid="dep-text" rows={5} style={{ width: '100%' }} value={depText} onChange={(e) => setDepText(e.target.value)} />
      </div>
      {err && <div className="field-error" data-testid="lists-error" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button type="button" className="btn" data-testid="lists-save" onClick={submit}>Save lists</button>
        <button type="button" className="btn secondary" data-testid="lists-reset" onClick={reset}>Back to the standard lists</button>
      </div>
      {saved && <div className="notice" data-testid="lists-saved" style={{ marginTop: 8 }}>Saved — reloading to apply…</div>}
    </div>
  );
}

export default function SetupModule() {
  const { roleId, hasPermission, tabAllowed } = useApp();
  const admin = roleId === 'super_admin';
  const [tab, setTab] = useState('blocks');
  const tabs = [
    { key: 'blocks', label: 'Blocks & units', hidden: !(admin || hasPermission('MANAGE_UNITS')) },
    { key: 'facilities', label: 'Facilities & locations', hidden: !(admin || hasPermission('MANAGE_UNITS') || hasPermission('MANAGE_AMENITIES')) },
    { key: 'details', label: 'Community details', hidden: !admin },
    { key: 'settings', label: 'Money & financial year', hidden: !admin },
    { key: 'lists', label: 'Lists', hidden: !admin },
  ].filter((t) => !t.hidden && (!tabAllowed || tabAllowed(`setup.${t.key}`)));
  const cur = tabs.find((t) => t.key === tab) ? tab : tabs[0]?.key;
  return (
    <div>
      <div className="page-head"><div><h1>Community setup</h1><p>Describe your community: blocks, facilities, name and address on receipts, currency and financial year. Everything else in the app follows this.</p></div></div>
      <SegTabs tabs={tabs} value={cur} onChange={setTab} label="Community setup sections" />
      {cur === 'blocks' && <BlocksTab />}
      {cur === 'facilities' && <FacilitiesTab />}
      {cur === 'details' && <DetailsTab />}
      {cur === 'settings' && <SettingsTab />}
      {cur === 'lists' && <ListsTab />}
    </div>
  );
}
