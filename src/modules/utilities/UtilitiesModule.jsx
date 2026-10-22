import { termsFor } from '../../lib/billTermsServer.js';
import { notify, notifyMany } from '../../lib/notify.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import UtilityBilling from './UtilityBilling.jsx';
import NoticeTemplateDesigner from '../communications/NoticeTemplateDesigner.jsx';
import AssocBills from './AssocBills.jsx';
import { takeHint } from '../../lib/openHint.js';
import React, { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import CustomFields from '../../components/CustomFields.jsx';
import Combobox from '../../components/Combobox.jsx';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { persistPending } from '../../lib/files/attachments.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { monthLabel, recentMonths, renderNotice, todayIso } from '../../lib/notice.js';
import { uuid } from '../../lib/uuid.js';
import { DEFAULT_UTILITY_TYPES, addUtilityToSchemas } from '../../lib/utilityTypes.js';

let typeList = DEFAULT_UTILITY_TYPES; // set by the screen each render (the types are data, not code)
const icon = (u) => typeList.find((t) => t.name === u)?.icon || '📊';
const labelOf = (u) => typeList.find((t) => t.name === u)?.label || u;
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const addDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const byUnit = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

// Water and DG bills are raised from the meter, so the photo of the meter is the evidence: a reading cannot be saved or published without one.
export const PHOTO_REQUIRED = ['Water', 'DG'];
const calcAmount = (units, tpl) => Math.round((Number(units) || 0) * (Number(tpl?.ratePerUnit) || 0) + (Number(tpl?.fixedCharge) || 0) + (Number(tpl?.tax) || 0));

/* ------------------------------------------------------------ reading form -- */
function ReadingForm({ utility, month, reading, units, prevInfo, saved, onClose, onSaved, onPublish, canWrite, existing, saveLabel = '' }) {
  const isNew = !reading?.id;
  const locked = reading?.status === 'Published' || !canWrite;
  const [unit, setUnit] = useState(reading?.unit || '');
  const initialPrev = reading?.previousReading ?? '';
  const [prev, setPrev] = useState(initialPrev);
  const [prevFrom, setPrevFrom] = useState(initialPrev !== '' && isNew ? prevInfo(reading?.unit)?.month || '' : '');
  const [prevEdited, setPrevEdited] = useState(false);
  const [curr, setCurr] = useState(reading?.currentReading ?? '');
  const [date, setDate] = useState(reading?.readingDate || todayIso());
  const [notes, setNotes] = useState(reading?.notes || '');
  const [photos, setPhotos] = useState(Array.isArray(reading?.photos) ? reading.photos : []);
  const [pending, setPending] = useState([]);
  const [error, setError] = useState('');
  const [fe, setFe] = useState({});
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => reading?.id || uuid());
  const { schemaFor } = useApp();
  const customKeys = (schemaFor(COLLECTIONS.READINGS)?.fields || []).filter((f) => f.isCustom).map((f) => f.key);
  const [cv, setCv] = useState(() => ({ ...(reading || {}) }));
  // utilities do not all measure the same things: each one can define extra inputs (Utilities -> Manage -> Inputs)
  const extraDefs = (typeList.find((t) => t.name === utility)?.extraInputs) || [];
  const [extras, setExtras] = useState(() => ({ ...(reading?.extras || {}) }));

  const consumed = Math.max(0, (Number(curr) || 0) - (Number(prev) || 0));

  // Previous reading = last month's current reading for that villa (whenever one exists), until the user types their own.
  function pickUnit(v) {
    setUnit(v);
    if (!isNew || prevEdited) return;
    const info = prevInfo(v.trim());
    setPrev(info ? info.value : '');
    setPrevFrom(info ? info.month : '');
  }

  async function save(thenPublish) {
    setError('');
    const er = {};
    if (!unit.trim()) er.unit = 'Villa / unit is required';
    if (prev === '') er.prev = 'Previous reading is required';
    if (curr === '') er.curr = 'Current reading is required';
    setFe(er);
    if (Object.keys(er).length) return;
    if (Number(curr) < Number(prev)) return setError('The current reading cannot be lower than the previous reading.');
    if (PHOTO_REQUIRED.includes(utility) && photos.length + pending.length === 0) { setFe({ photo: 'Add a photo of the meter showing the reading' }); return setError(`A photo of the ${utility} meter is required for every reading.`); }
    const missing = extraDefs.find((d) => d.required && (extras[d.key] === undefined || extras[d.key] === ''));
    if (missing) return setError(`${missing.label} is required for ${utility} readings.`);
    if (isNew && existing.some((r) => r.unit === unit.trim())) return setError(`${unit} already has a ${utility} reading for ${monthLabel(month)} — open it from the list instead.`);
    setBusy(true);
    try {
      let metas = photos;
      if (pending.length) {
        const added = await persistPending(pending, { ownerType: 'reading', ownerId: id });
        if (!added) { setBusy(false); return; }
        metas = [...photos, ...added];
      }
      const rec = await saved({
        ...(reading || {}), ...Object.fromEntries(customKeys.filter((k) => cv[k] !== undefined).map((k) => [k, cv[k]])), id, unit: unit.trim(), utility, month, readingDate: date, previousReading: Number(prev), currentReading: Number(curr),
        unitsConsumed: consumed, photos: metas, notes, ...(extraDefs.length ? { extras } : {}), status: reading?.status || 'Draft',
      });
      if (!rec) { setBusy(false); return; }
      if (thenPublish) onPublish([rec]); else onSaved();
    } finally {
      setBusy(false);
    }
  }

  const title = isNew ? `Record ${utility} meter reading` : `${utility} reading · ${reading.unit}`;
  const sub = locked
    ? `${reading?.status === 'Published' ? 'This reading has been published to the owner and is locked.' : 'Read-only.'} ${monthLabel(month)}.`
    : `Enter this month's ${labelOf(utility)} meter readings for ${monthLabel(month)} and attach photos of the meter. Save as a draft, then publish to bill the owner.`;

  return (
    <Modal title={title} subtitle={sub} onClose={onClose}>
      {error && <div className="notice error">{error}</div>}
      <div className="form-grid">
        <div className={`field${fe.unit ? ' invalid' : ''}`}><label>Villa / unit *</label>
          {isNew
            ? <Combobox value={unit} onChange={pickUnit} options={units} allowCustom placeholder="Search villa or unit…" />
            : <div className="ro-value">{unit}</div>}
          {fe.unit && <div className="field-error">{fe.unit}</div>}
        </div>
        <div className="field"><label>Reading taken on</label>
          {locked ? <div className="ro-value">{date}</div> : <input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />}
        </div>
        <div className={`field${fe.prev ? ' invalid' : ''}`}><label>Previous reading *</label>
          {locked ? <div className="ro-value">{prev}</div> : <input type="number" value={prev} onChange={(e) => { setPrev(e.target.value); setPrevEdited(true); setPrevFrom(''); }} />}
          {!locked && isNew && (prevFrom ? <small className="muted">Filled in from the {prevFrom} reading — change it if the meter was replaced.</small> : unit.trim() && !prevEdited && <small className="muted">No earlier reading found for this villa — enter the starting meter value.</small>)}
          {fe.prev && <div className="field-error">{fe.prev}</div>}
        </div>
        <div className={`field${fe.curr ? ' invalid' : ''}`}><label>Current reading *</label>
          {locked ? <div className="ro-value">{curr}</div> : <input type="number" value={curr} onChange={(e) => setCurr(e.target.value)} />}
          {fe.curr && <div className="field-error">{fe.curr}</div>}
        </div>
        <div className="field"><label>Units consumed</label><div className="ro-value"><b>{consumed}</b></div></div>
        {extraDefs.map((d) => (
          <div className="field" key={d.key} data-testid={`extra-${d.key}`}><label>{d.label}{d.unit ? ` (${d.unit})` : ''}{d.required ? ' *' : ''}</label>
            {locked ? <div className="ro-value">{extras[d.key] ?? '—'}</div>
              : <input type={d.type === 'number' ? 'number' : 'text'} aria-label={d.label} value={extras[d.key] ?? ''} onChange={(e) => setExtras((x) => ({ ...x, [d.key]: e.target.value }))} />}
          </div>
        ))}
        <div className="field"><label>Notes</label>
          {locked ? <div className="ro-value">{notes || '—'}</div> : <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. meter face was dirty" />}
        </div>
        <div className={`field${fe.photo ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }} data-testid="meter-photo-field"><label>Meter photos{PHOTO_REQUIRED.includes(utility) ? ' *' : ''}</label>
          <AttachmentList items={photos} onRemove={locked ? undefined : (i) => setPhotos(photos.filter((_, j) => j !== i))} />
          {!locked && <div style={{ marginTop: 8 }}><AttachmentPicker pending={pending} onChange={setPending} label="Add meter photos" /></div>}
          {fe.photo && <div className="field-error">{fe.photo}</div>}
        </div>
      </div>
      <CustomFields sectionId={COLLECTIONS.READINGS} value={cv} onChange={locked ? undefined : (k, v) => setCv((c) => ({ ...c, [k]: v }))} />
      <div className="form-actions">
        {!locked && <button className="btn" disabled={busy} onClick={() => save(false)}>{busy ? 'Saving…' : saveLabel || 'Save draft'}</button>}
        {!locked && <button className="btn secondary" disabled={busy} onClick={() => save(true)}>Save &amp; publish to owner…</button>}
        <button className="btn secondary" onClick={onClose}>{locked ? 'Close' : 'Cancel'}</button>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- publish -- */
function PublishForm({ utility, month, list, template, noticeTemplates, mergeFields, onClose, onDone }) {
  // Templates meant for this utility's bill (or for any), with the one made for it chosen first.
  const usable = noticeTemplates.filter((t) => !t.appliesTo || t.appliesTo === 'Any' || t.appliesTo === `${utility} bill`);
  const [tplId, setTplId] = useState((usable.find((t) => t.appliesTo === `${utility} bill`) || usable[0])?.id || '');
  const [dueDate, setDueDate] = useState(addDays(15));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const noticeTpl = noticeTemplates.find((t) => t.id === tplId);
  const sample = list[0];
  const noticeFor = (r) => renderNotice(noticeTpl?.body || '', {
    UTILITY_TYPE: utility, AMOUNT: calcAmount(r.unitsConsumed, template).toLocaleString('en-IN'), MONTH: monthLabel(month), DUE_DATE: dueDate, UNIT: r.unit,
    PREVIOUS_READING: String(r.previousReading ?? ''), CURRENT_READING: String(r.currentReading ?? ''), UNITS_CONSUMED: String(r.unitsConsumed ?? ''),
    RATE: String(template?.ratePerUnit ?? ''), FIXED_CHARGE: String(template?.fixedCharge ?? 0), TAX: String(template?.tax ?? 0),
  }, mergeFields);
  const ready = list.filter((r) => (r.photos || []).length > 0);
  const noPhoto = list.filter((r) => (r.photos || []).length === 0);
  const total = ready.reduce((s, r) => s + calcAmount(r.unitsConsumed, template), 0);

  async function publish() {
    setError('');
    if (!template || !(Number(template.ratePerUnit) > 0)) return setError(`Set the ${utility} rate card first (Utilities → Utility billing).`);
    if (!dueDate) return setError('Choose the payable-by date.');
    if (ready.length === 0) return setError('Add at least one meter photo to each reading before publishing it.');
    setBusy(true);
    let done = 0;
    try {
      // one batch for the whole run: all bills, all reading updates and all notices are written in single operations
      const created = await secureStorage.createMany(COLLECTIONS.DUES, ready.map((r) => ({
        unit: r.unit, category: utility, amount: calcAmount(r.unitsConsumed, template), billedMonth: monthLabel(month), dueDate, status: 'Unpaid', paymentMode: '',
        description: `${labelOf(utility)} ${monthLabel(month)}: meter ${r.previousReading} → ${r.currentReading} = ${r.unitsConsumed} ${typeList.find((t) => t.name === utility)?.unitName || 'units'}`,   // the bill's line (the notice is the letter)
        readingId: r.id, previousReading: r.previousReading, currentReading: r.currentReading, unitsConsumed: r.unitsConsumed,
        ratePerUnit: Number(template.ratePerUnit) || 0, fixedCharge: Number(template.fixedCharge) || 0, tax: Number(template.tax) || 0,
        notice: noticeFor(r), photos: r.photos || [],
      })), { label: 'Billing & Finance', summary: `Published ${ready.length} ${utility} bills for ${monthLabel(month)}` });
      await secureStorage.updateMany(COLLECTIONS.READINGS, ready.map((r, i) => ({ id: r.id, status: 'Published', publishedAt: todayIso(), dueId: created[i].id })), { label: 'Utility Readings', summary: `${ready.length} ${utility} readings published` });
      done = created.length;
      const termsMap = new Map(); for (const due of created) termsMap.set(due.id, await termsFor(due));
      notifyMany(created.map((due) => ({ event: 'bill', title: `${utility} bill · ${monthLabel(month)}`, body: `Your ${utility} bill for ${monthLabel(month)} is ₹${Number(due.amount).toLocaleString('en-IN')}, payable by ${dueDate}.${termsMap.get(due.id) || ''}`, link: '#/billing', toUnit: due.unit, by: getPrincipal()?.name || '' }))).catch(() => {});
    } catch (e) { setError(e.message || 'Could not publish the bills'); }
    setBusy(false);
    setResult({ done, skipped: noPhoto.length });
    onDone();
  }

  const title = list.length === 1 ? `Publish ${utility} bill · ${sample.unit}` : `Publish ${list.length} ${utility} bills`;

  return (
    <Modal
      title={result ? 'Bills published' : title}
      subtitle={result ? 'Owners can now see these in Billing & Finance → Dues.' : `Turn ${monthLabel(month)} readings into bills. Each owner gets the notice, the calculation and the meter photos under Dues.`}
      onClose={onClose}>
      {result ? (
        <div>
          <div className="notice">✅ {result.done} bill{result.done === 1 ? '' : 's'} published to owners.{result.skipped ? ` ${result.skipped} skipped — no meter photo.` : ''}</div>
          <div className="form-actions"><button className="btn" onClick={onClose}>Done</button></div>
        </div>
      ) : (
        <>
          {error && <div className="notice error">{error}</div>}
          <div className="form-grid">
            <div className="field"><label>Notice template</label>
              <select value={tplId} onChange={(e) => setTplId(e.target.value)}>
                {usable.length === 0 && <option value="">No templates — a plain bill is sent</option>}
                {usable.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="field"><label>Payable by *</label><input type="date" value={dueDate} min={todayIso()} onChange={(e) => setDueDate(e.target.value)} /></div>
          </div>
          <div className="ro-block" style={{ marginTop: 12 }}>
            <h3>{icon(utility)} Rate card — {utility}</h3>
            <div className="kv">
              <span>Rate per unit</span><b>₹{template?.ratePerUnit ?? 0}</b>
              <span>Fixed charge</span><b>{inr(template?.fixedCharge)}</b>
              <span>Tax</span><b>{inr(template?.tax)}</b>
              {list.length === 1 && <><span>{sample.unitsConsumed} units consumed</span><b>{inr(calcAmount(sample.unitsConsumed, template))}</b></>}
              {list.length > 1 && <><span>{ready.length} bill{ready.length === 1 ? '' : 's'} ready</span><b>{inr(total)}</b></>}
            </div>
          </div>
          {noPhoto.length > 0 && <div className="notice error" style={{ marginTop: 12 }}>📷 {noPhoto.map((r) => r.unit).join(', ')} {noPhoto.length === 1 ? 'has' : 'have'} no meter photo and will be skipped — open the reading and add one.</div>}
          {sample && noticeTpl && (
            <div className="ro-block" style={{ marginTop: 12 }}>
              <h3>✉ Preview — {sample.unit}</h3>
              <div className="notice-text">{noticeTpl.headerText ? `${renderNotice(noticeTpl.headerText, {}, mergeFields)}\n\n` : ''}{noticeFor(sample)}</div>
            </div>
          )}
          <div className="form-actions">
            <button className="btn" disabled={busy || ready.length === 0} onClick={publish}>{busy ? 'Publishing…' : `Publish ${ready.length} bill${ready.length === 1 ? '' : 's'}`}</button>
            <button className="btn secondary" onClick={onClose}>Cancel</button>
          </div>
        </>
      )}
    </Modal>
  );
}

/* ----------------------------------------------------------------- page -- */
export default function UtilitiesModule({ onNavigate, hideAssoc = false }) {
  const { records: readings, save: saveReading } = useCollection(COLLECTIONS.READINGS, 'Utility Readings');
  const { records: properties } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const { records: dues } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');
  const { records: templates } = useCollection(COLLECTIONS.BILLING_TEMPLATES, 'Utility Billing Templates');
  const { records: noticeTemplates } = useCollection(COLLECTIONS.NOTICE_TEMPLATES, 'Notice Templates');
  const { records: mergeFields } = useCollection(COLLECTIONS.MERGE_FIELDS, 'Merge Field Library');

  const { roleId, hasPermission, tabAllowed } = useApp();
  // same access as the old Billing → Utility billing tab (accounting roles, EC, Facility Manager), same per-role tab switch
  const canBilling = (hasPermission('MANAGE_LEDGER') || hasPermission('MANAGE_UTILITY_BILLING') || roleId === 'facility_manager') && tabAllowed('billing.utility');
  const { records: typeRows, save: saveType } = useCollection(COLLECTIONS.UTILITY_TYPES, 'Utility Types');
  const activeTypes = (typeRows.length ? typeRows : DEFAULT_UTILITY_TYPES).filter((t) => t.active !== false);
  typeList = typeRows.length ? typeRows : DEFAULT_UTILITY_TYPES;
  const UTILITIES = activeTypes.map((t) => t.name);
  const canTypes = roleId === 'super_admin' || hasPermission('MANAGE_UTILITY_TYPES');
  const [managing, setManaging] = useState(false);
  const canReadings = roleId === 'super_admin' || hasPermission('MANAGE_UTILITY_READINGS') || hasPermission('MANAGE_UTILITY_BILLING') || hasPermission('MANAGE_UTILITY_TYPES') || canWriteCollection(COLLECTIONS.READINGS, getPrincipal());
  const [utabRaw, setUtab] = useState(() => takeHint(hideAssoc ? ['readings', 'billing', 'templates'] : ['readings', 'billing', 'templates', 'assoc']) || 'readings');
  const showReadings = canReadings && tabAllowed('util.readings');
  const canAssoc = !hideAssoc && tabAllowed('util.assoc') && (canBilling || canReadings || canWriteCollection(COLLECTIONS.ASSOC_BILLS, getPrincipal()));
  const utab = utabRaw === 'assoc' && canAssoc ? 'assoc' : !showReadings && (canBilling || canTemplates) ? (utabRaw === 'templates' && canTemplates ? 'templates' : canBilling ? 'billing' : 'templates') : utabRaw;
  const canTemplates = roleId === 'super_admin' || canWriteCollection(COLLECTIONS.NOTICE_TEMPLATES, getPrincipal());
  const [utility, setUtility] = useState('Water');
  const [month, setMonth] = useState(recentMonths(0)[0]);
  const [view, setView] = useState(null); // { mode:'edit', reading?, unit? } | { mode:'publish', list }
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState('');
  const [blockF, setBlockF] = useState('');
  const [page, setPage] = useState(0);
  const PAGE = 50;   // a page of units at a time: a 1,000-unit community is entered block by block, not by scrolling

  const canWrite = canWriteCollection(COLLECTIONS.READINGS, getPrincipal());
  const months = useMemo(() => recentMonths(12), []);
  const template = templates.find((t) => t.type === utility);
  const unitOptions = useMemo(() => [...properties].sort((a, b) => byUnit(a.unit, b.unit)).map((p) => ({ value: p.unit, label: p.unit, hint: p.owner })), [properties]);

  const forMonth = readings.filter((r) => r.utility === utility && r.month === month);
  const rows = useMemo(() => {
    const units = [...new Set([...properties.map((p) => p.unit), ...forMonth.map((r) => r.unit)])].sort(byUnit);
    return units.map((u) => {
      const r = forMonth.find((x) => x.unit === u);
      const prop = properties.find((p) => p.unit === u);
      return { unit: u, owner: prop?.owner || '', block: prop?.zone || '', reading: r, status: r ? r.status : 'Not recorded' };
    });
  }, [properties, forMonth]);

  const blocks = useMemo(() => [...new Set(rows.map((r) => r.block).filter(Boolean))].sort(), [rows]);
  const filtered = rows.filter((r) => (!statusF || r.status === statusF) && (!blockF || r.block === blockF) && (!q || `${r.unit} ${r.owner}`.toLowerCase().includes(q.toLowerCase())));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const at = Math.min(page, pages - 1);
  const shown = filtered.slice(at * PAGE, at * PAGE + PAGE);
  React.useEffect(() => { setPage(0); }, [utility, month, q, statusF, blockF]);
  // the next unit still to be read (in the filter), so a meter reader can go from one to the next without hunting in a long list
  const nextToRead = filtered.find((r) => r.status === 'Not recorded');
  const drafts = forMonth.filter((r) => r.status === 'Draft');
  const published = forMonth.filter((r) => r.status === 'Published').length;

  // Latest earlier reading for the villa: from the readings sheet, else from the last published bill's meter values.
  function prevInfo(unit) {
    if (!unit) return null;
    const earlier = readings.filter((r) => r.unit === unit && r.utility === utility && r.month < month).sort((a, b) => b.month.localeCompare(a.month));
    if (earlier[0]) return { value: earlier[0].currentReading, month: monthLabel(earlier[0].month) };
    const bill = dues.filter((d) => d.unit === unit && d.category === utility && d.readingId && d.currentReading !== undefined).sort((a, b) => String(b.dueDate).localeCompare(String(a.dueDate)))[0];
    return bill ? { value: bill.currentReading, month: bill.billedMonth } : null;
  }

  const tone = { 'Not recorded': '', Draft: 'orange', Published: 'green' };

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Utilities — meter readings</h1>
          <p>Record each villa’s monthly meter readings with photos, then publish them as bills. Owners see the readings and photos in Billing &amp; Finance → Dues.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canTypes && <button className="btn secondary" data-testid="manage-utilities" onClick={() => setManaging(true)}>⚙ Manage utilities</button>}
          {canWrite && <button className="btn secondary" onClick={() => setView({ mode: 'edit' })}>+ Add reading</button>}
          {canWrite && <button className="btn" disabled={drafts.length === 0} onClick={() => setView({ mode: 'publish', list: drafts })}>Publish all drafts{drafts.length ? ` (${drafts.length})` : ''}</button>}
        </div>
      </div>

      {(canTemplates || canBilling || canAssoc) && (showReadings ? 1 : 0) + (canBilling ? 1 : 0) + (canAssoc ? 1 : 0) + (canTemplates && tabAllowed('util.templates') ? 1 : 0) > 1 && <div className="tabs" data-testid="util-tabs">{showReadings && <button type="button" data-testid="utab-readings" className={utab === 'readings' ? 'active' : ''} onClick={() => setUtab('readings')}>Meter readings</button>}{canBilling && <button type="button" data-testid="utab-billing" className={utab === 'billing' ? 'active' : ''} onClick={() => setUtab('billing')}>Utility billing</button>}{canAssoc && <button type="button" data-testid="utab-assoc" className={utab === 'assoc' ? 'active' : ''} onClick={() => setUtab('assoc')}>Association bills</button>}{canTemplates && tabAllowed('util.templates') && <button type="button" data-testid="utab-templates" className={utab === 'templates' ? 'active' : ''} onClick={() => setUtab('templates')}>Bill templates</button>}</div>}
      {utab === 'assoc' && canAssoc ? <AssocBills onNavigate={onNavigate} /> : null}
      {utab === 'billing' && canBilling ? <UtilityBilling /> : null}
      {utab === 'assoc' && canAssoc ? null : utab === 'billing' && canBilling ? null : utab === 'templates' && canTemplates ? <NoticeTemplateDesigner scope="utility" /> : (<>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="month-nav">
          <div className="tabs" style={{ margin: 0 }}>
            {UTILITIES.map((u) => <button key={u} className={utility === u ? 'active' : ''} onClick={() => setUtility(u)}>{icon(u)} {labelOf(u)}</button>)}
          </div>
          <select aria-label="Month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 'auto' }}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <input aria-label="Search villa" placeholder="Search villa or owner…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 'auto', minWidth: 180 }} />
          {blocks.length > 0 && (
            <select aria-label="Block" data-testid="reading-block" value={blockF} onChange={(e) => setBlockF(e.target.value)} style={{ width: 'auto' }}>
              <option value="">All blocks</option>
              {blocks.map((b) => <option key={b}>{b}</option>)}
            </select>
          )}
          <select aria-label="Status" value={statusF} onChange={(e) => setStatusF(e.target.value)} style={{ width: 'auto' }}>
            <option value="">All status</option>
            <option>Not recorded</option><option>Draft</option><option>Published</option>
          </select>
          {canWrite && nextToRead && <button type="button" className="btn secondary" data-testid="next-to-read" onClick={() => setView({ mode: 'edit', reading: null, unit: nextToRead.unit, next: true })}>Next to read: {nextToRead.unit}</button>}
        </div>
      </div>

      <div className="grid metrics" style={{ marginBottom: 16 }}>
        <div className="card metric"><div className="label">Villas / units</div><div className="value">{rows.length}</div></div>
        <div className="card metric"><div className="label">Readings recorded</div><div className="value">{forMonth.length}</div><div className="muted">{rows.length - forMonth.length} still to record</div></div>
        <div className="card metric"><div className="label">Drafts</div><div className="value">{drafts.length}</div><div className="muted">Waiting to be published</div></div>
        <div className="card metric"><div className="label">Published</div><div className="value">{published}</div><div className="muted">Billed to owners</div></div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="resp-table">
            <thead><tr><th>Villa / unit</th><th>Owner</th><th>Previous</th><th>Current</th><th>Units</th><th>Photos</th><th>Status</th><th /></tr></thead>
            <tbody>
              {shown.map((r) => {
                const x = r.reading;
                return (
                  <tr key={r.unit} className="clickable" onClick={() => setView({ mode: 'edit', reading: x, unit: r.unit })}>
                    <td data-label="Villa / unit"><b>{r.unit}</b></td>
                    <td data-label="Owner">{r.owner || '—'}</td>
                    <td data-label="Previous">{x ? x.previousReading : '—'}</td>
                    <td data-label="Current">{x ? x.currentReading : '—'}</td>
                    <td data-label="Units">{x ? x.unitsConsumed : '—'}</td>
                    <td data-label="Photos">{x ? (x.photos || []).length : '—'}</td>
                    <td data-label="Status"><span className={`tag ${tone[r.status]}`}>{r.status}</span></td>
                    <td data-label=""><button type="button" className="btn secondary" onClick={(e) => { e.stopPropagation(); setView({ mode: 'edit', reading: x, unit: r.unit }); }}>{!x ? (canWrite ? 'Enter reading' : 'View') : x.status === 'Published' || !canWrite ? 'View' : 'Edit'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && <div className="empty">No villas match.</div>}
        {filtered.length > PAGE && (
          <div className="pager" data-testid="reading-pager">
            <button type="button" className="btn secondary sm" disabled={at === 0} onClick={() => setPage(at - 1)}>‹ Previous</button>
            <span className="muted">{at * PAGE + 1}–{Math.min(filtered.length, at * PAGE + PAGE)} of {filtered.length}</span>
            <button type="button" className="btn secondary sm" disabled={at >= pages - 1} onClick={() => setPage(at + 1)}>Next ›</button>
          </div>
        )}
      </div>

      </>)}
      {managing && <ManageUtilities rows={typeRows.length ? typeRows : DEFAULT_UTILITY_TYPES} save={saveType} onPicked={(n) => { setUtility(n); }} onClose={() => setManaging(false)} />}
      {view?.mode === 'edit' && (
        <ReadingForm
          key={view.reading?.id || view.unit || 'new'}
          utility={utility} month={month} reading={view.reading || (view.unit ? { unit: view.unit, previousReading: prevInfo(view.unit)?.value ?? '' } : null)}
          units={unitOptions} prevInfo={prevInfo} saved={saveReading} existing={forMonth} canWrite={canWrite}
          onClose={() => setView(null)} onPublish={(list) => setView({ mode: 'publish', list })}
          onSaved={() => {
            if (!view.next) return setView(null);
            const after = filtered.find((x) => x.status === 'Not recorded' && x.unit !== view.unit);
            setView(after ? { mode: 'edit', reading: null, unit: after.unit, next: true } : null);
          }}
          saveLabel={view.next ? 'Save & next' : ''}
        />
      )}
      {view?.mode === 'publish' && (
        <PublishForm
          utility={utility} month={month} list={view.list} template={template} noticeTemplates={noticeTemplates} mergeFields={mergeFields}
          onClose={() => setView(null)} onDone={() => {}}
        />
      )}
    </div>
  );
}

/* Super Admin: add a new metered utility (gas, borewell, EV charging …) or retire one. A new utility immediately gets readings, a rate card and bills. */
function ManageUtilities({ rows, save, onPicked, onClose }) {
  const [f, setF] = useState({ name: '', icon: '🔥', label: '', unitName: 'units' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [openInputs, setOpenInputs] = useState(null);
  const [inp, setInp] = useState({ label: '', type: 'number', unit: '', required: false });
  async function add() {
    const name = f.name.trim();
    if (!name) return setErr('Name the utility, e.g. Gas');
    if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) return setErr(`${name} already exists`);
    setBusy(true); setErr('');
    const rec = await save({ name, icon: f.icon || '📊', label: f.label.trim() || name, unitName: f.unitName.trim() || 'units', active: true });
    if (rec) { await addUtilityToSchemas(name); onPicked(name); setF({ name: '', icon: '🔥', label: '', unitName: 'units' }); }
    setBusy(false);
  }
  async function toggle(r) { if (r.id?.startsWith('ut-')) return; await save({ ...r, active: r.active === false }); }
  return (
    <Modal title="Manage utilities" subtitle="Metered utilities billed per unit from monthly readings." onClose={onClose}>
      {err && <div className="notice error">{err}</div>}
      <ul className="list" data-testid="utility-list">
        {rows.map((r) => (
          <li key={r.id}><span>{r.icon} <b>{r.label || r.name}</b> <small className="muted">· {r.name} · measured in {r.unitName || 'units'}</small></span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button type="button" className="btn secondary sm" data-testid={`inputs-${r.name}`} onClick={() => setOpenInputs((k) => (k === r.id ? null : r.id))}>Inputs{(r.extraInputs || []).length ? ` (${r.extraInputs.length + 2})` : ' (2)'}</button>
              {r.id?.startsWith('ut-') ? <span className="tag">Built-in</span> : <button type="button" className="btn secondary sm" onClick={() => toggle(r)}>{r.active === false ? 'Enable' : 'Retire'}</button>}
            </span>
          </li>
        ))}
      </ul>
      {openInputs && (() => {
        const r = rows.find((x) => x.id === openInputs); if (!r) return null;
        const list = r.extraInputs || [];
        const setList = (next) => save({ ...r, extraInputs: next });
        return (
          <div className="card" data-testid="inputs-editor" style={{ marginTop: 8 }}>
            <b>{r.icon} {r.name} - what is recorded with each reading</b>
            <ul className="list" style={{ marginTop: 6 }}>
              <li><span>Previous reading · Current reading <small className="muted">(always - units consumed are worked out from these)</small></span><span className="tag">Built-in</span></li>
              {list.map((d) => <li key={d.key}><span>{d.label}{d.unit ? ` (${d.unit})` : ''} <small className="muted">· {d.type}{d.required ? ' · required' : ''}</small></span><button type="button" className="btn secondary sm" onClick={() => setList(list.filter((x) => x.key !== d.key))}>Remove</button></li>)}
            </ul>
            <div className="form-grid">
              <div className="field"><label>New input</label><input aria-label="Input label" value={inp.label} onChange={(e) => setInp({ ...inp, label: e.target.value })} placeholder="e.g. Tank level, Hours run, Diesel filled" /></div>
              <div className="field"><label>Type</label><select aria-label="Input type" value={inp.type} onChange={(e) => setInp({ ...inp, type: e.target.value })}><option value="number">Number</option><option value="text">Text</option></select></div>
              <div className="field"><label>Unit (optional)</label><input aria-label="Input unit" value={inp.unit} onChange={(e) => setInp({ ...inp, unit: e.target.value })} placeholder="L, hrs, %…" /></div>
              <label className="check"><input type="checkbox" checked={inp.required} onChange={(e) => setInp({ ...inp, required: e.target.checked })} /> Required</label>
            </div>
            <button type="button" className="btn sm" data-testid="add-input" disabled={!inp.label.trim()} onClick={async () => {
              const key = inp.label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `in_${list.length + 1}`;
              if (list.some((d) => d.key === key)) return;
              await setList([...list, { key, label: inp.label.trim(), type: inp.type, unit: inp.unit.trim(), required: inp.required }]);
              setInp({ label: '', type: 'number', unit: '', required: false });
            }}>Add input</button>
          </div>
        );
      })()}
      <h4 style={{ margin: '14px 0 6px' }}>Add a utility</h4>
      <div className="form-grid">
        <div className="field"><label>Name *</label><input aria-label="Utility name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Gas" /></div>
        <div className="field"><label>Icon</label><input aria-label="Utility icon" value={f.icon} maxLength={4} onChange={(e) => setF({ ...f, icon: e.target.value })} /></div>
        <div className="field"><label>Display label</label><input aria-label="Utility label" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Piped gas" /></div>
        <div className="field"><label>Measured in</label><input aria-label="Measured in" value={f.unitName} onChange={(e) => setF({ ...f, unitName: e.target.value })} placeholder="m³" /></div>
      </div>
      <p className="muted" style={{ fontSize: 13 }}>After adding, set its rate in Billing &amp; Finance → Utility billing, then record readings here. Bills and collections flow into Dues and the Payments cross-check like Water and DG.</p>
      <div className="form-actions"><button className="btn" disabled={busy} data-testid="add-utility" onClick={add}>Add utility</button><button className="btn secondary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
