import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { PhoneInput } from '../../components/PeopleFields.jsx';
import { validatePhone } from '../../lib/phone.js';
import { emailError } from '../../lib/validate.js';
import { money as fmtMoney, todayLocal, localDay } from '../../lib/locale.js';
import { currentPeople, leftovers, moveOut, changeOwner, unitHistory, OCCUPANCIES } from '../../lib/unitPeople.js';

const today = () => todayLocal();
const dmy = (s) => (s ? new Date(`${localDay(s)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What stays open when people leave: told before, kept after (unpaid bills stay with the unit). */
function Leftovers({ l }) {
  if (!l) return <div className="muted">Checking what is still open…</div>;
  const items = [];
  if (l.unpaidBills > 0) items.push(<li key="d"><b>{fmtMoney(l.duesOutstanding)}</b> unpaid in {plural(l.unpaidBills, 'bill')} — they stay with the unit</li>);
  if (l.futureBookings > 0) items.push(<li key="b">{plural(l.futureBookings, 'amenity booking')} ahead — kept; cancel them under Amenities if needed</li>);
  if (l.openTickets > 0) items.push(<li key="t">{plural(l.openTickets, 'open request')} they raised — kept open for the team to finish or close</li>);
  if (!items.length) return <div className="notice" data-testid="leftovers-none">Nothing is left open: no unpaid bills, future bookings or open requests.</div>;
  return <div className="notice warn" data-testid="leftovers"><b>Still open</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{items}</ul></div>;
}

/**
 * A tenant moving out (mode 'moveout') or a change of owner (mode 'owner'). Lists who lives there now, who is leaving, the date, what the unit
 * is afterwards and whether the household's gate access stops; shows what stays open before it is confirmed, and what was done after.
 */
export default function UnitHandover({ unit, mode, onClose }) {
  const owner = mode === 'owner';
  const [people, setPeople] = useState(null);
  const [leaving, setLeaving] = useState([]);
  const [on, setOn] = useState(today());
  const [occ, setOcc] = useState('');
  const [endGate, setEndGate] = useState(true);
  const [note, setNote] = useState('');
  const [buyer, setBuyer] = useState({ name: '', phone: '', email: '' });
  const [co, setCo] = useState([]);
  const [left, setLeft] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    let live = true;
    currentPeople(unit).then((ps) => {
      if (!live) return;
      setPeople(ps);
      // who goes by default: a move-out - the tenants; a change of owner - the owners and their family (a tenant may stay on)
      const pick = owner ? ps.filter((p) => !p.isTenant).map((p) => p.key) : ps.filter((p) => p.isTenant).map((p) => p.key);
      setLeaving(pick);
    }).catch((e) => live && setErr(e.message || 'The people of this unit could not be read'));
    return () => { live = false; };
  }, [unit.id, owner]);
  const tenantStays = useMemo(() => (people || []).some((p) => p.isTenant && !leaving.includes(p.key)), [people, leaving]);
  useEffect(() => { setOcc(tenantStays ? 'Tenant occupied' : owner ? 'Owner occupied' : 'Vacant'); }, [tenantStays, owner]);
  useEffect(() => {
    if (!people) return undefined;
    let live = true; setLeft(null);
    leftovers(unit, leaving).then((l) => live && setLeft(l)).catch(() => live && setLeft({ duesOutstanding: 0, unpaidBills: 0, futureBookings: 0, openTickets: 0 }));
    return () => { live = false; };
  }, [people, leaving.join('|')]);   // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (k) => setLeaving((l) => (l.includes(k) ? l.filter((x) => x !== k) : [...l, k]));
  const phoneOk = (p) => validatePhone(p).ok;
  async function confirm() {
    setErr('');
    if (!leaving.length) { setErr(owner ? 'Choose who is leaving (the owner at least)' : 'Choose who is moving out'); return; }
    if (owner) {
      if (!buyer.name.trim()) { setErr('Give the new owner’s name'); return; }
      if (!phoneOk(buyer.phone)) { setErr('Give the new owner’s mobile number (with country code) - it is how they sign in'); return; }
      if (emailError(buyer.email)) { setErr(`New owner: ${emailError(buyer.email)}`); return; }
      const bad = co.find((x) => x.name.trim() && (!phoneOk(x.phone) || emailError(x.email)));
      if (bad) { setErr(`${bad.name}: give a valid mobile number${emailError(bad.email) ? ' and e-mail' : ''}`); return; }
    }
    setBusy(true);
    try {
      const args = { on, leaving, occupancyAfter: occ, endGate, note };
      const r = owner ? await changeOwner(unit, { ...args, newOwner: buyer, coOwners: co }) : await moveOut(unit, args);
      setDone(r);
    } catch (e) { setErr(e.message || 'It could not be saved'); }
    setBusy(false);
  }

  if (done) {
    const g = done.gate || {};
    const gateBits = [g.links ? plural(g.links, 'household staff link') : '', g.passes ? plural(g.passes, 'pass', 'passes') : '', g.vehicles ? plural(g.vehicles, 'car') : ''].filter(Boolean);
    return (
      <Modal title={owner ? 'Owner changed' : 'Moved out'} subtitle={`${unit.unit} · ${dmy(on)}`} onClose={onClose}>
        <ul data-testid="handover-done" style={{ margin: '0 0 10px', paddingLeft: 18 }}>
          <li>{done.accountsClosed ? `${plural(done.accountsClosed, 'sign-in')} closed (they had no other home or role here)` : 'No sign-in closed (they still have another home or role here, or had none)'}</li>
          <li>{gateBits.length ? `Gate: ${gateBits.join(', ')} stopped` : 'Gate: nothing to stop'}</li>
          <li>Kept in the unit’s history, with everything they did here</li>
        </ul>
        <Leftovers l={done.leftovers} />
        <div className="form-actions"><button className="btn" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal title={owner ? `Change of owner · ${unit.unit}` : `Tenant moves out · ${unit.unit}`}
      subtitle={owner ? 'The unit is sold or transferred: the old owners leave, the new owner comes. Nothing is deleted.' : 'A tenant and their family leave. Nothing is deleted.'} onClose={onClose}>
      {!people && !err && <div className="muted">Reading who lives here…</div>}
      {people && (
        <>
          <div className="field"><label>{owner ? 'Who is leaving' : 'Who is moving out'}</label>
            <div className="settle-list" data-testid="handover-people">
              {people.map((p) => {
                const locked = !owner && p.isOwner;   // an owner leaves by a change of owner
                return (
                  <label key={p.key} className={`settle-row${leaving.includes(p.key) ? ' on' : ''}`} title={locked ? 'An owner leaves by a change of owner' : undefined}>
                    <input type="checkbox" checked={leaving.includes(p.key)} disabled={locked} onChange={() => toggle(p.key)} />
                    <span className="grow"><b>{p.name}</b> <small className="muted">· {p.relation}</small>{p.phone && <><br /><small className="muted">{p.phone}</small></>}</span>
                  </label>
                );
              })}
              {!people.length && <div className="empty">Nobody is recorded on this unit.</div>}
            </div>
          </div>
          {owner && (
            <div className="form-grid">
              <div className="field"><label>New owner *</label><input data-testid="buyer-name" value={buyer.name} onChange={(e) => setBuyer({ ...buyer, name: e.target.value })} placeholder="Name on the sale deed" /></div>
              <div className="field"><label>Mobile (with country code) *</label><PhoneInput value={buyer.phone} onChange={(v) => setBuyer({ ...buyer, phone: v })} label="New owner phone" testid="buyer-phone" /></div>
              <div className="field"><label>E-mail (optional)</label><input type="email" value={buyer.email} onChange={(e) => setBuyer({ ...buyer, email: e.target.value })} /></div>
              {co.map((x, i) => (
                <React.Fragment key={i}>
                  <div className="field"><label>Co-owner</label><input value={x.name} onChange={(e) => setCo(co.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} /></div>
                  <div className="field"><label>Mobile</label><PhoneInput value={x.phone} onChange={(v) => setCo(co.map((y, j) => (j === i ? { ...y, phone: v } : y)))} label="Co-owner phone" /></div>
                </React.Fragment>
              ))}
              <div className="field" style={{ gridColumn: '1 / -1' }}><button type="button" className="btn secondary sm" onClick={() => setCo([...co, { name: '', phone: '', email: '' }])}>+ Co-owner</button></div>
            </div>
          )}
          <div className="form-grid">
            <div className="field"><label>{owner ? 'Transfer date' : 'Moved out on'} *</label><input type="date" data-testid="handover-date" value={on} max={today()} onChange={(e) => setOn(e.target.value)} /></div>
            <div className="field"><label>Occupied by afterwards *</label>
              <select data-testid="handover-occupancy" value={occ} onChange={(e) => setOcc(e.target.value)}>
                {OCCUPANCIES.filter((o) => (tenantStays ? o === 'Tenant occupied' : o !== 'Tenant occupied')).map((o) => <option key={o}>{o}</option>)}
              </select>
              {!tenantStays && <small className="muted">A new tenant is added on the unit afterwards (Edit).</small>}
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label className="check"><input type="checkbox" data-testid="handover-gate" checked={endGate} disabled={tenantStays && !owner} onChange={(e) => setEndGate(e.target.checked)} /> Stop the household’s gate access: maid / driver links, passes and cars of {unit.unit}</label>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note (optional)</label><textarea rows={2} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} placeholder={owner ? 'Sale deed number, registration date …' : 'Lease ended, keys returned …'} /></div>
          </div>
          <Leftovers l={left} />
        </>
      )}
      {err && <div className="field-error" role="alert" data-testid="handover-error">{err}</div>}
      <div className="form-actions">
        <button className="btn" data-testid="handover-confirm" disabled={busy || !people} onClick={confirm}>{busy ? 'Saving…' : owner ? 'Change the owner' : 'Record the move-out'}</button>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

/** The unit's history: who moved out, who came, owner changes - with what stayed open each time. */
export function UnitHistory({ unit, onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { let live = true; unitHistory(unit).then((r) => live && setRows(r)).catch((e) => live && setErr(e.message || 'The history could not be read')); return () => { live = false; }; }, [unit.id]);
  const names = (xs) => (xs || []).map((x) => `${x.name}${x.relation ? ` (${x.relation})` : ''}`).join(', ');
  return (
    <Modal title={`Past owners & tenants · ${unit.unit}`} subtitle="Every move-out and change of owner, latest first. Nothing is deleted." onClose={onClose}>
      {err && <div className="field-error">{err}</div>}
      {!rows && !err && <div className="muted">Reading…</div>}
      {rows && !rows.length && <div className="empty" data-testid="history-empty">No move-out or change of owner recorded yet.</div>}
      {rows && rows.length > 0 && (
        <ul className="plain-list" data-testid="unit-history">
          {rows.map((c) => (
            <li key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line, #e5e7eb)' }}>
              <b>{dmy(c.on)} · {c.kind}</b> {c.shortId && <small className="muted">{c.shortId}</small>}
              {c.out?.length > 0 && <div><small className="muted">Left:</small> {names(c.out)}</div>}
              {c.in?.length > 0 && <div><small className="muted">Came:</small> {names(c.in)}</div>}
              {Number(c.duesOutstanding) > 0 && <div><small className="muted">Unpaid then (stayed with the unit):</small> {fmtMoney(c.duesOutstanding)}</div>}
              {c.note && <div><small className="muted">Note:</small> {c.note}</div>}
              <small className="muted">{[c.occupancyBefore && c.occupancyAfter && c.occupancyBefore !== c.occupancyAfter ? `${c.occupancyBefore} → ${c.occupancyAfter}` : '', c.by ? `by ${c.by}` : ''].filter(Boolean).join(' · ')}</small>
            </li>
          ))}
        </ul>
      )}
      <div className="form-actions"><button className="btn secondary" onClick={onClose}>Close</button></div>
    </Modal>
  );
}
