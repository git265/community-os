import { localDay, plannedTime } from '../../lib/locale.js';
import React, { useEffect, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import MyPasses from './MyPasses.jsx';
import { validatePhone } from '../../lib/phone.js';
import { SegTabs } from '../../components/ui.jsx';
import { ApprovalCard } from '../../components/GateApproval.jsx';
import { makeCode, readDigest, reportPerson, villaRule } from '../../lib/gate/engine.js';
import { DAYS, DELIVERY_COMPANIES, DELIVERY_MODES, PASS_TYPES, REPORT_REASONS, VILLA_CLASSES } from '../../lib/gate/constants.js';
import { Chips, Kpi, Photo, StateTag, PhotoCapture, stamp, clock } from './gateUi.jsx';

const ld = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const todayStr = () => ld(new Date());
const plus = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ld(d); };

function Rules({ unit }) {
  const { records: rules, save } = useCollection(COLLECTIONS.GATE_VILLA_RULES, 'Villa gate rules');
  const row = rules.find((r) => r.unit === unit);
  const [draft, setDraft] = useState(null); const [saved, setSaved] = useState('');
  useEffect(() => { let on = true; villaRule(unit).then((r) => { if (on) setDraft((d) => d || row || r); }); return () => { on = false; }; }, [unit]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!draft) return null;
  const set = (k, v) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(''); };
  // the time box is local wall-clock time; the server keeps a moment (ISO with its zone)
  async function commit() { await save({ ...draft, unit, expectingUntil: draft.expectingUntil ? new Date(draft.expectingUntil).toISOString() : '' }); setSaved('Saved.'); }
  const localInput = (v) => { if (!v) return ''; const d = new Date(v); if (Number.isNaN(d.getTime())) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  return (
    <div className="card" data-testid="my-rules">
      <div className="form-grid">
        <div className="field"><label>Deliveries</label><select data-testid="rule-mode" value={draft.deliveryMode} onChange={(e) => set('deliveryMode', e.target.value)}>{DELIVERY_MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
        <div className="field"><label>If I do not answer</label><select value={draft.fallback} onChange={(e) => set('fallback', e.target.value)}>{['Community default', 'Hold at gate', 'Deny'].map((m) => <option key={m}>{m}</option>)}</select></div>
        {draft.deliveryMode === 'Allow listed' && <div className="field" style={{ gridColumn: '1 / -1' }}><label>Companies let in without asking me</label><Chips multi options={DELIVERY_COMPANIES} value={draft.companies || []} onChange={(v) => set('companies', v)} label="Companies" /></div>}
        <div className="field"><label>Expecting a delivery until</label><input type="datetime-local" value={localInput(draft.expectingUntil)} onChange={(e) => set('expectingUntil', e.target.value)} /><small className="muted">Any approved company is let in until then.</small></div>
        <label className="gg-row"><input type="checkbox" data-testid="rule-away" checked={!!draft.awayMode} onChange={(e) => set('awayMode', e.target.checked)} style={{ width: 'auto' }} /> Away mode: nobody is let in without my approval, and deliveries are left at the gate</label>
        <label className="gg-row"><input type="checkbox" checked={!!draft.tellDelivery} onChange={(e) => set('tellDelivery', e.target.checked)} style={{ width: 'auto' }} /> Tell me about deliveries</label>
        <label className="gg-row"><input type="checkbox" checked={!!draft.tellGuestExit} onChange={(e) => set('tellGuestExit', e.target.checked)} style={{ width: 'auto' }} /> Tell me when a guest leaves</label>
        <label className="gg-row"><input type="checkbox" checked={!!draft.tellStaff} onChange={(e) => set('tellStaff', e.target.checked)} style={{ width: 'auto' }} /> Tell me when my maid, cook or driver comes and goes</label>
        <div className="form-actions"><button type="button" className="btn" data-testid="rule-save" onClick={commit}>Save</button>{saved && <span className="muted" role="status">{saved}</span>}</div>
      </div>
    </div>
  );
}
function ShareToDirectory({ person, unit }) {
  const { records: contacts, save, remove } = useCollection(COLLECTIONS.SERVICE_CONTACTS, 'Service Directory');
  const { currentUser } = useApp();
  const listed = contacts.find((c) => c.registryId === person.id);
  const [open, setOpen] = useState(false); const [phone, setPhone] = useState(''); const [rate, setRate] = useState(''); const [err, setErr] = useState('');
  if (person.status !== 'Active') return null;
  const cat = person.personClass === 'Driver' ? 'Driver' : /cook/i.test(person.personClass) ? 'Cook' : 'Maid / housekeeping';
  async function add() {
    if (!phone.trim()) { setErr('Enter a phone number neighbours can call'); return; }
    { const v = validatePhone(phone); if (!v.ok) { setErr(v.error); return; } }
    const out = await save({ name: person.name, category: cat, phone: phone.trim(), rate: rate.trim(), area: 'Works in this community', notes: 'Registered and police-verified with the gate. Listed with the employer\'s consent.', status: 'Active', registryId: person.id, addedBy: currentUser?.name, addedByUnit: unit });
    if (out?.error) setErr(out.error); else { setOpen(false); setErr(''); }
  }
  if (listed) return <div className="gg-row" data-testid="shared-row"><span className="tag green">Listed in the service directory</span><button type="button" className="btn secondary sm" data-testid="unshare" onClick={() => remove(listed)}>Remove</button></div>;
  if (!open) return <button type="button" className="btn secondary sm" data-testid="share-open" onClick={() => setOpen(true)}>Recommend to neighbours</button>;
  return (
    <div className="form-grid" data-testid="share-form" style={{ marginTop: 8 }}>
      <div className="field"><label>Phone to show *</label><input data-testid="share-phone" value={phone} onChange={(e) => { setPhone(e.target.value); setErr(''); }} /></div>
      <div className="field"><label>Typical charges</label><input value={rate} onChange={(e) => setRate(e.target.value)} placeholder="e.g. ₹4,000 a month" /></div>
      {err && <div className="field-error">{err}</div>}
      <small className="muted" style={{ gridColumn: '1 / -1' }}>Only do this with {person.name}'s agreement. Neighbours will see the name and phone, and a "Vetted at gate" tag while they stay cleared.</small>
      <div className="form-actions"><button type="button" className="btn" data-testid="share-save" onClick={add}>List in directory</button><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}
/** Tell security about someone who works for the villa: they are alerted now, and again whenever this person comes to the gate, until they close it. */
function ReportToSecurity({ person, unit, onDone }) {
  const [open, setOpen] = useState(false); const [reason, setReason] = useState(REPORT_REASONS[0]); const [note, setNote] = useState(''); const [stop, setStop] = useState(true);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  async function send() {
    setBusy(true); setErr('');
    try {
      const r = await reportPerson(person, { unit, reason, note, stopEntry: stop });
      if (!r.ok) { setErr(r.reason); return; }
      setOpen(false);
      onDone(`Security has been told about ${person.name}${r.entryStopped ? `, and ${person.name} can no longer come to ${unit}` : ''}. Until they close it, the guard is warned and security is alerted whenever ${person.name} comes to the gate.`);
    } finally { setBusy(false); }
  }
  if (!open) return <button type="button" className="btn secondary sm" data-testid="report-open" onClick={() => setOpen(true)}>Report to security</button>;
  return (
    <div className="form-grid" data-testid="report-form" style={{ marginTop: 8, width: '100%' }}>
      <div className="field" style={{ gridColumn: '1 / -1' }}><label>What happened</label><Chips options={REPORT_REASONS} value={reason} onChange={setReason} label="Reason" /></div>
      <div className="field" style={{ gridColumn: '1 / -1' }}><label>Anything security should know</label><input data-testid="report-note" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} placeholder="e.g. jewellery missing since Monday" /></div>
      <label className="gg-row" style={{ gridColumn: '1 / -1' }}><input type="checkbox" data-testid="report-stop" checked={stop} onChange={(e) => setStop(e.target.checked)} style={{ width: 'auto' }} /> Stop {person.name} coming to {unit}</label>
      <small className="muted" style={{ gridColumn: '1 / -1' }}>Security gets this now, with the photo. Only security can close it.</small>
      {err && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{err}</div>}
      <div className="form-actions"><button type="button" className="btn deny" data-testid="report-send" disabled={busy} onClick={send}>Send report</button><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

function Household({ unit }) {
  const { records: links, save: saveLink } = useCollection(COLLECTIONS.GATE_LINKS, 'Villa links');
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Registry');
  const [done, setDone] = useState('');
  const mine = links.filter((l) => l.unit === unit && l.status !== 'Ended');
  return (
    <div data-testid="my-household">
      <p className="muted">People registered to work at your villa. The security office vets everyone before they start. To add or remove someone, ask the office.</p>
      {done && <div className="notice" role="status" data-testid="report-done">{done}</div>}
      {mine.length === 0 ? <div className="empty">Nobody is linked to your villa yet.</div> : mine.map((l) => {
        const p = people.find((x) => x.id === l.personId); if (!p) return null;
        return (
          <div className="gg-card" key={l.id}><Photo src={p.photo} name={p.name} size={56} />
            <div className="gg-main"><b>{p.name} <StateTag state={p.status} /></b><span className="muted">{p.personClass} · {(l.days || []).join(', ')} {l.fromTime ? plannedTime(`${l.fromTime}–${l.toTime}`) : ''}</span>{p.status !== 'Active' && <small className="muted">Cannot enter until the office has finished checking documents.</small>}<div className="gg-row" style={{ flexWrap: 'wrap' }}>{p.status === 'Active' && (l.confirmedAt && localDay(l.confirmedAt) >= localDay(new Date(Date.now() - 180 * 864e5)) ? <small className="muted" data-testid="confirmed">✔ You confirmed on {localDay(l.confirmedAt)}</small> : <button type="button" className="btn secondary sm" data-testid="confirm-link" onClick={() => saveLink({ ...l, confirmedAt: new Date().toISOString() })}>Yes, still works for us</button>)}{VILLA_CLASSES.includes(p.personClass) && <ShareToDirectory person={p} unit={unit} />}<ReportToSecurity person={p} unit={unit} onDone={setDone} /></div></div></div>
        );
      })}
    </div>
  );
}

function Activity({ unit }) {
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const mine = visits.filter((v) => v.unit === unit).sort((a, b) => String(b.inAt).localeCompare(String(a.inAt))).slice(0, 40);
  return (
    <div data-testid="my-activity">
      {mine.length === 0 ? <div className="empty">No visits yet.</div> : mine.map((v) => (
        <div className="gg-card" key={v.id}><Photo src={v.photo} name={v.name} size={44} />
          <div className="gg-main"><b>{v.name} <StateTag state={v.state} /></b><span className="muted">{v.kind}{v.company ? ` · ${v.company}` : ''} · {stamp(v.inAt)}{v.outAt ? ` → ${clock(v.outAt)}` : ''}</span></div></div>
      ))}
    </div>
  );
}

/** What every resident may know about security: counts and who is on duty, never other villas' visitors. */
function Community() {
  const [d, setD] = useState(null);
  useEffect(() => { const load = () => readDigest().then(setD); load(); const t = setInterval(load, 8000); return () => clearInterval(t); }, []);
  if (!d) return <div className="empty" data-testid="community-empty">No summary yet. It appears once the gate console has been opened today.</div>;
  const stale = d.day !== todayStr();
  return (
    <div data-testid="community-security">
      {stale && <div className="notice">This summary is from {d.day}. The gate console has not refreshed it today.</div>}
      <div className="gg-kpis"><Kpi label="Entries today" value={d.entriesToday} /><Kpi label="Deliveries today" value={d.deliveriesToday} /><Kpi label="Turned away today" value={d.refusedToday} /><Kpi label="Inside now" value={d.insideNow} /><Kpi label="Open security alerts" value={d.openAlerts} warn={d.openAlerts > 0} /></div>
      <div className="card" style={{ marginTop: 14 }}><h2 style={{ marginTop: 0 }}>Guards on duty</h2>
        {(d.guardsOnDuty || []).length === 0 ? <div className="empty">No guard is clocked in right now.</div> : d.guardsOnDuty.map((g) => <div key={g.name} className="gg-row" data-testid="guard-on-duty"><span className="duty-dot" aria-hidden /> <b>{g.name}</b> <small className="muted">since {clock(g.since)} · last active {clock(g.lastSeen)}</small></div>)}
      </div>
      <div className="card" style={{ marginTop: 14 }}><h2 style={{ marginTop: 0 }}>Household staff and crews</h2><p style={{ margin: 0 }}>{d.staffVetted} of {d.staffTotal} registered workers have passed vetting and may enter.</p></div>
      <div className="card" style={{ marginTop: 14 }}><h2 style={{ marginTop: 0 }}>Recent incidents</h2>
        {(d.incidents || []).length === 0 ? <div className="empty">None reported.</div> : d.incidents.map((i, k) => <div key={k} style={{ padding: '6px 0' }}><b>{i.title}</b> <span className="tag">{i.status}</span><br /><small className="muted">{i.gate} · {i.when}</small></div>)}
      </div>
      <small className="muted">Summary only. Other villas' visitors, photos and names are private.</small>
    </div>
  );
}

/** The resident's side of the gate: approve, pass codes, house rules, household staff, visit history. */
export default function MyGate() {
  const { currentUser } = useApp();
  const unit = currentUser?.unit || '';
  const { records: approvals } = useCollection(COLLECTIONS.GATE_APPROVALS, 'Approvals');
  const [tab, setTab] = useState('approvals');
  const mine = approvals.filter((a) => a.unit === unit).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
  const open = mine.filter((a) => ['Pending', 'No answer'].includes(a.status));
  if (!unit) return <div className="empty">Your account is not linked to a villa yet. Ask the office.</div>;
  const tabs = [{ key: 'approvals', label: 'Approvals', count: open.length }, { key: 'passes', label: 'Guest passes' }, { key: 'rules', label: 'My rules' }, { key: 'household', label: 'My household' }, { key: 'activity', label: 'Activity' }, { key: 'community', label: 'Community security' }];
  return (
    <div data-testid="my-gate">
      <div className="page-head"><h1 className="hide-sm">My Gate</h1><p className="muted"><b>Villa {unit}</b><span className="hide-sm">. Approve visitors with their photo, make passes, set how deliveries are handled.</span></p></div>
      <SegTabs tabs={tabs} value={tab} onChange={setTab} label="My gate sections" />
      <div style={{ marginTop: 14 }}>
        {tab === 'approvals' && (open.length === 0 && mine.length === 0 ? <div className="empty">Nobody is waiting at the gate for you.</div> : (
          <>
            {open.length === 0 && <div className="empty">Nobody is waiting at the gate for you.</div>}
            {open.map((a) => <ApprovalCard key={a.id} ap={a} />)}
            {mine.filter((a) => !open.includes(a)).length > 0 && <h3>Earlier</h3>}
            {mine.filter((a) => !open.includes(a)).slice(0, 15).map((a) => <ApprovalCard key={a.id} ap={a} />)}
          </>
        ))}
        {tab === 'passes' && <MyPasses unit={unit} name={currentUser?.name} />}
        {tab === 'rules' && <Rules unit={unit} />}
        {tab === 'household' && <Household unit={unit} />}
        {tab === 'activity' && <Activity unit={unit} />}
        {tab === 'community' && <Community />}
      </div>
    </div>
  );
}
