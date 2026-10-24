import React from 'react';
import { validatePhone } from '../lib/phone.js';
import { RELATIONS } from '../lib/people.js';
import { uuid } from '../lib/uuid.js';
import { emailError } from '../lib/validate.js';

/** A phone input that checks the number as you type: needs a country code, and a real number for that country. */
export function PhoneInput({ value, onChange, label, invalid, testid }) {
  const v = value ? validatePhone(value) : null;
  return (
    <div>
      <input type="tel" inputMode="tel" data-testid={testid} aria-label={label} value={value || ''} placeholder="+91 98450 71234" onChange={(e) => onChange(e.target.value)} className={v && !v.ok ? 'bad' : ''} aria-invalid={invalid || (v && !v.ok) || undefined} />
      {v && !v.ok && <div className="field-error">{v.error}</div>}
      {v?.ok && <small className="muted">✓ {v.country} · {v.formatted}</small>}
    </div>
  );
}

/** Additional owners / tenants / contacts on a property. Phone is mandatory for each (it is how they get portal access). */
export function PeopleEditor({ list, onChange, errors = {} }) {
  const set = (i, patch) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div data-testid="people-editor">
      {list.map((x, i) => (
        <div key={x.id} className="people-row" data-testid="people-row">
          <div className="people-grid">
            <div><small className="muted">Relation</small>
              <select aria-label="Relation" value={x.relation} onChange={(e) => set(i, { relation: e.target.value })}>{RELATIONS.map((r) => <option key={r}>{r}</option>)}</select>
            </div>
            <div><small className="muted">Name *</small>
              <input type="text" aria-label="Person name" value={x.name} onChange={(e) => set(i, { name: e.target.value })} />
              {errors[x.id]?.name && <div className="field-error">{errors[x.id].name}</div>}
            </div>
            <div><small className="muted">Mobile with country code *</small>
              <PhoneInput value={x.phone} onChange={(v) => set(i, { phone: v })} label="Person phone" />
              {errors[x.id]?.phone && !validatePhone(x.phone).error && <div className="field-error">{errors[x.id].phone}</div>}
              {errors[x.id]?.phone && validatePhone(x.phone).error && !x.phone && <div className="field-error">{errors[x.id].phone}</div>}
            </div>
            <div><small className="muted">E-mail (optional)</small>
              <input type="email" inputMode="email" aria-label="Person e-mail" value={x.email || ''} onChange={(e) => set(i, { email: e.target.value })} aria-invalid={!!errors[x.id]?.email || undefined} />
              {errors[x.id]?.email && <div className="field-error">{errors[x.id].email}</div>}
            </div>
          </div>
          <button type="button" className="btn secondary sm" aria-label="Remove person" onClick={() => onChange(list.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      {!list.length && <small className="muted">None added. Add a co-owner, a second tenant or a family contact who should also receive communications and have portal access.</small>}
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn secondary" data-testid="add-person" onClick={() => onChange([...list, { id: uuid(), relation: 'Additional owner', name: '', phone: '', email: '' }])}>+ Add person</button>
      </div>
    </div>
  );
}

/** Checks the people rows; returns { [id]: {name?, phone?, email?} } (empty when all fine). */
export function peopleErrors(list) {
  const out = {}; const seen = new Set();
  for (const x of list) {
    const e = {};
    if (!String(x.name || '').trim()) e.name = 'Name is required';
    const v = validatePhone(x.phone);
    if (!v.ok) e.phone = v.error;
    else if (seen.has(v.e164)) e.phone = 'Same number is entered twice';
    else seen.add(v.e164);
    const em = emailError(x.email);
    if (em) e.email = em;
    if (Object.keys(e).length) out[x.id] = e;
  }
  return out;
}
