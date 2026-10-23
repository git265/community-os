import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import Modal from '../../components/Modal.jsx';
import { notify } from '../../lib/notify.js';
import { servicesOrBuiltin, svcOf, effectOf, effectText, EFFECTS, SERVICE_MODES, collectionOn, accessOn, holidayOn, timeText, parseHolidays } from '../../lib/siteCalendar.js';
import { iso, parse, addDays, WEEKDAYS } from '../../lib/shifts.js';
import Tabs from '../../components/Tabs.jsx';
import PageActions from '../../components/PageActions.jsx';

const dlong = (s) => parse(s).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
const dshort = (s) => parse(s).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
const when = (r) => (r.repeat === 'Weekly' ? (r.weekdays || []).map((i) => WEEKDAYS[i]).join(', ') : r.repeat === 'One date' ? parse(r.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : `${r.date} → ${r.endDate || r.date}`);
const accessText = (svc, w) => (w.state === 'unset' ? 'No rule' : w.state === 'blocked' ? `${svc.name === 'Workers allowed' ? 'NOT allowed' : 'NOT available'}${w.rules[0]?.title ? ` — ${w.rules[0].title}` : ''}` : `${svc.name === 'Workers allowed' ? 'Allowed' : 'Available'} ${w.rules.map((r) => timeText(r)).join(', ')}`);
const heading = (svc) => `${svc.icon || '📌'} ${svc.name}`;

function RuleForm({ rule, svc, onClose }) {
  const { save, remove } = useCollection(C.SITE_CALENDAR, 'Calendar');
  const access = svc.mode === 'Access';
  const [f, setF] = useState({ kind: svc.name, repeat: 'Weekly', weekdays: svc.weekdays?.length ? svc.weekdays : [0, 1, 2, 3, 4, 5], date: '', endDate: '', startTime: svc.startTime || '', endTime: svc.endTime || '', allowed: 'Allowed', area: svc.area || '', notes: svc.notes || '', title: '', ...rule });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const togg = (i) => set('weekdays', f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i].sort());
  async function submit(e) {
    e.preventDefault();
    if (!f.title.trim()) return setErr('Give it a title');
    if (f.repeat === 'Weekly' && !f.weekdays.length) return setErr('Pick at least one weekday');
    if (f.repeat !== 'Weekly' && !f.date) return setErr('Pick the date');
    if (f.repeat === 'Date range' && f.endDate && f.endDate < f.date) return setErr('“Until” must be on or after the start date');
    if (f.startTime && f.endTime && f.endTime <= f.startTime) return setErr('The end time must be after the start time');
    const out = await save({ ...f, kind: svc.name, title: f.title.trim(), weekdays: f.repeat === 'One date' ? [] : f.weekdays, allowed: access ? f.allowed : '' });
    if (out) onClose();
  }
  return (
    <Modal title={`${rule?.id ? 'Edit' : 'Add'} ${svc.name === 'Workers allowed' ? 'workers-allowed rule' : svc.name === 'Trash pickup' ? 'trash pickup' : `${svc.name} ${access ? 'rule' : 'schedule'}`}`} subtitle={access ? 'A one-off date or range (e.g. a festival day) overrides the usual weekly pattern.' : 'Weekly entries repeat automatically.'} onClose={onClose}>
      <form className="form-grid" onSubmit={submit} data-testid="rule-form">
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Title *</label><input aria-label="Title" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder={svc.name === 'Workers allowed' ? 'e.g. Contractors & repair workers' : svc.name === 'Trash pickup' ? 'e.g. Wet waste (kitchen)' : `e.g. ${svc.name} — morning round`} /></div>
        <div className="field"><label>Repeats</label><select aria-label="Repeats" value={f.repeat} onChange={(e) => set('repeat', e.target.value)}><option>Weekly</option><option>One date</option><option>Date range</option></select></div>
        {access && <div className="field"><label>{svc.name === 'Workers allowed' ? 'Workers are' : 'This is'}</label><select aria-label="Workers are" value={f.allowed} onChange={(e) => set('allowed', e.target.value)}><option>Allowed</option><option>Not allowed</option></select></div>}
        {f.repeat !== 'Weekly' && <div className="field"><label>{f.repeat === 'One date' ? 'Date' : 'From'} *</label><input type="date" aria-label="Date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>}
        {f.repeat === 'Date range' && <div className="field"><label>Until</label><input type="date" aria-label="Until" value={f.endDate} onChange={(e) => set('endDate', e.target.value)} /></div>}
        {f.repeat !== 'One date' && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Weekdays</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{WEEKDAYS.map((d, i) => <button key={d} type="button" className={`chip-btn${f.weekdays.includes(i) ? ' on' : ''}`} data-testid={`day-${d}`} onClick={() => togg(i)}>{d}</button>)}</div></div>}
        <div className="field"><label>From time</label><input type="time" aria-label="From time" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} /></div>
        <div className="field"><label>To time</label><input type="time" aria-label="To time" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} /></div>
        <div className="field"><label>Area / blocks <small className="muted">(optional)</small></label><input aria-label="Area" value={f.area} onChange={(e) => set('area', e.target.value)} placeholder="e.g. Villas 1–100" /></div>
        <div className="field"><label>Notes</label><input aria-label="Notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="e.g. Keep bins outside the gate" /></div>
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions"><button type="submit" className="btn" data-testid="rule-save">Save</button>{rule?.id && <button type="button" className="btn danger" onClick={async () => { if (window.confirm('Delete this rule?')) { await remove(rule.id); onClose(); } }}>Delete</button>}<button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

/** Add / edit a service. The name is the key rules point at, so it cannot change once the service exists. */
function ServiceForm({ svc, rules, services, onClose }) {
  const { save, remove } = useCollection(C.SITE_SERVICES, 'Calendar services');
  const [f, setF] = useState({ name: '', icon: '📌', mode: 'Collection', startTime: '', endTime: '', weekdays: [0, 1, 2, 3, 4, 5], area: '', notes: '', active: true, ...svc });
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const togg = (i) => set('weekdays', f.weekdays.includes(i) ? f.weekdays.filter((x) => x !== i) : [...f.weekdays, i].sort());
  const used = svc?.id ? rules.filter((r) => r.kind === svc.name).length : 0;
  async function submit(e) {
    e.preventDefault();
    const name = f.name.trim();
    if (!name) return setErr('Give the service a name');
    if (!svc?.id && services.some((x) => x.name.toLowerCase() === name.toLowerCase())) return setErr('A service with that name already exists');
    if (f.startTime && f.endTime && f.endTime <= f.startTime) return setErr('The end time must be after the start time');
    const out = await save({ ...f, name, order: svc?.order ?? services.length + 1 });
    if (out) onClose();
  }
  return (
    <Modal title={svc?.id ? `Edit service · ${svc.name}` : 'Add a service'} subtitle="Services appear as tabs on the calendar, on the “today” banner and in what you publish. The times and days here are the defaults new entries start with." onClose={onClose}>
      <form className="form-grid" onSubmit={submit} data-testid="service-form">
        <div className="field"><label>Service name *</label><input aria-label="Service name" value={f.name} disabled={!!svc?.id} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Water tanker, Pest control, Gardening" />{svc?.id && <small className="muted">The name is fixed once created (calendar entries are linked to it).</small>}</div>
        <div className="field"><label>Icon</label><input aria-label="Service icon" value={f.icon} onChange={(e) => set('icon', e.target.value)} maxLength={4} style={{ width: 90 }} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>How does it work?</label>
          <select aria-label="Service behaviour" value={f.mode} disabled={used > 0} onChange={(e) => set('mode', e.target.value)}><option value="Collection">Happens on set days (collection / visit)</option><option value="Access">A window when something is allowed (access)</option></select>
          <small className="muted">{SERVICE_MODES[f.mode]}{used > 0 ? ' It already has entries, so this cannot change.' : ''}</small></div>
        <div className="field"><label>Usual from</label><input type="time" aria-label="Service from" value={f.startTime} onChange={(e) => set('startTime', e.target.value)} /></div>
        <div className="field"><label>Usual until</label><input type="time" aria-label="Service until" value={f.endTime} onChange={(e) => set('endTime', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Usual days</label><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{WEEKDAYS.map((d, i) => <button key={d} type="button" className={`chip-btn${f.weekdays.includes(i) ? ' on' : ''}`} data-testid={`svc-day-${d}`} onClick={() => togg(i)}>{d}</button>)}</div></div>
        <div className="field"><label>Area / blocks</label><input aria-label="Service area" value={f.area} onChange={(e) => set('area', e.target.value)} /></div>
        <div className="field"><label>Notes for residents</label><input aria-label="Service notes" value={f.notes} onChange={(e) => set('notes', e.target.value)} /></div>
        <label className="check" style={{ gridColumn: '1 / -1' }}><input type="checkbox" data-testid="svc-active" checked={!!f.active} onChange={(e) => set('active', e.target.checked)} /> Show on the calendar</label>
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions"><button type="submit" className="btn" data-testid="service-save">Save</button>
          {svc?.id && <button type="button" className="btn danger" disabled={used > 0} title={used ? 'Remove its entries first (or just switch it off)' : ''} onClick={async () => { if (window.confirm(`Delete the service “${svc.name}”?`)) { await remove(svc.id); onClose(); } }}>Delete</button>}
          <button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

const optLabel = (s, x) => (x === 'Rescheduled' ? 'Moved to another day' : x === 'Limited hours' ? 'Limited hours only' : effectText(s, { effect: x }));
const blankEffects = (services) => Object.fromEntries(services.map((s) => [s.name, { effect: s.mode === 'Collection' ? 'No service' : 'Not available' }]));
function HolidayForm({ row, services, onClose }) {
  const { save, remove } = useCollection(C.SITE_HOLIDAYS, 'Holidays');
  const [f, setF] = useState(() => ({ date: '', name: '', note: '', ...row, effects: { ...(row?.effects || {}), ...Object.fromEntries(services.map((s) => [s.name, row?.id ? { ...effectOf(row, s) } : blankEffects([s])[s.name]])) } }));
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setEff = (name, patch) => setF((x) => ({ ...x, effects: { ...x.effects, [name]: { ...x.effects[name], ...patch } } }));
  async function submit(e) {
    e.preventDefault();
    if (!f.date || !f.name.trim()) return setErr('Date and holiday name are required');
    for (const s of services) {
      const e1 = f.effects[s.name] || { effect: 'As usual' };
      if (e1.effect === 'Rescheduled' && !e1.newDate) return setErr(`${s.name}: pick the day it moves to`);
      if (e1.effect === 'Limited hours' && (!e1.from || !e1.to || e1.to <= e1.from)) return setErr(`${s.name}: give the allowed hours (from before until)`);
    }
    // keep the two original fields in step for trash and workers (older screens / exports read them)
    const tr = f.effects['Trash pickup']; const wk = f.effects['Workers allowed'];
    const legacy = {
      trash: !tr ? (f.trash || 'Pickup as usual') : tr.effect === 'No service' ? 'No pickup' : tr.effect === 'Rescheduled' ? 'Rescheduled' : 'Pickup as usual', trashNewDate: tr?.effect === 'Rescheduled' ? tr.newDate : '',
      workers: !wk ? (f.workers || 'Allowed as usual') : wk.effect === 'Not available' ? 'Not allowed' : wk.effect === 'Limited hours' ? 'Limited hours' : 'Allowed as usual', workersFrom: wk?.effect === 'Limited hours' ? wk.from : '', workersTo: wk?.effect === 'Limited hours' ? wk.to : '',
    };
    const out = await save({ ...f, ...legacy, name: f.name.trim() });
    if (out) onClose();
  }
  return (
    <Modal title={row?.id ? 'Edit holiday' : 'Add holiday'} subtitle="A holiday can treat each service differently — e.g. no trash pickup but the water tanker still comes." onClose={onClose}>
      <form className="form-grid" onSubmit={submit} data-testid="holiday-form">
        <div className="field"><label>Date *</label><input type="date" aria-label="Date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label>Holiday *</label><input aria-label="Holiday" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Diwali" /></div>
        {services.map((s) => {
          const e1 = f.effects[s.name] || { effect: 'As usual' };
          return (
            <div key={s.id || s.name} className="field" style={{ gridColumn: '1 / -1' }} data-testid={`eff-${s.name}`}>
              <label>{heading(s)}</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select aria-label={s.name} value={e1.effect} onChange={(e) => setEff(s.name, { effect: e.target.value })} style={{ flex: '1 1 160px' }}>
                  {EFFECTS[s.mode].map((x) => <option key={x} value={x}>{optLabel(s, x)}</option>)}
                </select>
                {e1.effect === 'Rescheduled' && <input type="date" aria-label={`${s.name} moves to`} value={e1.newDate || ''} onChange={(e) => setEff(s.name, { newDate: e.target.value })} style={{ flex: '1 1 150px' }} />}
                {e1.effect === 'Limited hours' && <><input type="time" aria-label={`${s.name} from`} value={e1.from || ''} onChange={(e) => setEff(s.name, { from: e.target.value })} style={{ flex: '1 1 110px' }} /><input type="time" aria-label={`${s.name} until`} value={e1.to || ''} onChange={(e) => setEff(s.name, { to: e.target.value })} style={{ flex: '1 1 110px' }} /></>}
              </div>
            </div>
          );
        })}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><input aria-label="Note" value={f.note || ''} onChange={(e) => set('note', e.target.value)} /></div>
        {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
        <div className="form-actions"><button type="submit" className="btn" data-testid="holiday-save">Save</button>{row?.id && <button type="button" className="btn danger" onClick={async () => { if (window.confirm('Delete this holiday?')) { await remove(row.id); onClose(); } }}>Delete</button>}<button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </form>
    </Modal>
  );
}

function ImportHolidays({ existing, services, onClose }) {
  const { save } = useCollection(C.SITE_HOLIDAYS, 'Holidays');
  const [text, setText] = useState('');
  const [eff, setEffAll] = useState(() => Object.fromEntries(services.map((s) => [s.name, s.mode === 'Collection' ? 'No service' : 'Not available'])));
  const [msg, setMsg] = useState('');
  const parsed = useMemo(() => parseHolidays(text), [text]);
  async function go() {
    if (!parsed.rows.length) { setMsg('Nothing to import yet'); return; }
    const have = new Set(existing.map((h) => h.date));
    const effects = Object.fromEntries(services.map((s) => [s.name, { effect: eff[s.name] }]));
    const legacy = { trash: eff['Trash pickup'] === 'No service' ? 'No pickup' : 'Pickup as usual', trashNewDate: '', workers: eff['Workers allowed'] === 'Not available' ? 'Not allowed' : 'Allowed as usual', workersFrom: '', workersTo: '' };
    let n = 0;
    for (const r of parsed.rows) { if (have.has(r.date)) continue; if (await save({ ...r, ...legacy, effects, note: '' })) { n += 1; have.add(r.date); } }
    setMsg(`Imported ${n} holiday${n === 1 ? '' : 's'}${parsed.rows.length - n ? ` (${parsed.rows.length - n} skipped: date already listed)` : ''}.`);
    if (n) setTimeout(onClose, 700);
  }
  return (
    <Modal title="Add a list of holidays" subtitle="Paste one per line: date, name — e.g. 2026-12-25, Christmas or 25/12/2026 - Christmas." onClose={onClose}>
      <div data-testid="import-holidays-form">
        <textarea rows={8} aria-label="Holiday list" value={text} onChange={(e) => setText(e.target.value)} placeholder={'2026-11-08, Diwali\n2026-12-25, Christmas\n2027-01-26, Republic Day'} style={{ width: '100%' }} />
        <div className="form-grid" style={{ marginTop: 8 }}>
          {services.map((s) => (
            <div className="field" key={s.name}><label>{heading(s)} on all of these</label>
              <select aria-label={`${s.name} for all`} value={eff[s.name]} onChange={(e) => setEffAll((x) => ({ ...x, [s.name]: e.target.value }))}>
                {EFFECTS[s.mode].filter((x) => x !== 'Rescheduled' && x !== 'Limited hours').map((x) => <option key={x} value={x}>{effectText(s, { effect: x })}</option>)}
              </select></div>
          ))}
        </div>
        <div className="muted" data-testid="import-preview">{parsed.rows.length} holiday{parsed.rows.length === 1 ? '' : 's'} recognised{parsed.bad.length ? ` · ${parsed.bad.length} line${parsed.bad.length === 1 ? '' : 's'} not understood: ${parsed.bad.slice(0, 3).join(' | ')}` : ''}. You can fine-tune each one (rescheduled, limited hours) afterwards.</div>
        {msg && <div className="notice" data-testid="import-msg">{msg}</div>}
        <div className="form-actions"><button type="button" className="btn" data-testid="import-go" onClick={go}>Import</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}

/** Publish the calendar to groups. Goes through the central notifier, so each person gets it in the app and on the extra channels (WhatsApp / SMS / E-mail) they opted in to and the community allows for "Community calendar". */
function PublishForm({ rules, holidays, services, onClose }) {
  const { roles, currentUser, community } = useApp();
  const [groups, setGroups] = useState({ Resident: true, Staff: false, EC: false });
  const [inc, setInc] = useState(() => ({ ...Object.fromEntries(services.map((s) => [s.name, true])), holidays: true }));
  const [days, setDays] = useState(60);
  const [done, setDone] = useState('');
  const today = iso(new Date());
  const build = (i, d) => {
    const L = [`📅 ${community?.name || 'Community'} — calendar update`];
    for (const s of services) {
      if (!i[s.name]) continue;
      const r = rules.filter((x) => x.kind === s.name);
      L.push('', `${heading(s)}${s.mode === 'Access' ? '' : ''}`);
      if (!r.length) { L.push(s.mode === 'Access' ? '• No rules set' : '• No schedule set'); continue; }
      for (const x of r) L.push(s.mode === 'Access'
        ? `• ${x.title}: ${when(x)} ${timeText(x)} — ${x.allowed === 'Not allowed' ? (s.name === 'Workers allowed' ? 'NOT allowed' : 'NOT available') : (s.name === 'Workers allowed' ? 'allowed' : 'available')}${x.notes ? ` (${x.notes})` : ''}`
        : `• ${x.title}: ${when(x)} ${timeText(x)}${x.area ? ` (${x.area})` : ''}${x.notes ? ` — ${x.notes}` : ''}`);
    }
    if (i.holidays) {
      const hs = holidays.filter((h) => h.date >= today && h.date <= addDays(today, d)).sort((a, b) => a.date.localeCompare(b.date));
      L.push('', `🎉 Holidays (next ${d} days)`, ...(hs.length ? hs.map((h) => { const ch = services.filter((s) => effectOf(h, s).effect !== 'As usual').map((s) => `${s.name}: ${effectText(s, effectOf(h, s), dshort)}`); return `• ${dshort(h.date)} ${h.name} — ${ch.length ? ch.join('; ') : 'no change to any service'}`; }) : ['• None in this period']));
    }
    return L.join('\n');
  };
  const [text, setText] = useState(() => build(inc, 60));
  const [edited, setEdited] = useState(false);
  useEffect(() => { if (!edited) setText(build(inc, days)); }, [inc, days]); // eslint-disable-line react-hooks/exhaustive-deps
  const roleIds = (roles || []).filter((r) => groups[r.category] && r.id !== 'super_admin' && !String(r.id).startsWith('grp_')).map((r) => r.id);
  async function send() {
    if (!roleIds.length) { setDone('Choose at least one group'); return; }
    await notify({ event: 'calendar', title: 'Community calendar update', body: text, link: '#/calendar', toRoleIds: roleIds, by: currentUser?.name || '' });
    setDone(`Published to ${Object.keys(groups).filter((g) => groups[g]).map((g) => ({ Resident: 'Residents', Staff: 'Staff', EC: 'Committee' }[g])).join(', ')}. Everyone gets it in the app; WhatsApp / SMS / E-mail go to those who opted in (queued in this demo, not delivered).`);
  }
  return (
    <Modal title="Publish the calendar" subtitle="Send the schedules and holidays to groups, through the channels set up under Notifications." onClose={onClose}>
      <div data-testid="publish-form">
        <b>Who gets it</b>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '6px 0 10px' }}>{[['Resident', 'Residents (owners & tenants)'], ['Staff', 'Facility & field staff'], ['EC', 'Committee (EC)']].map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" data-testid={`pub-${k}`} checked={!!groups[k]} onChange={(e) => setGroups((g) => ({ ...g, [k]: e.target.checked }))} /> {l}</label>)}</div>
        <b>What to include</b>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '6px 0 10px', alignItems: 'center' }}>
          {[...services.map((s) => [s.name, `${s.icon || ''} ${s.name}`]), ['holidays', 'Holidays']].map(([k, l]) => <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={!!inc[k]} onChange={(e) => { setEdited(false); setInc((x) => ({ ...x, [k]: e.target.checked })); }} /> {l}</label>)}
          <select aria-label="Holiday period" value={days} onChange={(e) => { setEdited(false); setDays(Number(e.target.value)); }} style={{ width: 'auto' }}><option value={30}>next 30 days</option><option value={60}>next 60 days</option><option value={180}>next 6 months</option><option value={365}>next 12 months</option></select>
        </div>
        <label style={{ fontWeight: 600 }}>Message (you can edit it)</label>
        <textarea rows={12} aria-label="Message" data-testid="pub-text" value={text} onChange={(e) => { setEdited(true); setText(e.target.value); }} style={{ width: '100%', fontFamily: 'inherit' }} />
        {done && <div className="notice" data-testid="pub-done">{done}</div>}
        <div className="form-actions"><button type="button" className="btn" data-testid="pub-send" onClick={send}>📣 Publish</button><button type="button" className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/** Calendar (list view): the community's services (trash pickup, workers, anything the admin adds) and the holidays that change them. Everyone sees it; the facility / security team edits and publishes it. */
export default function CalendarModule() {
  const { records: rules } = useCollection(C.SITE_CALENDAR, 'Calendar');
  const { records: holidays } = useCollection(C.SITE_HOLIDAYS, 'Holidays');
  const { records: svcRows } = useCollection(C.SITE_SERVICES, 'Calendar services');
  const canEdit = canWriteCollection(C.SITE_CALENDAR, getPrincipal());
  const allServices = servicesOrBuiltin(svcRows);
  const services = allServices.filter((s) => s.active !== false);
  const today = iso(new Date());
  const TABS = [...services.map((s) => s.name), 'Holidays', ...(canEdit ? ['Services'] : [])];
  const [tab, setTab] = useState(() => { try { const t = sessionStorage.getItem('communityos:openTab'); if (t) return t; } catch { /* ignore */ } return 'Trash pickup'; });
  useEffect(() => { try { sessionStorage.removeItem('communityos:openTab'); } catch { /* ignore */ } }, []);
  const [modal, setModal] = useState(null);
  const [horizon, setHorizon] = useState(14);
  const curTab = TABS.includes(tab) ? tab : TABS[0];
  const svc = services.find((s) => s.name === curTab);

  const hToday = holidayOn(holidays, today);
  const agenda = useMemo(() => {
    if (!svc) return [];
    const out = [];
    for (let i = 0; i < horizon; i++) {
      const d = addDays(today, i); const holiday = holidayOn(holidays, d);
      if (svc.mode === 'Access') { const a = accessOn(svc, rules, d, holidays); if (a.state !== 'unset' || holiday) out.push({ date: d, access: a, holiday }); }
      else { const items = collectionOn(svc, rules, d, holidays); if (items.length || holiday) out.push({ date: d, items, holiday }); }
    }
    return out;
  }, [svc, rules, holidays, today, horizon]);
  const kindRules = rules.filter((r) => r.kind === curTab);
  const sortedH = [...holidays].sort((a, b) => a.date.localeCompare(b.date));
  const futureH = sortedH.filter((h) => h.date >= today);
  const tid = (s) => (s.name === 'Trash pickup' ? 'today-trash' : s.name === 'Workers allowed' ? 'today-workers' : `today-${s.name}`);

  return (
    <div>
      <div className="page-head"><div><h1>Calendar</h1><p>Trash pickup, worker access and any other service the community runs — with the holidays that change them.</p></div>
        {canEdit && <PageActions><button className="btn secondary" data-testid="publish-calendar" onClick={() => setModal({ kind: 'publish' })}>📣 Publish…</button>{curTab === 'Holidays'
          ? <><button className="btn secondary" data-testid="import-holidays" onClick={() => setModal({ kind: 'import' })}>Add a list</button><button className="btn" data-testid="add-holiday" onClick={() => setModal({ kind: 'holiday', row: null })}>+ Add holiday</button></>
          : curTab === 'Services'
            ? <button className="btn" data-testid="add-service" onClick={() => setModal({ kind: 'service', svc: null })}>+ Add service</button>
            : <button className="btn" data-testid="add-rule" onClick={() => setModal({ kind: 'rule', rule: null })}>+ Add {svc?.mode === 'Collection' ? (svc.name === 'Trash pickup' ? 'pickup' : 'schedule') : 'rule'}</button>}</PageActions>}
      </div>

      <div className="grid metrics" style={{ marginBottom: 12 }} data-testid="today-banner">
        {services.map((s) => {
          if (s.mode === 'Access') {
            const w = accessOn(s, rules, today, holidays);
            const st = { allowed: ['green', s.name === 'Workers allowed' ? 'Workers allowed today' : `${s.name} available today`], blocked: ['red', s.name === 'Workers allowed' ? 'No workers today' : `${s.name} not available today`], unset: ['', s.name === 'Workers allowed' ? 'No worker rule set' : 'No rule set'] }[w.state];
            return <div className="card" key={s.name}><div className="label">{heading(s)}{s.name === 'Workers allowed' ? ' today' : ' today'}</div><div><span className={`tag ${st[0]}`} data-testid={tid(s)}>{st[1]}</span> <small className="muted">{w.rules.map((r) => `${r.title} ${timeText(r)}`).join(' · ')}</small></div></div>;
          }
          const items = collectionOn(s, rules, today, holidays);
          return <div className="card" key={s.name}><div className="label">{heading(s)} today</div><div style={{ fontWeight: 700 }} data-testid={tid(s)}>{items.length ? items.map((r) => `${r.title} ${timeText(r)}`).join(' · ') : hToday && ['No service', 'Rescheduled'].includes(effectOf(hToday, s).effect) ? `${s.name === 'Trash pickup' ? 'No pickup' : 'None'} — ${hToday.name}` : s.name === 'Trash pickup' ? 'No pickup today' : 'Nothing today'}</div></div>;
        })}
        {hToday && <div className="card"><div className="label">🎉 Holiday today</div><div style={{ fontWeight: 700 }}>{hToday.name}</div></div>}
      </div>

      <Tabs>{TABS.map((k) => { const s = services.find((x) => x.name === k); return <button key={k} type="button" data-testid={`cal-${k}`} className={curTab === k ? 'active' : ''} onClick={() => setTab(k)}>{s ? `${s.icon || '📌'} ` : k === 'Holidays' ? '🎉 ' : '⚙ '}{k}{k === 'Holidays' ? ` (${futureH.length})` : ''}</button>; })}</Tabs>

      {svc && (
        <>
          <div className="card" style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><h3 style={{ margin: 0, flex: 1 }}>Coming up</h3>
              <select aria-label="Look ahead" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} style={{ width: 'auto' }}><option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option><option value={60}>60 days</option></select></div>
            {agenda.length === 0 ? <div className="empty">Nothing in the next {horizon} days.</div> : (
              <table className="table" data-testid="agenda"><thead><tr><th>Date</th><th>{svc.mode === 'Collection' ? (svc.name === 'Trash pickup' ? 'Pickup' : 'Schedule') : (svc.name === 'Workers allowed' ? 'Workers' : 'Access')}</th><th>Holiday</th></tr></thead>
                <tbody>{agenda.map((d) => (
                  <tr key={d.date} data-testid="agenda-row"><td data-label="Date"><b>{dlong(d.date)}</b>{d.date === today ? <span className="tag blue" style={{ marginLeft: 6 }}>today</span> : null}</td>
                    <td data-label="Detail">{svc.mode === 'Collection' ? (d.items.length ? d.items.map((r) => <div key={r.id}>{r.title} · {timeText(r)}{r.notes?.startsWith('Moved') ? <small className="muted"> ({r.notes.split(' · ')[0]})</small> : null}</div>) : <span className="muted">{svc.name === 'Trash pickup' ? 'No pickup' : 'None'}</span>) : <span className={`tag ${d.access.state === 'blocked' ? 'red' : d.access.state === 'allowed' ? 'green' : ''}`}>{accessText(svc, d.access)}</span>}</td>
                    <td data-label="Holiday">{d.holiday ? d.holiday.name : '—'}</td></tr>
                ))}</tbody></table>
            )}
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{svc.mode === 'Collection' ? (svc.name === 'Trash pickup' ? 'Pickup schedule' : `${svc.name} schedule`) : (svc.name === 'Workers allowed' ? 'Worker access rules' : `${svc.name} rules`)}</h3>
            {kindRules.length === 0 ? <div className="empty">Nothing set yet.{canEdit ? ' Use “+ Add”.' : ''}</div> : (
              <table className="table" data-testid="rule-list"><thead><tr><th>Title</th><th>When</th><th>Time</th>{svc.mode === 'Access' && <th>{svc.name === 'Workers allowed' ? 'Workers' : 'Access'}</th>}<th>Area / notes</th>{canEdit && <th />}</tr></thead>
                <tbody>{kindRules.map((r) => <tr key={r.id} data-testid="rule-row"><td data-label="Title"><b>{r.title}</b></td><td data-label="When">{when(r)}</td><td data-label="Time">{timeText(r)}</td>{svc.mode === 'Access' && <td data-label="Access"><span className={`tag ${r.allowed === 'Not allowed' ? 'red' : 'green'}`}>{r.allowed || 'Allowed'}</span></td>}<td data-label="Area">{[r.area, r.notes].filter(Boolean).join(' · ') || '—'}</td>{canEdit && <td><button type="button" className="btn secondary sm" onClick={() => setModal({ kind: 'rule', rule: r })}>Edit</button></td>}</tr>)}</tbody></table>
            )}
          </div>
        </>
      )}

      {curTab === 'Holidays' && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Holiday list</h3>
          {sortedH.length === 0 ? <div className="empty">No holidays yet.{canEdit ? ' Use “Add a list” to paste several at once.' : ''}</div> : (
            <table className="table" data-testid="holiday-list"><thead><tr><th>Date</th><th>Holiday</th><th>What changes</th><th>Note</th>{canEdit && <th />}</tr></thead>
              <tbody>{sortedH.map((h) => <tr key={h.id} data-testid="holiday-row" style={h.date < today ? { opacity: 0.55 } : undefined}><td data-label="Date">{dshort(h.date)}</td><td data-label="Holiday"><b>{h.name}</b></td>
                <td data-label="What changes"><div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>{services.map((s) => { const e1 = effectOf(h, s); return <span key={s.name} className={`tag ${e1.effect === 'As usual' ? 'green' : e1.effect === 'Limited hours' || e1.effect === 'Rescheduled' ? 'orange' : 'red'}`}>{s.icon} {effectText(s, e1, dshort)}</span>; })}</div></td>
                <td data-label="Note">{h.note || '—'}</td>
                {canEdit && <td><button type="button" className="btn secondary sm" onClick={() => setModal({ kind: 'holiday', row: h })}>Edit</button></td>}</tr>)}</tbody></table>
          )}
        </div>
      )}

      {curTab === 'Services' && canEdit && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Services on the calendar</h3>
          <p className="muted" style={{ marginTop: 0 }}>Add anything the community runs on a timetable. Each service gets its own tab, a “today” card, its own effect on every holiday, and is included when you publish.</p>
          <table className="table" data-testid="service-list"><thead><tr><th>Service</th><th>Type</th><th>Usual time</th><th>Entries</th><th>Shown</th><th /></tr></thead>
            <tbody>{allServices.map((s) => <tr key={s.id || s.name} data-testid="service-row"><td data-label="Service"><b>{s.icon} {s.name}</b></td><td data-label="Type">{s.mode === 'Access' ? 'Access window' : 'Set days'}</td><td data-label="Usual time">{timeText(s)}</td><td data-label="Entries">{rules.filter((r) => r.kind === s.name).length}</td><td data-label="Shown"><span className={`tag ${s.active === false ? '' : 'green'}`}>{s.active === false ? 'Hidden' : 'Shown'}</span></td><td><button type="button" className="btn secondary sm" onClick={() => setModal({ kind: 'service', svc: s })}>Edit</button></td></tr>)}</tbody></table>
        </div>
      )}

      {modal?.kind === 'rule' && svc && <RuleForm rule={modal.rule} svc={svc} onClose={() => setModal(null)} />}
      {modal?.kind === 'service' && <ServiceForm svc={modal.svc} rules={rules} services={allServices} onClose={() => setModal(null)} />}
      {modal?.kind === 'holiday' && <HolidayForm row={modal.row} services={services} onClose={() => setModal(null)} />}
      {modal?.kind === 'import' && <ImportHolidays existing={holidays} services={services} onClose={() => setModal(null)} />}
      {modal?.kind === 'publish' && <PublishForm rules={rules} holidays={holidays} services={services} onClose={() => setModal(null)} />}
    </div>
  );
}
