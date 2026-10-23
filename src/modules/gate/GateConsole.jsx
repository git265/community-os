import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { admitApproved, admitPass, admitPerson, answerApproval, closeVisit, deliveryDecision, findPasses, overrideEntry, passProblem, refuseVisit, requestApproval, retryApproval, sweep, guardBeat, admitGoods, exitGoods, getSettings, verifyBadge, badgeEntry, vehicleAtGate } from '../../lib/gate/engine.js';
import { avatar } from '../../lib/gate/photo.js';
import { DELIVERY_COMPANIES, GATE_NAMES, MANUAL_REASONS } from '../../lib/gate/constants.js';
import { CamScan, ScanBox } from './QrImage.jsx';
import { Chips, Countdown, Kpi, Photo, PhotoCapture, StateTag, clock, sameDay, useTick } from './gateUi.jsx';

const KINDS = ['Guest', 'Cab', 'Goods vehicle', 'Other'];
const MODES = [['pass', '🎫 Pass or code'], ['person', '🪪 Registered person'], ['car', '🚗 Resident car'], ['delivery', '📦 Delivery'], ['other', '🚶 Visitor without a pass'], ['badge', '🪪 Staff badge']];
const plateKey = (x) => String(x || '').replace(/\s+/g, '').toUpperCase();

export default function GateConsole() {
  const { roleId } = useApp();
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const { records: links } = useCollection(COLLECTIONS.GATE_LINKS, 'Gate');
  const { records: flags } = useCollection(COLLECTIONS.GATE_FLAGS, 'Gate');
  const { records: approvals } = useCollection(COLLECTIONS.GATE_APPROVALS, 'Gate');
  const { records: props } = useCollection(COLLECTIONS.PROPERTIES, 'Units');
  const [gate, setGate] = useState(GATE_NAMES[0]);
  const [mode, setMode] = useState('pass');
  const [msg, setMsg] = useState(null);
  const [q, setQ] = useState('');
  const [insideQ, setInsideQ] = useState('');
  useTick(1000);

  // the ghost detector and the approval clock run while a guard has this screen open
  const [cfg, setCfg] = useState({});
  useEffect(() => { guardBeat('opened', true); const load = () => getSettings().then(setCfg).catch(() => {}); load(); sweep().catch(() => {}); const t = setInterval(() => { sweep().catch(() => {}); load(); }, 8000); return () => clearInterval(t); }, []);
  const units = useMemo(() => props.map((p) => p.unit).sort(), [props]);
  const note = (ok, text, extra = {}) => { setMsg({ ok, text, ...extra }); if (ok) setTimeout(() => setMsg((m) => (m && m.text === text ? null : m)), 9000); };

  const inside = visits.filter((v) => v.state === 'Inside' && v.kind !== 'Resident vehicle');
  const waiting = visits.filter((v) => ['Awaiting approval', 'Approved', 'No answer'].includes(v.state) || (v.state === 'Denied' && Date.now() - new Date(v.outAt || v.inAt).getTime() < 5 * 60000));
  const todayIn = visits.filter((v) => sameDay(v.inAt) && !['Refused', 'Denied', 'Awaiting approval', 'No answer', 'Approved'].includes(v.state)).length;
  const openFlags = flags.filter((f) => f.state === 'Open').length;
  const apOf = (v) => approvals.find((a) => a.id === v.approvalId);
  const demo = roleId === 'super_admin';
  const villasOf = (p) => links.filter((l) => l.personId === p.id && l.status !== 'Ended').map((l) => l.unit);
  // a villa reported this person to security (open until security closes it)
  const reported = useMemo(() => Object.fromEntries(flags.filter((f) => f.type === 'Reported person' && f.state !== 'Closed' && !f.visitId && f.personId).map((f) => [f.personId, f.detail])), [flags]);

  return (
    <div data-testid="gate-console" onPointerDownCapture={() => guardBeat()} onKeyDownCapture={() => guardBeat()}>
      <div className="gg-row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}><button type="button" className="btn secondary sm" data-testid="im-here" onClick={() => { guardBeat('check-in', true); note(true, 'Noted. You are at your post.'); }}>📍 I'm at my post</button></div>
      <div className="gg-kpis">
        <Kpi label="Inside now" short="Inside" value={inside.length} />
        <Kpi label="Waiting for a decision" short="Waiting" value={waiting.filter((v) => v.state !== 'Denied').length} warn={waiting.some((v) => v.state === 'No answer')} />
        <Kpi label="Entries today" short="Today" value={todayIn} />
        <Kpi label="Open ghost flags" short="Flags" value={openFlags} warn={openFlags > 0} />
      </div>
      <div className="gg-grid2">
        <div>
          <div className="card">
            <div className="gg-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>At the gate</h2>
              <label className="gg-row" style={{ gap: 6 }}>Gate <select aria-label="Gate" data-testid="gate-select" value={gate} onChange={(e) => setGate(e.target.value)} style={{ width: 'auto' }}>{GATE_NAMES.map((g) => <option key={g}>{g}</option>)}</select></label>
            </div>
            <p className="muted hide-sm" style={{ marginTop: 4 }}>Pick what is happening. The gate decides: allowed people go in on their own, everyone else is shown to the resident with a photo.</p>
            <div className="gg-modes" role="tablist" aria-label="Entry type">{MODES.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={mode === k} className={mode === k ? 'on' : ''} data-testid={`mode-${k}`} onClick={() => { setMode(k); setMsg(null); setQ(''); }}>{l}</button>)}</div>
            {msg && <div className={`notice${msg.ok ? '' : ' error'}`} data-testid="gate-msg" role="status">{msg.text}</div>}
            {mode === 'pass' && <PassMode gate={gate} note={note} q={q} setQ={setQ} />}
            {mode === 'person' && <PersonMode gate={gate} note={note} people={people} villasOf={villasOf} units={units} q={q} setQ={setQ} reported={reported} />}
            {mode === 'car' && <CarMode gate={gate} note={note} visits={visits} />}
            {mode === 'delivery' && <DeliveryMode gate={gate} note={note} people={people} units={units} />}
            {mode === 'other' && <OtherMode gate={gate} note={note} units={units} />}
            {mode === 'badge' && <BadgeMode gate={gate} note={note} />}
          </div>
          <Override gate={gate} units={units} note={note} />
        </div>
        <div>
          <div className="card" data-testid="waiting-card">
            <h2 style={{ marginTop: 0 }}>Waiting for a decision</h2>
            {waiting.length === 0 && <div className="empty">Nobody is waiting. Visitors you send for approval appear here.</div>}
            {waiting.map((v) => <WaitingRow key={v.id} v={v} ap={apOf(v)} demo={demo} note={note} kiosk={!!cfg.kioskOn} />)}
          </div>
          <div className="card" style={{ marginTop: 16 }} data-testid="inside-card">
            <div className="gg-row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Inside now ({inside.length})</h2><input className="search" placeholder="Search name, villa, vehicle" aria-label="Search inside" value={insideQ} onChange={(e) => setInsideQ(e.target.value)} style={{ maxWidth: 220 }} /></div>
            {inside.length === 0 && <div className="empty">Nobody is inside right now.</div>}
            {inside.filter((v) => !insideQ || `${v.name} ${v.unit} ${v.vehicle} ${v.kind}`.toLowerCase().includes(insideQ.toLowerCase())).sort((a, b) => String(b.inAt).localeCompare(String(a.inAt))).map((v) => {
              const late = v.expectedUntil && Date.now() > new Date(v.expectedUntil).getTime();
              return (
                <div className={`gg-card${late ? ' hot' : ''}`} key={v.id} data-testid="inside-row">
                  <Photo src={v.photo} name={v.name} size={48} />
                  <div className="gg-main"><b>{v.name} <small className="muted">· {v.kind}</small></b><span className="muted">{[v.unit, v.company, v.vehicle].filter(Boolean).join(' · ')}</span><small className="muted">In {clock(v.inAt)} by {v.method}{v.expectedUntil ? ` · out by ${clock(v.expectedUntil)}` : ''}{late ? ' · overdue' : ''}</small></div>
                  {v.kind === 'Goods vehicle' ? <GoodsExit v={v} note={note} /> : <button type="button" className="btn secondary" data-testid="check-out" onClick={async () => { await closeVisit(v, 'Guard'); note(true, `${v.name} checked out.`); }}>Check out</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function WaitingRow({ v, ap, demo, note, kiosk }) {
  const state = ap?.status === 'Pending' || !ap ? v.state : v.state;
  const [why, setWhy] = useState(false);
  return (
    <div className={`gg-card ${v.state === 'Approved' ? 'good' : v.state === 'Denied' ? 'bad' : 'hot'}`} data-testid="waiting-row">
      <Photo src={v.photo} name={v.name} size={56} />
      <div className="gg-main">
        <b>{v.name} <StateTag state={state} /></b>
        <span className="muted">{[v.purpose || v.kind, v.company, v.vehicle].filter(Boolean).join(' · ')} → <b>{v.unit}</b></span>
        {ap?.status === 'Pending' && <small className="muted">Asked {clock(ap.requestedAt)} · <Countdown until={ap.expiresAt} /> · then: {ap.fallback || 'hold at gate'}</small>}
        {ap?.status === 'Approved' && <small className="muted">Approved by {ap.answeredBy}</small>}
        {v.state === 'Denied' && <small className="muted">Denied by {ap?.answeredBy || 'the resident'}</small>}
        <div className="gg-actions">
          {v.state === 'Approved' && !kiosk && <button type="button" className="btn good" data-testid="let-in" onClick={async () => { await admitApproved(v); note(true, `${v.name} let in.`); }}>Let in</button>}
          {v.state === 'Approved' && kiosk && <div data-testid="kiosk-wait"><small className="muted">Approved. {v.name} goes to the kiosk, which opens the gate by face.</small>
            {!why ? <div><button type="button" className="btn secondary" data-testid="open-by-hand" onClick={() => setWhy(true)}>Open by hand…</button></div> : (
              <div className="gg-chips" data-testid="manual-reasons" style={{ marginTop: 6 }}>{MANUAL_REASONS.map((r) => <button type="button" key={r} data-testid="manual-reason" onClick={async () => { await admitApproved(v, { manualReason: r }); note(true, `${v.name} let in by hand (${r.toLowerCase()}). Supervisors are told.`); }}>{r}</button>)}</div>)}</div>}
          {v.state === 'No answer' && <button type="button" className="btn secondary" data-testid="ask-again" onClick={async () => { await retryApproval(v); note(true, `Asked ${v.unit} again.`); }}>Ask again</button>}
          {['Awaiting approval', 'No answer', 'Approved'].includes(v.state) && <button type="button" className="btn deny" data-testid="refuse" onClick={async () => { await refuseVisit(v, v.state === 'Approved' ? 'Changed mind' : 'Refused at gate'); note(true, `${v.name} refused.`); }}>Refuse</button>}
          {v.state === 'Denied' && <button type="button" className="btn secondary" onClick={async () => { await refuseVisit(v, 'Denied by resident'); }}>Dismiss</button>}
          {demo && ap && ['Pending', 'No answer'].includes(ap.status) && <>
            <button type="button" className="btn secondary" data-testid="demo-approve" onClick={() => answerApproval(ap.id, 'Approved')}>Demo: approve as resident</button>
            <button type="button" className="btn secondary" data-testid="demo-deny" onClick={() => answerApproval(ap.id, 'Denied')}>Demo: deny</button>
          </>}
        </div>
      </div>
    </div>
  );
}

function PassMode({ gate, note, q, setQ }) {
  const [found, setFound] = useState([]); const [photo, setPhoto] = useState('');
  async function look() { const r = await findPasses(q); setFound(r); if (!r.length) note(false, 'No pass matches that code or name.'); }
  return (
    <div>
      <div className="gg-row"><input aria-label="Pass code or guest name" data-testid="pass-q" placeholder="6-digit code, or the guest's name" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && look()} /><button type="button" className="btn" data-testid="pass-find" onClick={look}>Find pass</button><CamScan onText={async (t) => { setQ(t); const r = await findPasses(t); setFound(r); if (!r.length) note(false, 'No pass matches that code.'); }} testid="pass-cam" /></div>
      {found.map((p) => {
        const bad = passProblem(p);
        return (
          <div className={`gg-card ${bad ? 'bad' : 'good'}`} key={p.id} style={{ marginTop: 10 }} data-testid="pass-result">
            <Photo src={p.photo} name={p.visitorName} size={64} />
            <div className="gg-main"><b>{p.visitorName}</b><span className="muted">Host: {p.hostName || p.unit} · {p.unit} · {p.type} pass</span><small className="muted">Valid {p.validFrom} to {p.validTo}{p.fromTime ? ` · ${p.fromTime}-${p.toTime}` : ''}{p.vehicle ? ` · ${p.vehicle}` : ''}</small>
              {bad ? <div className="field-error" data-testid="pass-problem">{bad}</div> : p.type === 'Goods' ? <GoodsAdmit p={p} gate={gate} note={note} done={() => { setFound([]); setQ(''); }} /> : <div className="gg-actions"><button type="button" className="btn good" data-testid="pass-let-in" onClick={async () => { const r = await admitPass(p, { gate, photo }); if (r.ok || r.outcome === 'ask') { note(true, r.ok ? `${p.visitorName} let in to ${p.unit}.` : `${p.visitorName}: ${r.reason}. Waiting for the answer.`); setFound([]); setQ(''); setPhoto(''); } else note(false, r.reason); }}>Let in</button></div>}
            </div>
          </div>
        );
      })}
      {found.length > 0 && <div style={{ marginTop: 8 }}><PhotoCapture label="Photo at the gate (optional)" value={photo} onChange={setPhoto} demoName="Guest" testid="pass-photo" /></div>}
    </div>
  );
}

function PersonMode({ gate, note, people, villasOf, units, q, setQ, reported = {} }) {
  const [villa, setVilla] = useState({});
  const list = people.filter((p) => !q || `${p.name} ${p.personClass} ${p.vendor || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8);
  return (
    <div>
      <input aria-label="Search the registry" data-testid="person-q" placeholder="Search the registry by name, role or vendor" value={q} onChange={(e) => setQ(e.target.value)} />
      {!q && <p className="muted" style={{ marginBottom: 0 }}>Maids, drivers, riders and crew who have been vetted. The guard sees only what the registry allows today.</p>}
      {q && list.length === 0 && <div className="empty">Nobody in the registry matches. Use "Visitor without a pass".</div>}
      {list.map((p) => (
        <div className="gg-card" key={p.id} style={{ marginTop: 10 }} data-testid="person-result">
          <Photo src={p.photo} name={p.name} size={64} />
          <div className="gg-main"><b>{p.name} <StateTag state={p.status} />{reported[p.id] && <span className="tag gg-tag-coral" data-testid="person-reported">⚠ Reported to security</span>}</b><span className="muted">{p.personClass}{p.vendor ? ` · ${p.vendor}` : ''}{p.deliveryCompany ? ` · ${p.deliveryCompany}` : ''}</span>{villasOf(p).length > 0 && <small className="muted">Works at {villasOf(p).join(', ')}</small>}{reported[p.id] && <small className="field-error">{reported[p.id]}. Call the security supervisor before letting in.</small>}
            <div className="gg-actions">
              {p.personClass === 'Delivery rider' && <input list="gg-units" aria-label="Deliver to villa" placeholder="Deliver to villa" value={villa[p.id] || ''} onChange={(e) => setVilla((s) => ({ ...s, [p.id]: e.target.value }))} style={{ maxWidth: 150 }} />}
              <button type="button" className="btn good" data-testid="person-let-in" onClick={async () => {
                const r = await admitPerson(p, { gate, method: 'Guard verified', unit: villa[p.id] || '' });
                if (r.ok) note(!r.reason, `${p.name} let in${r.visit?.unit ? ` to ${r.visit.unit}` : ''}.${r.reason ? ` ⚠ ${r.reason}.` : ''}`);
                else if (['ask', 'needs-approval'].includes(r.outcome)) note(true, `${p.name}: ${r.reason}. Waiting for the answer.`);
                else note(false, `${p.name}: ${r.reason}`);
              }}>Let in</button>
            </div>
          </div>
        </div>
      ))}
      <datalist id="gg-units">{units.map((u) => <option key={u} value={u} />)}</datalist>
    </div>
  );
}

/** No tag reader: the guard finds a registered car by plate, owner or villa and records it in or out. */
function CarMode({ gate, note, visits }) {
  const { records: vehicles } = useCollection(COLLECTIONS.GATE_VEHICLES, 'Gate');
  const [q, setQ] = useState(''); const [busy, setBusy] = useState('');
  const t = plateKey(q);
  const list = t.length < 2 ? [] : vehicles.filter((v) => !v.recurringGoods && plateKey(`${v.plate} ${v.owner || ''} ${v.unit || ''}`).includes(t)).slice(0, 8);
  const openOf = (v) => visits.find((x) => x.kind === 'Resident vehicle' && x.state === 'Inside' && plateKey(x.vehicle) === plateKey(v.plate));
  async function go(v, direction) {
    setBusy(v.id);
    try {
      const r = await vehicleAtGate({ plate: v.plate, gate, direction });
      if (r.ok) { note(true, `${v.plate} recorded ${direction === 'Out' ? 'out' : 'in'}${r.reason ? `. ${r.reason}` : ''}.`); setQ(''); } else note(false, `${v.plate}: ${r.reason}`);
    } finally { setBusy(''); }
  }
  return (
    <div data-testid="car-mode">
      <input aria-label="Plate, owner or villa" data-testid="car-q" placeholder="Part of the plate, the owner or the villa" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {t.length < 2 && <p className="muted" style={{ marginBottom: 0 }}>Registered cars of residents, tenants and staff, for when there is no tag reader. A car that left without being recorded is closed when it next comes in.</p>}
      {t.length >= 2 && list.length === 0 && <div className="empty">No registered vehicle matches. Use "Visitor without a pass".</div>}
      {list.map((v) => {
        const open = openOf(v); const blocked = v.status === 'Blocked';
        return (
          <div className={`gg-card${blocked ? ' bad' : ''}`} key={v.id} style={{ marginTop: 10 }} data-testid="car-result">
            <div className="gg-main"><b>{v.plate} {blocked ? <StateTag state="Blocked" /> : open ? <StateTag state="Inside" /> : null}</b>
              <span className="muted">{[v.owner, v.unit, v.vehicleClass].filter(Boolean).join(' · ')}</span>
              {open && <small className="muted">In since {clock(open.inAt)}</small>}
              <div className="gg-actions">
                <button type="button" className={`btn ${open ? 'secondary' : 'good'}`} data-testid="car-in" disabled={busy === v.id} onClick={() => go(v, 'In')}>In</button>
                <button type="button" className={`btn ${open ? 'good' : 'secondary'}`} data-testid="car-out" disabled={busy === v.id} onClick={() => go(v, 'Out')}>Out</button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeliveryMode({ gate, note, people, units }) {
  const [f, setF] = useState({ company: DELIVERY_COMPANIES[0], unit: '', name: '', phone: '', vehicle: '', riderId: '' }); const [photo, setPhoto] = useState('');
  const riders = people.filter((p) => p.personClass === 'Delivery rider' && p.status === 'Active');
  const rider = riders.find((r) => r.id === f.riderId);
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  async function go() {
    if (!f.unit.trim()) { note(false, 'Which villa is the delivery for?'); return; }
    if (!rider && !f.name.trim()) { note(false, "Enter the rider's name, or pick a registered rider."); return; }
    const r = await deliveryDecision({ person: rider || null, name: f.name.trim(), phone: f.phone, photo, company: rider?.deliveryCompany && f.company === 'Other' ? rider.deliveryCompany : f.company, unit: f.unit.trim(), gate, vehicle: f.vehicle });
    if (r.outcome === 'admitted') note(true, `${r.visit.name} allowed in for ${f.unit} (${f.company}).`);
    else if (r.outcome === 'left') note(true, `${f.unit} asked for deliveries to be left at the gate. Take the parcel; the villa has been told.`);
    else note(true, `${r.reason || 'Asked the resident'}. Waiting for ${f.unit} to answer.`);
  }
  return (
    <div className="form-grid">
      <div className="field"><label>Company</label><select data-testid="del-company" value={f.company} onChange={(e) => set('company', e.target.value)}>{DELIVERY_COMPANIES.map((c) => <option key={c}>{c}</option>)}</select></div>
      <div className="field"><label>Deliver to villa *</label><input list="gg-units2" data-testid="del-unit" value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
      <div className="field"><label>Registered rider</label><select data-testid="del-rider" value={f.riderId} onChange={(e) => set('riderId', e.target.value)}><option value="">New or unregistered rider</option>{riders.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.deliveryCompany}</option>)}</select></div>
      {!rider && <><div className="field"><label>Rider name *</label><input data-testid="del-name" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field"><label>Rider mobile</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
        <div className="field"><label>Vehicle number</label><input value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)} /></div>
        <PhotoCapture label="Rider photo" value={photo} onChange={setPhoto} demoName={f.name || 'Rider'} testid="del-photo" /></>}
      <div className="form-actions"><button type="button" className="btn" data-testid="del-go" onClick={go}>Check delivery</button></div>
      <datalist id="gg-units2">{units.map((u) => <option key={u} value={u} />)}</datalist>
    </div>
  );
}

function OtherMode({ gate, note, units }) {
  const blankF = { kind: 'Guest', name: '', phone: '', company: '', vehicle: '', purpose: '', unit: '', people: '2', material: '' };
  const [f, setF] = useState(blankF); const [photo, setPhoto] = useState('');
  const set = (k, v) => setF((s) => ({ ...s, [k]: v }));
  async function go() {
    if (!f.name.trim() || !f.unit.trim()) { note(false, 'Name and villa are needed.'); return; }
    if (!photo) { note(false, "Take the visitor's photo first. The resident approves from the photo."); return; }
    const gv = f.kind === 'Goods vehicle';
    if (gv && (!f.vehicle.trim() || !(Number(f.people) >= 1))) { note(false, 'A goods vehicle needs its number and how many people are in it.'); return; }
    const r = await requestApproval({ ...f, name: f.name.trim(), unit: f.unit.trim(), photo, gate, ...(gv ? { headcountIn: Number(f.people), material: f.material, purpose: f.purpose || f.material || 'Goods vehicle' } : {}) });
    note(true, `Sent to ${r.visit.unit} for approval with ${f.name.trim()}'s photo.`);
    setF(blankF); setPhoto('');
  }
  return (
    <div className="form-grid">
      <div className="field"><label>Visitor name *</label><input data-testid="v-name" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
      <div className="field"><label>Going to villa *</label><input list="gg-units3" data-testid="v-unit" value={f.unit} onChange={(e) => set('unit', e.target.value)} /></div>
      <div className="field"><label>Who is it?</label><select value={f.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
      <div className="field"><label>Purpose</label><input data-testid="v-purpose" value={f.purpose} onChange={(e) => set('purpose', e.target.value)} placeholder="e.g. plumber, relative" /></div>
      <div className="field"><label>Company</label><input value={f.company} onChange={(e) => set('company', e.target.value)} /></div>
      <div className="field"><label>Vehicle number</label><input value={f.vehicle} onChange={(e) => set('vehicle', e.target.value)} /></div>
      <div className="field"><label>Mobile</label><input value={f.phone} onChange={(e) => set('phone', e.target.value)} /></div>
      {f.kind === 'Goods vehicle' && <><div className="field"><label>People in the vehicle (driver included) *</label><input type="number" min="1" data-testid="v-people" value={f.people} onChange={(e) => set('people', e.target.value)} /></div><div className="field"><label>Material</label><input data-testid="v-material" value={f.material} onChange={(e) => set('material', e.target.value)} /></div></>}
      <PhotoCapture label={f.kind === 'Goods vehicle' ? 'Photo of the people and vehicle together' : 'Visitor photo'} required value={photo} onChange={setPhoto} demoName={f.name || 'Visitor'} testid="v-photo" />
      <div className="form-actions"><button type="button" className="btn" data-testid="v-send" onClick={go}>Ask the resident</button></div>
      <datalist id="gg-units3">{units.map((u) => <option key={u} value={u} />)}</datalist>
    </div>
  );
}

function Override({ gate, units, note }) {
  const [f, setF] = useState({ name: '', reason: '', unit: '' }); const [photo, setPhoto] = useState(''); const [open, setOpen] = useState(false);
  async function go() {
    if (!f.reason.trim()) { note(false, 'Give the reason for opening without a pass.'); return; }
    if (!photo) { note(false, 'A photo is needed for an override.'); return; }
    await overrideEntry({ ...f, photo, gate });
    note(true, 'Override recorded. A flag has gone to the security manager.'); setF({ name: '', reason: '', unit: '' }); setPhoto(''); setOpen(false);
  }
  return (
    <details className="card" style={{ marginTop: 16 }} open={open} onToggle={(e) => setOpen(e.target.open)} data-testid="override">
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>Emergency: open without a pass or approval</summary>
      <p className="muted">Allowed, but never silent: this records the person, takes a photo and raises a ghost entry flag the manager sees at once.</p>
      <div className="form-grid">
        <div className="field"><label>Who (if known)</label><input data-testid="ov-name" value={f.name} onChange={(e) => setF((s) => ({ ...s, name: e.target.value }))} /></div>
        <div className="field"><label>Going to</label><input list="gg-units4" value={f.unit} onChange={(e) => setF((s) => ({ ...s, unit: e.target.value }))} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Reason *</label><input data-testid="ov-reason" value={f.reason} onChange={(e) => setF((s) => ({ ...s, reason: e.target.value }))} placeholder="e.g. ambulance, fire brigade, resident in distress" /></div>
        <PhotoCapture label="Photo" required value={photo} onChange={setPhoto} demoName={f.name || 'Override'} testid="ov-photo" />
        <div className="form-actions"><button type="button" className="btn deny" data-testid="ov-go" onClick={go}>Open and record</button></div>
      </div>
      <datalist id="gg-units4">{units.map((u) => <option key={u} value={u} />)}</datalist>
    </details>
  );
}

/** A goods pass: count the people in the vehicle, check the plate, then let it in. More people than the pass allows is held until the guard says why. */
function GoodsAdmit({ p, gate, note, done }) {
  const [n, setN] = useState(String(p.peopleCount || 1)); const [plate, setPlate] = useState(p.vehicle || ''); const [photo, setPhoto] = useState('');
  const [hold, setHold] = useState(null);
  async function go(force = '') {
    const r = await admitGoods(p, { gate, people: n, vehicle: plate, photo, force });
    if (r.ok) { note(true, `${p.visitorName} (${plate || 'vehicle'}) let in with ${n} ${Number(n) === 1 ? 'person' : 'people'}.`); setHold(null); done(); return; }
    if (['headcount', 'plate', 'away'].includes(r.outcome)) { setHold(r); return; }
    note(false, r.reason);
  }
  return (
    <div data-testid="goods-admit" style={{ marginTop: 6 }}>
      <div className="muted">🚚 {p.goodsKind || 'Goods'} · allows <b>{p.peopleCount || '?'}</b> people{p.material ? ` · ${p.material}` : ''}{p.carryingOut ? ` · taking out: ${p.outItems}` : ''}</div>
      <div className="form-grid" style={{ marginTop: 6 }}>
        <div className="field"><label>People counted in the vehicle *</label><input type="number" min="1" data-testid="goods-count" value={n} onChange={(e) => { setN(e.target.value); setHold(null); }} /></div>
        <div className="field"><label>Plate at the gate</label><input data-testid="goods-plate" value={plate} onChange={(e) => { setPlate(e.target.value); setHold(null); }} /></div>
        <PhotoCapture label="Photo of the people and vehicle" value={photo} onChange={setPhoto} demoName="Goods vehicle" testid="goods-photo" />
      </div>
      {hold && (
        <div className="notice error" data-testid="goods-hold"><b>{hold.reason}.</b> Do not open unless the resident confirms. If you open it anyway, pick a reason; supervisors are told.
          <div className="gg-chips" style={{ marginTop: 6 }}>{(hold.outcome === 'away' ? ['Resident confirmed by phone', 'Committee approved', 'Other'] : ['Resident confirmed by phone', 'Driver is a known regular', 'Extra helpers are staying outside', 'Other']).map((r) => <button type="button" key={r} data-testid="goods-force" onClick={() => go(r)}>{r}</button>)}</div></div>
      )}
      <div className="gg-actions"><button type="button" className="btn good" data-testid="goods-let-in" onClick={() => go('')}>Let in</button></div>
    </div>
  );
}

/** Leaving: count again. A different number from the one who came in is flagged. */
function GoodsExit({ v, note }) {
  const [open, setOpen] = useState(false); const [n, setN] = useState(String(v.headcountIn ?? '')); const [items, setItems] = useState(false);
  if (!open) return <button type="button" className="btn secondary" data-testid="check-out" onClick={() => setOpen(true)}>Check out…</button>;
  return (
    <div data-testid="goods-exit" style={{ minWidth: 190 }}>
      <label className="muted">People leaving (came in: {v.headcountIn})<input type="number" min="0" data-testid="goods-exit-count" value={n} onChange={(e) => setN(e.target.value)} /></label>
      {v.carryingOut && <label className="gg-row"><input type="checkbox" data-testid="goods-items-ok" checked={items} onChange={(e) => setItems(e.target.checked)} style={{ width: 'auto' }} /> Items match the out-pass: {v.outItems}</label>}
      <div className="gg-actions"><button type="button" className="btn" data-testid="goods-exit-go" onClick={async () => { const r = await exitGoods(v, { people: n, itemsChecked: items }); note(r.ok, r.ok ? `${v.name} checked out with ${n}.` : r.reason); if (r.ok) setOpen(false); }}>Check out</button><button type="button" className="btn secondary sm" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>
  );
}

/** A staff member shows the badge QR on their phone: it proves who they are and opens or closes their visit. */
function BadgeMode({ gate, note }) {
  const [res, setRes] = useState(null);
  async function check(text) {
    const r = await verifyBadge(text); setRes(r);
    if (!r.ok) note(false, r.reason);
  }
  return (
    <div data-testid="badge-mode">
      <p className="muted hide-sm" style={{ marginTop: 0 }}>Scan the QR on the staff member's phone. It changes every 30 seconds, so a screenshot will not work.</p>
      <ScanBox onText={check} placeholder="Scan the badge, or paste its code" testid="badge-scan" button="Check" />
      {res?.ok && (
        <div className="gg-card good" style={{ marginTop: 10 }} data-testid="badge-ok"><Photo src="" name={res.user.name} size={56} />
          <div className="gg-main"><b>{res.user.name} ✓</b><span className="muted">{String(res.user.roleId).replace(/_/g, ' ')} · badge is current</span>
            <div className="gg-actions"><button type="button" className="btn good" data-testid="badge-record" onClick={async () => { const r = await badgeEntry(res.user, { gate }); note(true, `${res.user.name} recorded ${r.direction === 'In' ? 'in' : 'out'}.`); setRes(null); }}>Record in / out</button></div></div></div>
      )}
    </div>
  );
}
