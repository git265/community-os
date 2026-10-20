import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { CREW_CLASSES, DAYS, PERSON_CLASSES, PERSON_STATUS, VILLA_CLASSES } from '../../lib/gate/constants.js';
import { notifyGate } from '../../lib/gate/engine.js';
import { checkIdNumber, freshness, idHash } from '../../lib/gate/idcheck.js';
import { Chips, Photo, PhotoCapture, StateTag } from './gateUi.jsx';

const ld = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ld(new Date());
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ld(d); };
/** What a person needs before they may be Active, by role. */
export function checklist(p) {
  const rider = p.personClass === 'Delivery rider';
  const items = [['idChecked', 'ID document checked', !!p.idChecked]];
  if (!rider) items.push(['addressChecked', 'Address proof checked', !!p.addressChecked], ['policeVerified', 'Police verification certificate seen', !!p.policeVerified && (!p.policeExpiry || p.policeExpiry >= today())], ['referenceChecked', 'Reference called', !!p.referenceChecked]);
  items.push(['faceEnrolled', 'Photo taken and face enrolled', !!p.faceEnrolled && !!p.photo]);
  if (p.personClass === 'Driver') items.push(['licence', 'Driving licence valid', !!p.licenceNo && !!p.licenceExpiry && p.licenceExpiry >= today()]);
  if (CREW_CLASSES.includes(p.personClass) && p.personClass !== 'Contractor') items.push(['vendor', 'Vendor / agency recorded', !!p.vendor]);
  return items;
}
export const vettingBadge = (p) => { const c = checklist(p); return `${c.filter((x) => x[2]).length}/${c.length}`; };
export const expiring = (p) => p.policeExpiry && p.policeExpiry >= today() && p.policeExpiry <= inDays(30);

function Links({ person, canEdit }) {
  const { records: links, save } = useCollection(COLLECTIONS.GATE_LINKS, 'Gate');
  const { records: props } = useCollection(COLLECTIONS.PROPERTIES, 'Units');
  const mine = links.filter((l) => l.personId === person.id);
  const [f, setF] = useState({ unit: '', days: DAYS.slice(0, 6), fromTime: '07:00', toTime: '13:00' }); const [err, setErr] = useState('');
  async function add() { if (!f.unit.trim()) { setErr('Choose the villa'); return; } setErr(''); await save({ personId: person.id, personName: person.name, ...f, unit: f.unit.trim(), status: 'Active' }); setF((s) => ({ ...s, unit: '' })); }
  return (
    <div data-testid="person-links">
      <h3>Villas this person works at</h3>
      {mine.length === 0 && <p className="muted">Not linked to any villa yet. A maid, cook or driver can enter only the villas, days and hours listed here.</p>}
      {mine.map((l) => <div className="gg-check" key={l.id} data-testid="link-row"><span style={{ flex: 1 }}><b>{l.unit}</b> · {(l.days || []).join(', ') || 'every day'} · {l.fromTime || '—'} to {l.toTime || '—'} <StateTag state={l.status} /></span>{canEdit && l.status !== 'Ended' && <button type="button" className="btn secondary sm" onClick={() => save({ ...l, status: 'Ended' })}>End</button>}</div>)}
      {canEdit && (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label>Villa</label><input list="gg-link-units" data-testid="link-unit" value={f.unit} onChange={(e) => setF((s) => ({ ...s, unit: e.target.value }))} /><datalist id="gg-link-units">{props.map((p) => <option key={p.id} value={p.unit} />)}</datalist></div>
          <div className="field"><label>From</label><input type="time" value={f.fromTime} onChange={(e) => setF((s) => ({ ...s, fromTime: e.target.value }))} /></div>
          <div className="field"><label>To</label><input type="time" value={f.toTime} onChange={(e) => setF((s) => ({ ...s, toTime: e.target.value }))} /></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Days</label><Chips multi options={DAYS} value={f.days} onChange={(d) => setF((s) => ({ ...s, days: d }))} label="Days" /></div>
          {err && <div className="field-error">{err}</div>}
          <div className="form-actions"><button type="button" className="btn" data-testid="link-add" onClick={add}>Link to villa</button></div>
        </div>
      )}
    </div>
  );
}

function IdCheck({ p, people, set }) {
  const [type, setType] = useState(p.idType || 'Aadhaar'); const [num, setNum] = useState(''); const [res, setRes] = useState(null);
  async function run() {
    const r = checkIdNumber(type, num);
    if (!r.ok) { setRes({ ok: false, text: r.problem }); return; }
    const h = await idHash(type, num);
    const dup = people.find((x) => x.id !== p.id && x.idHash === h);
    if (dup) { setRes({ ok: false, text: `This number is already registered to ${dup.name} (${dup.shortId}).` }); return; }
    await set({ idType: type, idLast4: r.last4, idHash: h, idFormatOk: true });
    setNum(''); setRes({ ok: true, text: `Format is valid and unique. Saved the last four digits (${r.last4}) only; the full number is not kept.` });
  }
  return (
    <div className="card" data-testid="id-check" style={{ margin: '10px 0' }}>
      <h3 style={{ marginTop: 0 }}>ID number check</h3>
      <div className="gg-row" style={{ flexWrap: 'wrap' }}>
        <select aria-label="ID type" data-testid="idc-type" value={type} onChange={(e) => { setType(e.target.value); setRes(null); }} style={{ width: 'auto' }}>{['Aadhaar', 'Voter ID', 'Passport', 'Driving licence', 'Other'].map((t) => <option key={t}>{t}</option>)}</select>
        <input aria-label="ID number" data-testid="idc-num" autoComplete="off" value={num} onChange={(e) => { setNum(e.target.value); setRes(null); }} placeholder="Type the number from the document" style={{ flex: 1, minWidth: 180 }} />
        <button type="button" className="btn secondary" data-testid="idc-run" onClick={run}>Check</button>
      </div>
      {res && <div data-testid="idc-result" className={res.ok ? 'notice' : 'field-error'} style={{ marginTop: 6 }}>{res.ok ? '✅ ' : '⚠ '}{res.text}</div>}
      {p.idFormatOk && <small className="muted" data-testid="idc-saved">On file: {p.idType} ending {p.idLast4}, format checked.</small>}
      <small className="muted" style={{ display: 'block' }}>This catches typos and the same number used twice. It cannot prove the document is genuine; compare it with the original and the person's face.</small>
    </div>
  );
}

export function PersonPanel({ personId, onClose, canEdit = true }) {
  const { records, save } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const p = records.find((r) => r.id === personId);
  const [reason, setReason] = useState(''); const [err, setErr] = useState(''); const [edit, setEdit] = useState(false);
  if (!p) return null;
  const list = checklist(p); const missing = list.filter((x) => !x[2]);
  const set = (patch) => save({ ...p, ...patch });
  async function status(next, needReason = false) {
    if (needReason && !reason.trim()) { setErr('Give a reason'); return; }
    setErr('');
    await set({ ...(next === 'Active' ? { verifiedAt: today() } : {}), status: next, statusReason: needReason ? reason.trim() : next === 'Active' ? '' : p.statusReason, ...(next === 'Under review' ? { submittedAt: new Date().toISOString() } : {}) });
    if (needReason) { notifyGate('vetting', { title: `${p.name}: ${next}`, body: reason.trim(), image: p.photo }); setReason(''); }
  }
  const toggle = (k) => (k === 'licence' || k === 'vendor' ? setEdit(true) : set({ [k]: !p[k], ...(k === 'policeVerified' && !p.policeVerified && !p.policeExpiry ? { policeExpiry: inDays(365) } : {}) }));
  return (
    <Modal title={p.name} subtitle={`${p.shortId || ''} · ${p.personClass}${p.vendor ? ` · ${p.vendor}` : ''}`} onClose={onClose} wide>
      <div className="gg-row" style={{ alignItems: 'flex-start' }} data-testid="person-panel">
        <Photo src={p.photo} name={p.name} size={96} />
        <div style={{ flex: 1 }}>
          <div><StateTag state={p.status} /> {p.statusReason && <small className="muted">{p.statusReason}</small>}</div>
          <p className="muted" style={{ margin: '6px 0' }}>{p.phone} {p.idLast4 ? `· ${p.idType || 'ID'} ending ${p.idLast4}` : ''} {p.invitedByUnit ? `· invited by ${p.invitedByUnit}` : ''}</p>
          {canEdit && <button type="button" className="btn secondary" data-testid="person-edit" onClick={() => setEdit(true)}>Edit details</button>}
        </div>
      </div>
      <h3>Vetting checklist</h3>
      {list.map(([k, label, ok]) => (
        <div className="gg-check" key={k} data-testid={`check-${k}`}><i>{ok ? '✅' : '⬜'}</i><span style={{ flex: 1 }}>{label}{k === 'policeVerified' && p.policeExpiry ? <small className="muted"> · valid until {p.policeExpiry}{expiring(p) ? ' (expiring soon)' : ''}</small> : null}</span>{canEdit && <button type="button" className="btn secondary sm" onClick={() => toggle(k)}>{k === 'licence' || k === 'vendor' ? 'Edit' : ok ? 'Undo' : 'Mark done'}</button>}</div>
      ))}
      {canEdit && p.status !== 'Blocked' && <IdCheck p={p} people={records} set={set} />}
      {canEdit && <div style={{ marginTop: 10 }}><PhotoCapture label="Photo for face enrolment" value={p.photo} onChange={(ph) => set({ photo: ph, faceEnrolled: !!ph })} demoName={p.name} testid="person-photo" /></div>}
      {canEdit && (
        <div style={{ marginTop: 12 }}>
          <h3>Decision</h3>
          <div className="gg-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            {['Invited', 'Documents pending'].includes(p.status) && <button type="button" className="btn" data-testid="st-submit" onClick={() => status('Under review')}>Submit for review</button>}
            {p.status === 'Under review' && <button type="button" className="btn good" data-testid="st-activate" disabled={missing.length > 0} title={missing.length ? `Still needed: ${missing.map((m) => m[1]).join(', ')}` : ''} onClick={() => status('Active')}>Approve and activate</button>}
            {p.status === 'Under review' && <button type="button" className="btn secondary" data-testid="st-back" onClick={() => status('Documents pending', true)}>Send back</button>}
            {p.status === 'Suspended' && <button type="button" className="btn good" data-testid="st-reinstate" disabled={missing.length > 0} onClick={() => status('Active')}>Reinstate</button>}
            {p.status === 'Blocked' && <button type="button" className="btn secondary" data-testid="st-unblock" onClick={() => status('Under review')}>Unblock (re-review)</button>}
            {p.status === 'Active' && <button type="button" className="btn secondary" data-testid="st-suspend" onClick={() => status('Suspended', true)}>Suspend</button>}
            {['Active', 'Suspended', 'Under review', 'Documents pending'].includes(p.status) && <button type="button" className="btn deny" data-testid="st-block" onClick={() => status('Blocked', true)}>Block</button>}
            {(p.status === 'Active' || p.status === 'Suspended' || p.status === 'Under review' || p.status === 'Documents pending') && <input aria-label="Reason" data-testid="st-reason" placeholder="Reason (for send back, suspend or block)" value={reason} onChange={(e) => { setReason(e.target.value); setErr(''); }} style={{ flex: 1, minWidth: 200 }} />}
          </div>
          {err && <div className="field-error">{err}</div>}
          {p.status === 'Under review' && missing.length > 0 && <small className="muted">Still needed: {missing.map((m) => m[1]).join(', ')}</small>}
        </div>
      )}
      {VILLA_CLASSES.includes(p.personClass) && <div style={{ marginTop: 14 }}><Links person={p} canEdit={canEdit && p.status === 'Active'} />{p.status !== 'Active' && <small className="muted">Villas can be linked once the person is Active.</small>}</div>}
      {edit && <RecordModal collection={COLLECTIONS.GATE_PEOPLE} label="Gate" record={p} title={`Edit ${p.name}`} onClose={() => setEdit(false)} />}
    </Modal>
  );
}

/** Registry freshness: expired papers, people not seen at the gate, villas that have not confirmed lately. */
function Freshness({ people, links, canEdit, onOpen }) {
  const { records: visits } = useCollection(COLLECTIONS.GATE_VISITS, 'Gate');
  const { save } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const [busy, setBusy] = useState(false);
  const issues = useMemo(() => {
    const last = new Map(); visits.forEach((v) => { if (v.personId && v.inAt && (!last.get(v.personId) || v.inAt > last.get(v.personId))) last.set(v.personId, v.inAt); });
    const cutoff = inDays(-180);
    const out = [];
    people.forEach((p) => {
      freshness(p, { lastSeen: last.get(p.id)?.slice(0, 10) }).forEach((f) => out.push({ p, ...f }));
      if (p.status === 'Active' && VILLA_CLASSES.includes(p.personClass)) {
        const ls = links.filter((l) => l.personId === p.id && l.status !== 'Ended');
        if (ls.length && ls.every((l) => !l.confirmedAt || l.confirmedAt.slice(0, 10) < cutoff)) out.push({ p, key: 'confirm', text: 'No villa has confirmed this person in 6 months', fix: 'ask' });
      }
    });
    return out;
  }, [people, links, visits]);
  const expired = issues.filter((i) => i.fix === 'suspend');
  async function suspendExpired() {
    setBusy(true);
    for (const i of expired) await save({ ...i.p, status: 'Suspended', statusReason: `${i.text} (automatic)` });
    setBusy(false);
  }
  return (
    <div className="card" style={{ marginBottom: 14 }} data-testid="reg-freshness">
      <div className="gg-row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Is the registry up to date? <span className={`tag ${issues.length ? 'orange' : 'green'}`} data-testid="fresh-count">{issues.length}</span></h2>
        {canEdit && expired.length > 0 && <button type="button" className="btn secondary" data-testid="suspend-expired" disabled={busy} onClick={suspendExpired}>Suspend {expired.length} with expired papers</button>}</div>
      {issues.length === 0 ? <p className="muted">Every active person has valid papers, has been seen recently and is confirmed by their villa.</p> : (
        <ul className="list" style={{ display: 'block' }}>{issues.slice(0, 30).map((i, k) => <li key={k} data-testid="fresh-row" style={{ display: 'block', padding: '5px 0', cursor: 'pointer' }} onClick={() => onOpen(i.p.id)}><b>{i.p.name}</b> <span className="muted">· {i.text}</span></li>)}</ul>
      )}
      <small className="muted hide-sm">Expired papers already stop entry at the gate. Residents are asked to confirm their household staff in My Gate.</small>
    </div>
  );
}

export default function GateRegistry({ canEdit = true }) {
  const { records: people } = useCollection(COLLECTIONS.GATE_PEOPLE, 'Gate');
  const { records: links } = useCollection(COLLECTIONS.GATE_LINKS, 'Gate');
  const [status, setStatus] = useState(''); const [cls, setCls] = useState(''); const [q, setQ] = useState(''); const [open, setOpen] = useState(null); const [adding, setAdding] = useState(false);
  const count = (s) => people.filter((p) => p.status === s).length;
  const rows = useMemo(() => people.filter((p) => (!status || p.status === status) && (!cls || p.personClass === cls) && (!q || `${p.name} ${p.vendor || ''} ${p.phone || ''} ${p.shortId}`.toLowerCase().includes(q.toLowerCase()))).sort((a, b) => PERSON_STATUS.indexOf(a.status) - PERSON_STATUS.indexOf(b.status) || a.name.localeCompare(b.name)), [people, status, cls, q]);
  const needs = people.filter((p) => ['Documents pending', 'Under review'].includes(p.status)).length;
  return (
    <div data-testid="gate-registry">
      <div className="gg-kpis"><div className="gg-kpi"><span className="muted">Active</span><b>{count('Active')}</b></div><div className={`gg-kpi${needs ? ' warn' : ''}`}><span className="muted">Vetting queue</span><b>{needs}</b></div><div className={`gg-kpi${people.filter(expiring).length ? ' warn' : ''}`}><span className="muted">Expiring in 30 days</span><b>{people.filter(expiring).length}</b></div><div className="gg-kpi"><span className="muted">Suspended or blocked</span><b>{count('Suspended') + count('Blocked')}</b></div></div>
      <Freshness people={people} links={links} canEdit={canEdit} onOpen={setOpen} />
      <div className="card">
        <div className="toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="gg-chips"><button type="button" className={!status ? 'on' : ''} onClick={() => setStatus('')}>All ({people.length})</button>{PERSON_STATUS.map((s) => <button key={s} type="button" className={status === s ? 'on' : ''} data-testid={`reg-${s}`} onClick={() => setStatus(s)}>{s} ({count(s)})</button>)}</div>
          <select aria-label="Role" value={cls} onChange={(e) => setCls(e.target.value)} style={{ width: 'auto' }}><option value="">All roles</option>{PERSON_CLASSES.map((c) => <option key={c}>{c}</option>)}</select>
          <input className="search" aria-label="Search the registry" placeholder="Search name, vendor, phone" value={q} onChange={(e) => setQ(e.target.value)} />
          {canEdit && <button type="button" className="btn" style={{ marginLeft: 'auto' }} data-testid="reg-add" onClick={() => setAdding(true)}>+ Add person</button>}
        </div>
        <div className="table-wrap hide-sm"><table><thead><tr><th></th><th>Name</th><th>Role</th><th>Status</th><th>Works for</th><th>Checks</th><th>Police cert. until</th></tr></thead><tbody>
          {rows.map((p) => (
            <tr key={p.id} className="clickable" data-testid="reg-row" onClick={() => setOpen(p.id)}>
              <td><Photo src={p.photo} name={p.name} size={34} /></td><td><b>{p.name}</b><br /><small className="muted">{p.shortId}</small></td><td>{p.personClass}</td><td><StateTag state={p.status} /></td>
              <td>{VILLA_CLASSES.includes(p.personClass) ? [...new Set(links.filter((l) => l.personId === p.id && l.status !== 'Ended').map((l) => l.unit))].join(', ') || '—' : p.vendor || p.deliveryCompany || '—'}</td>
              <td>{vettingBadge(p)}</td><td>{p.policeExpiry || '—'}{expiring(p) && <span className="tag orange" style={{ marginLeft: 6 }}>soon</span>}{p.policeExpiry && p.policeExpiry < today() && <span className="tag gg-tag-coral" style={{ marginLeft: 6 }}>expired</span>}</td>
            </tr>
          ))}
        </tbody></table>{rows.length === 0 && <div className="empty">Nobody matches.</div>}</div>
        <div className="show-sm" data-testid="reg-list">
          {rows.length === 0 && <div className="empty">Nobody matches.</div>}
          {rows.map((p) => (
            <div key={p.id} className="gg-mini" data-testid="reg-card" onClick={() => setOpen(p.id)}>
              <Photo src={p.photo} name={p.name} size={36} />
              <div className="gg-main"><b>{p.name}</b><small className="muted">{p.personClass} · checks {vettingBadge(p)}{expiring(p) ? ' · papers expire soon' : ''}</small></div>
              <StateTag state={p.status} />
            </div>
          ))}
        </div>
      </div>
      {open && <PersonPanel personId={open} onClose={() => setOpen(null)} canEdit={canEdit} />}
      {adding && <RecordModal collection={COLLECTIONS.GATE_PEOPLE} label="Gate" record={{ status: 'Documents pending', personClass: 'Maid / cook' }} title="Add a person to the registry" subtitle="Start the vetting: add the basics here, then tick the checks and take the photo." onSaved={(saved) => setOpen(saved.id)} onClose={() => setAdding(false)} />}
    </div>
  );
}
