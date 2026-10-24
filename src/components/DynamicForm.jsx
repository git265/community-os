import React, { useEffect, useState } from 'react';
import { maxLengthFor } from '../lib/fieldLimits.js';
import { canEdit, canView } from '../lib/access/permissions.js';
import RecordMeta from './RecordMeta.jsx';
import SpecsField from './SpecsField.jsx';
import Combobox from './Combobox.jsx';
import RichTextEditor from './RichTextEditor.jsx';
import RichText from './RichText.jsx';
import { AttachmentList, AttachmentPicker } from './Attachments.jsx';
import { persistPending } from '../lib/files/attachments.js';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { useApp } from '../context/AppContext.jsx';
import { findSimilar, isSameName } from '../lib/fuzzy.js';
import { uuid } from '../lib/uuid.js';
import { PhoneInput, PeopleEditor, peopleErrors } from './PeopleFields.jsx';
import { validatePhone } from '../lib/phone.js';
import AdminDelete from './AdminDelete.jsx';

/**
 * Renders an editable form for one record, purely from a section's schema.
 * A field only appears if the current role can view it; it's only an
 * <input>/<select> (vs. read-only text) if the current role can edit it.
 * This is what makes "all fields editable" a schema property, not something
 * hardcoded per module - and why adding a Super-Admin custom attribute
 * makes it show up in every form/table for that section immediately.
 */
const today = () => new Date().toISOString().slice(0, 10);

/** "This looks like something that already exists" - shown under a name field so duplicates get caught while typing. */
function SimilarNotice({ text, rows, fieldKey, exclude, noun }) {
  const hits = findSimilar(text, rows, { key: fieldKey, exclude });
  if (!hits.length) return null;
  const exact = hits.some((h) => isSameName(text, h.record[fieldKey]));
  return (
    <div className={`notice${exact ? ' error' : ''}`} style={{ marginTop: 6 }}>
      {exact ? '🚫 Already exists: ' : '⚠ Similar to an existing entry — is it the same one? '}
      {hits.map((h) => <b key={h.record.id} style={{ marginRight: 8 }}>{h.record[fieldKey]}{h.record.shortId ? ` (${h.record.shortId})` : ''}</b>)}
      <div className="muted" style={{ fontSize: 12 }}>{exact ? `Open the existing ${noun.toLowerCase()} instead of adding it again.` : 'Open it from the list if so, to avoid a duplicate.'}</div>
    </div>
  );
}

/** A list of short text values: type one and press Enter / Add; click a chip's × to remove it. */
export function TagsInput({ list, onChange, label, placeholder = 'Type a value and press Enter' }) {
  const [text, setText] = useState('');
  const add = () => {
    const v = text.trim();
    if (!v) return;
    if (!list.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...list, v]);
    setText('');
  };
  return (
    <div>
      <div className="chip-row" style={{ marginBottom: 6 }}>
        {list.map((t) => (
          <span key={t} className="chip-btn on tag-chip">{t}
            <button type="button" className="chip-x" aria-label={`Remove ${t}`} title={`Remove ${t}`} onClick={() => onChange(list.filter((x) => x !== t))}>✕</button>
          </span>
        ))}
        {!list.length && <small className="muted">None yet</small>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input type="text" aria-label={`Add to ${label}`} value={text} maxLength={2000} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
        <button type="button" className="btn secondary" onClick={add}>Add</button>
      </div>
    </div>
  );
}

export default function DynamicForm({ schema, roleId, record, onSave, onCancel, readOnly = false, extra = null, impact = null, noDelete = false, deleteSlot = null, belowActions = null }) {
  const [ack, setAck] = useState(false);
  // New records get their UUID up front so attached files can point at the record they belong to.
  const [draft, setDraft] = useState(() => ({ ...record, ...(record.id ? {} : { id: uuid() }) }));
  const [errors, setErrors] = useState({});
  const [pending, setPending] = useState({}); // files staged per field; stored only when the form is saved
  const [saving, setSaving] = useState(false);
  const [lookups, setLookups] = useState({}); // field.key -> [{value,label,hint}]
  const { roles = [], role: me } = useApp();
  const mayRename = roleId === 'super_admin' || me?.category === 'EC';
  const lockedField = (f) => !!f.fixedAfterCreate && !!record?.id && !mayRename; // e.g. an asset's name: only an admin or EC member changes it after it is saved
  const [existing, setExisting] = useState([]); // same-collection rows, for "looks like an existing record" warnings
  const [existingErr, setExistingErr] = useState(''); // the list could not be read: the duplicate check did not run

  // a field can show only in some cases, e.g. { showWhen: { key: 'type', in: ['UPS / battery'] } } or { showWhen: { key: 'quantity', gt: 1 } }
  const showNow = (f) => { const w = f.showWhen; if (!w) return true; const v = draft[w.key]; if (w.in) return w.in.some((x) => String(x).toLowerCase() === String(v ?? '').toLowerCase()); if (w.gt != null) return Number(v) > w.gt; if (w.equals != null) return v === w.equals; return true; };
  const fields = schema.fields.filter((f) => canView(f, roleId) && !f.hidden && showNow(f));
  // nothing here this person may change: the form is for reading - no Save (the server would refuse it anyway)
  const viewOnly = readOnly || !fields.some((f) => canEdit(f, roleId) && !lockedField(f));
  // a field can be mandatory only in some cases, e.g. { requiredWhen: { key: 'access', equals: 'Villa owner / resident' } }
  const isRequired = (f) => !!f.required || (!!f.requiredWhen && draft[f.requiredWhen.key] === f.requiredWhen.equals);

  const lookupFields = fields.filter((f) => f.type === 'lookup' && f.lookup);
  useEffect(() => {
    let on = true;
    (async () => {
      const out = {};
      for (const f of lookupFields) {
        const { source, valueKey, labelKeys = [valueKey], hintKey, where } = f.lookup;
        let defaults = f.lookup.defaults || [];
        // choices kept as a list on a settings row (e.g. the property types in Community setup)
        if (f.lookup.defaultsFrom) { try { const row = (await secureStorage.list(f.lookup.defaultsFrom.collection))[0]; defaults = [...new Set([...(row?.[f.lookup.defaultsFrom.key] || []), ...defaults])]; } catch { /* not readable */ } }
        let rows = [];
        try { rows = await secureStorage.list(source); } catch { /* not readable by this role */ }
        if (where) rows = rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
        out[f.key] = rows
          .filter((r) => r[valueKey])
          .map((r) => ({ value: r[valueKey], label: labelKeys.map((k) => r[k]).filter(Boolean).join(' · '), hint: hintKey ? r[hintKey] : '' }));
        // a list that grows by use: the built-in choices plus every value already saved (typing a new one adds it for next time)
        if (f.lookup.distinct) {
          const seen = new Set(); const all = [...defaults.map((d) => ({ value: d, label: d, hint: '' })), ...out[f.key]];
          out[f.key] = all.filter((o) => { const k = String(o.value).trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
        }
      }
      if (on) setLookups(out);
    })();
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema.id]);

  const needsExisting = schema.fields.some((f) => f.suggestSimilar);
  useEffect(() => {
    if (!needsExisting) return;
    let on = true;
    setExistingErr('');
    secureStorage.list(schema.id).then((rows) => on && setExisting(rows)).catch((e) => on && setExistingErr(e?.message || 'the list could not be read'));
    return () => { on = false; };
  }, [schema.id, needsExisting]);

  function setValue(key, value) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function renderInput(field) {
    const value = draft[field.key] ?? '';
    const editable = !readOnly && canEdit(field, roleId) && !lockedField(field);

    if (field.type === 'files') {
      const items = Array.isArray(draft[field.key]) ? draft[field.key] : [];
      return (
        <div>
          <AttachmentList items={items} onRemove={editable ? (i) => setValue(field.key, items.filter((_, j) => j !== i)) : undefined} />
          {editable && <div style={{ marginTop: 8 }}><AttachmentPicker pending={pending[field.key] || []} onChange={(list) => setPending((p) => ({ ...p, [field.key]: list }))} /></div>}
        </div>
      );
    }
    if (field.type === 'specs') return <SpecsField type={draft.type} value={draft[field.key]} editable={editable} onChange={(v) => setValue(field.key, v)} />;
    if (field.type === 'tags') {
      const list = Array.isArray(draft[field.key]) ? draft[field.key] : [];
      if (!editable) return <div className="ro-value">{list.length ? list.join(', ') : '—'}</div>;
      return <TagsInput list={list} onChange={(l) => setValue(field.key, l)} label={field.label} placeholder={field.placeholder || 'Type a value and press Enter'} />;
    }
    if (field.type === 'roles') {
      const picked = Array.isArray(draft[field.key]) ? draft[field.key] : [];
      const name = (id) => (id === 'group:EC' ? 'Executive Committee' : roles.find((r) => r.id === id)?.name || id);
      if (!editable) return <div className="ro-value">{picked.length ? picked.map(name).join(', ') : '—'}</div>;
      const toggle = (id) => setValue(field.key, picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
      return (
        <div className="chip-row">
          {field.groups && (
            <label className={`chip-btn${picked.includes('group:EC') ? ' on' : ''}`}>
              <input type="checkbox" checked={picked.includes('group:EC')} onChange={() => toggle('group:EC')} style={{ display: 'none' }} />
              Executive Committee <small>· all EC roles</small>
            </label>
          )}
          {roles.map((r) => (
            <label key={r.id} className={`chip-btn${picked.includes(r.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={picked.includes(r.id)} onChange={() => toggle(r.id)} style={{ display: 'none' }} />
              {r.name} <small>· {r.category}</small>
            </label>
          ))}
        </div>
      );
    }
    if (field.type === 'people') {
      const list = Array.isArray(draft[field.key]) ? draft[field.key] : [];
      if (!editable) return <div className="ro-value">{list.length ? list.map((x) => `${x.name} (${x.relation})`).join(', ') : '—'}</div>;
      return <PeopleEditor list={list} onChange={(l) => setValue(field.key, l)} errors={errors[field.key] && typeof errors[field.key] === 'object' ? errors[field.key] : {}} />;
    }
    if (field.type === 'richtext') {
      return editable
        ? <RichTextEditor value={draft[field.key] || ''} onChange={(h) => setValue(field.key, h)} placeholder={field.placeholder || ''} minHeight={90} images={!field.noImages} />
        : <div className="ro-value ro-rich">{draft[field.key] ? <RichText html={draft[field.key]} /> : '—'}</div>;
    }
    if (!editable) {
      // the same field as on the edit screen, shown in light grey: a tick box stays a tick box, a choice keeps its arrow
      if (field.type === 'boolean') return <input type="checkbox" checked={!!value} disabled aria-label={field.label} />;
      const opt = field.type === 'lookup' ? (lookups[field.key] || []).find((o) => o.value === value) : null;
      const stampAt = field.type === 'date' && value ? record?.dateStamps?.[field.key] : '';
      const shown = String(opt?.label || value || '—');
      const cls = `ro-value${['select', 'lookup'].includes(field.type) ? ' ro-select' : field.type === 'textarea' ? ' ro-text' : ''}${field.strong ? ' ro-strong' : ''}`;
      return <div className={cls} aria-readonly="true" style={field.type === 'textarea' ? { whiteSpace: 'pre-wrap', minHeight: 64 } : undefined}>{shown}{stampAt ? <small className="muted" title="When this date was recorded"> · {new Date(stampAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small> : null}</div>;
    }

    switch (field.type) {
      case 'phone':
        return <PhoneInput value={value} onChange={(v) => setValue(field.key, v)} label={field.label} invalid={!!errors[field.key]} testid={`phone-${field.key}`} />;
      case 'lookup':
        return <Combobox value={value} onChange={(v) => setValue(field.key, v)} options={lookups[field.key] || []} allowCustom={!!field.lookup?.allowCustom} placeholder={`Search ${field.label.toLowerCase()}…`} invalid={!!errors[field.key]} />;
      case 'select':
        return (
          <select value={value} onChange={(e) => setValue(field.key, e.target.value)}>
            <option value="">Select…</option>
            {field.options?.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        );
      case 'boolean':
        return (
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => setValue(field.key, e.target.checked)}
          />
        );
      case 'number':
        return (
          <input
            type="number"
            min={field.min}
            max={field.max}
            value={value}
            onChange={(e) => setValue(field.key, e.target.value === '' ? '' : Number(e.target.value))}
          />
        );
      case 'date':
        // Dates can't be picked in the past (only search filters may look back) - except fields that record something that already happened.
        // A saved record whose date has since passed (a contract that ended, a renewal now overdue) keeps it: the earliest choice is that date,
        // so the browser never blocks "Save" on a field nobody touched.
        { const was = String(record?.[field.key] || ''); const floor = /^\d{4}-\d{2}-\d{2}/.test(was) && was.slice(0, 10) < today() ? was.slice(0, 10) : today();
          return <input type="date" value={value} min={field.allowPast ? undefined : floor} onChange={(e) => setValue(field.key, e.target.value)} />; }
      case 'time':
        return <input type="time" value={value} onChange={(e) => setValue(field.key, e.target.value)} />;
      case 'textarea':
        return <textarea value={value} maxLength={maxLengthFor(field)} onChange={(e) => setValue(field.key, e.target.value)} rows={3} />;
      default:
        return (
          <>
            <input type="text" value={value} maxLength={maxLengthFor(field)} onChange={(e) => setValue(field.key, e.target.value)} style={field.strong ? { fontWeight: 700 } : undefined} />
            {field.suggestSimilar && <SimilarNotice text={value} rows={existing} fieldKey={field.key} exclude={draft.id} noun={schema.label} />}
            {field.suggestSimilar && existingErr && <div className="notice error" data-testid="similar-check-error" style={{ marginTop: 6 }}>Could not check for an existing {schema.label.toLowerCase()} with this name ({existingErr}). Look in the list before adding it.</div>}
          </>
        );
    }
  }

  return (
    <form
      className="form-grid"
      onSubmit={async (e) => {
        e.preventDefault();
        if (saving) return;
        // Mandatory-field validation: every required, editable field must have a value.
        const missing = {};
        for (const f of fields) {
          if (!isRequired(f) || !canEdit(f, roleId)) continue;
          const v = draft[f.key];
          if (v === undefined || v === null || String(v).trim() === '') missing[f.key] = `${f.label} is required`;
        }
        for (const f of fields) {
          if (!canEdit(f, roleId) || missing[f.key]) continue;
          if (f.type === 'phone' && String(draft[f.key] ?? '').trim()) { const v = validatePhone(draft[f.key]); if (!v.ok) missing[f.key] = v.error; }
          const val = draft[f.key];
          if (f.type === 'number' && val !== '' && val != null && ((f.min != null && Number(val) < f.min) || (f.max != null && Number(val) > f.max))) missing[f.key] = `${f.label} is ${f.min ?? '…'} to ${f.max ?? '…'}`;
          if (f.minLength && String(val ?? '').trim() && String(val).trim().length < f.minLength) missing[f.key] = `${f.label} needs at least ${f.minLength} characters`;
          if (f.format === 'email' && String(val ?? '').trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val).trim())) missing[f.key] = `${f.label} is not an e-mail address`;
          if (f.type === 'people') { const pe = peopleErrors(Array.isArray(draft[f.key]) ? draft[f.key] : []); if (Object.keys(pe).length) missing[f.key] = pe; }
        }
        const imp = impact ? impact(draft) : null;
        if (imp?.needsAck && !ack) missing.__ack = 'Please confirm you understand the access change';
        setErrors(missing);
        if (Object.keys(missing).length > 0) return;
        if (existingErr && !draft.id && fields.some((f) => f.suggestSimilar && String(draft[f.key] ?? '').trim()) && !window.confirm(`The check for an existing ${schema.label.toLowerCase()} with the same name could not run (${existingErr}). Save anyway?`)) return;
        // store newly added files now (the form is being saved), then save the record with their metadata
        setSaving(true);
        const out = { ...draft };
        try {
          for (const f of fields.filter((x) => x.type === 'files')) {
            const list = pending[f.key] || [];
            if (!list.length) continue;
            const metas = await persistPending(list, { ownerType: f.ownerType || schema.id, ownerId: draft.id });
            if (!metas) { setSaving(false); return; }
            out[f.key] = [...(out[f.key] || []), ...metas];
          }
          await onSave(out);
        } finally {
          setSaving(false);
        }
      }}
    >
      {extra && extra.props?.top && <div style={{ gridColumn: '1 / -1' }}>{extra}</div>}
      {fields.map((field) => (
        <div className={`field${errors[field.key] ? ' invalid' : ''}`} key={field.key} style={['richtext', 'textarea', 'files', 'roles', 'tags', 'people', 'specs'].includes(field.type) || field.wide ? { gridColumn: '1 / -1' } : undefined}>
          <label>
            {field.label}
            {isRequired(field) && !readOnly && canEdit(field, roleId) && ' *'}
            {field.isCustom && <span className="tag blue" style={{ marginLeft: 6 }}>Custom</span>}
          </label>
          {field.type === 'boolean' ? <div>{renderInput(field)}</div> : renderInput(field)}
          {lockedField(field) && !readOnly && <small className="muted" data-testid={`locked-${field.key}`}>Fixed once saved. Ask an admin or an EC member to change it.</small>}
          {typeof errors[field.key] === 'string' && !(field.type === 'phone' && String(draft[field.key] || '').trim()) && <div className="field-error">{errors[field.key]}</div>}
        </div>
      ))}
      {impact && (() => {
        const imp = impact(draft);
        if (!imp || !imp.lines?.length) return null;
        return (
          <div style={{ gridColumn: '1 / -1' }} data-testid="access-impact" className={`notice${imp.needsAck ? ' error' : ''}`}>
            {imp.lines.map((l, i) => <div key={i}>{l}</div>)}
            {imp.needsAck && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontWeight: 600 }}>
                <input type="checkbox" data-testid="ack-access" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I understand — go ahead
              </label>
            )}
            {errors.__ack && <div className="field-error">{errors.__ack}</div>}
          </div>
        );
      })()}
      {extra && !extra.props?.top && <div style={{ gridColumn: '1 / -1' }}>{extra}</div>}
      <div style={{ gridColumn: '1 / -1' }}><RecordMeta record={record} /></div>
      <div className="form-actions">
        {!viewOnly && <button type="submit" className="btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>}
        <button type="button" className="btn secondary" onClick={onCancel}>{viewOnly ? 'Close' : 'Cancel'}</button>
        {deleteSlot && <span style={{ marginLeft: 'auto' }}>{deleteSlot}</span>}
        {!deleteSlot && record.id && !noDelete && <span style={{ marginLeft: 'auto' }}><AdminDelete collection={schema.id} id={record.id} label={(schema.label || 'record').toLowerCase()} onDone={onCancel} /></span>}
      </div>
      {belowActions && <div style={{ gridColumn: '1 / -1' }}>{belowActions}</div>}
    </form>
  );
}
