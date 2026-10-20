import React, { useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C, storage } from '../../lib/storage/index.js';
import { PhoneInput } from '../../components/PeopleFields.jsx';
import { validatePhone } from '../../lib/phone.js';
import { recomputeEventTotals } from '../../lib/culturalServer.js';
import { notify } from '../../lib/notify.js';
import PayPanel from '../../components/PayPanel.jsx';
import { claimPayment } from '../../lib/payments.js';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/** Seva offerings: pick an open slot (or the community pool), give the devotee details, review and confirm the pledge. */
export default function Offerings({ ev, offerings, manager, canPledge, onEdit, onAdd }) {
  const { currentUser } = useApp();
  const { save: saveOffering } = useCollection(C.CULTURAL_OFFERINGS, 'Seva Offerings');
  const { save: saveDonation, remove: removeDonation, records: myDonations } = useCollection(C.CULTURAL_DONATIONS, 'Donations');
  const [pick, setPick] = useState(null);
  const [showReserved, setShowReserved] = useState(false);
  const [f, setF] = useState({ devotee: currentUser?.name || '', unit: currentUser?.unit || '', phone: currentUser?.phone || '', members: '', sankalpam: '', amount: '' });
  const [err, setErr] = useState({});
  const [done, setDone] = useState('');
  const [paying, setPaying] = useState(null); // the pledge just made, shown with the UPI QR
  const profile = !manager && !!currentUser?.name && !!currentUser?.unit; // residents: details come from the logged-in profile
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const open = ev.status === 'Open' || ev.status === 'Planning';
  const fixed = offerings.filter((o) => o.kind === 'Fixed slot');
  const pools = offerings.filter((o) => o.kind === 'Community pool');
  const available = fixed.filter((o) => !o.reservedUnit);
  const reserved = fixed.filter((o) => o.reservedUnit);
  const amount = pick ? (pick.kind === 'Community pool' ? Number(f.amount) || 0 : Number(pick.pledgeValue) || 0) : 0;
  const mineFor = (o) => myDonations.find((d) => d.offeringId === o.id);

  async function confirm() {
    const er = {};
    if (!pick) er.pick = 'Choose an offering above';
    if (!f.devotee.trim()) er.devotee = 'Devotee name is required';
    if (!f.unit.trim()) er.unit = 'Villa number is required';
    if (f.phone && !validatePhone(f.phone).ok) er.phone = validatePhone(f.phone).error;
    if (pick?.kind === 'Community pool' && !(amount > 0)) er.amount = 'Enter the amount you wish to contribute';
    setErr(er); if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      if (pick.kind === 'Fixed slot') {
        const fresh = await storage.get(C.CULTURAL_OFFERINGS, pick.id); // somebody may have just taken it
        if (fresh?.reservedUnit) { setErr({ pick: 'Sorry — this slot has just been reserved by another family. Please choose another.' }); setPick(null); return; }
        const r = await saveOffering({ ...pick, reservedBy: f.devotee.trim(), reservedUnit: f.unit.trim(), reservedAt: now.slice(0, 10) });
        if (!r) return;
      }
      const don = await saveDonation({ eventId: ev.id, offeringId: pick.id, donor: f.devotee.trim(), unit: f.unit.trim(), kind: 'Sponsorship', towards: 'Seva offering', amount, date: now.slice(0, 10), mode: 'UPI', reference: '', status: 'Pledged', receiptNo: '', anonymous: false, phone: f.phone, members: f.members.trim(), sankalpam: f.sankalpam.trim(), note: `${pick.title}${pick.day ? ` · ${pick.day}` : ''}` });
      if (!don) { if (pick.kind === 'Fixed slot') await saveOffering({ ...pick, reservedBy: '', reservedUnit: '', reservedAt: '' }); return; }
      if (pick.kind === 'Fixed slot') await saveOffering({ ...pick, reservedBy: f.devotee.trim(), reservedUnit: f.unit.trim(), reservedAt: now.slice(0, 10), donationId: don.id });
      await recomputeEventTotals(ev.id);
      notify({ event: 'cultural', title: `Seva pledge · ${pick.title}`, body: `${f.devotee.trim()} (${f.unit.trim()}) pledged ${inr(amount)} for ${pick.title}. Confirm receipt under Cultural → Donations.`, link: '#/cultural', toRoleIds: ['committee_cultural', 'president', 'general_secretary', 'treasurer'], by: currentUser?.name || '' }).catch(() => {});
      setDone(`Thank you! Your pledge of ${inr(amount)} for “${pick.title}” is reserved. Pay now online (or by UPI); your receipt is sent once the payment is confirmed.`);
      setPaying(don);
      setPick(null); setF((x) => ({ ...x, members: '', sankalpam: '', amount: '' }));
    } finally { setBusy(false); }
  }

  async function release(o) {
    if (!window.confirm(`Release “${o.title}”? The pledge is withdrawn and the slot opens again.`)) return;
    const don = (o.donationId && await storage.get(C.CULTURAL_DONATIONS, o.donationId)) || null;
    if (don?.status === 'Received') { window.alert('This pledge has already been received and receipted. Ask the committee to adjust it.'); return; }
    if (don) await removeDonation(don.id);
    await saveOffering({ ...o, reservedBy: '', reservedUnit: '', reservedAt: '', donationId: '' });
    await recomputeEventTotals(ev.id);
  }

  const Card = ({ o }) => {
    const pool = o.kind === 'Community pool';
    const sel = pick?.id === o.id;
    return (
      <button type="button" data-testid={`offer-${o.title}`} disabled={!canPledge || !open} onClick={() => { setPick(o); setDone(''); setErr({}); }}
        className="card" style={{ textAlign: 'left', width: '100%', marginBottom: 8, cursor: canPledge && open ? 'pointer' : 'default', border: sel ? '2px solid var(--blue)' : pool ? '1px solid #d9a400' : undefined }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 200 }}>
            <span className={`tag ${pool ? 'orange' : 'green'}`}>{pool ? 'Community pool · open for any amount' : 'Available slot'}</span>
            <div style={{ fontWeight: 700, marginTop: 4 }}>{o.title} <small className="mono muted" data-testid="rec-id">{o.shortId}</small></div>
            {o.day && <div className="muted">{o.day}</div>}
            {o.description && <div style={{ fontSize: 13 }}>{o.description}</div>}
          </span>
          <span style={{ textAlign: 'right' }}><small className="muted">{pool ? 'Contribute' : 'Pledge value'}</small><div style={{ fontWeight: 700, fontSize: 18 }}>{pool ? 'Any amount' : inr(o.pledgeValue)}</div></span>
        </div>
        {manager && <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}><span className="btn secondary sm" role="button" onClick={() => onEdit(o)}>Edit</span></div>}
      </button>
    );
  };

  return (
    <div data-testid="cultural-offerings">
      <div style={{ marginBottom: 10 }}>
        <h2 style={{ margin: 0 }} data-testid="offerings-title">{ev.offeringsTitle || 'Offerings & sponsorships'}</h2>
        <div className="muted" data-testid="offerings-intro">{ev.offeringsIntro || 'Choose an offering or contribute to the community pool. Your details come from your profile — review, confirm and pay by UPI.'}</div>
      </div>
      <div className="grid metrics" style={{ marginBottom: 12 }}>
        <div className="card metric"><div className="label">Total pledged</div><div className="value" data-testid="o-pledged">{inr((ev.collected || 0) + (ev.pledged || 0))}</div></div>
        <div className="card metric"><div className="label">Devotee families</div><div className="value" data-testid="o-families">{ev.families || 0} {ev.families === 1 ? 'pledge' : 'pledges'}</div></div>
        <div className="card metric"><div className="label">Open slots</div><div className="value" data-testid="o-open">{available.length}{pools.length ? ` + ${pools.length} pool${pools.length > 1 ? 's' : ''}` : ''}</div></div>
      </div>
      {manager && <div style={{ marginBottom: 8, textAlign: 'right' }}><button type="button" className="btn secondary sm" data-testid="add-offering" onClick={onAdd}>+ Add offering</button></div>}
      {done && <div className="notice" data-testid="pledge-done">✅ {done}</div>}
      {!open && <div className="notice">This event is {ev.status.toLowerCase()} — offerings are closed.</div>}

      <h3 style={{ margin: '4px 0 8px' }}>1 · Select an available offering</h3>
      {err.pick && <div className="notice error">{err.pick}</div>}
      {pools.map((o) => <Card key={o.id} o={o} />)}
      {available.map((o) => <Card key={o.id} o={o} />)}
      {pools.length + available.length === 0 && <div className="empty">No open offerings right now.</div>}
      <div style={{ textAlign: 'center', margin: '8px 0 14px' }}><button type="button" className="link-btn" data-testid="toggle-reserved" onClick={() => setShowReserved((v) => !v)}>👁 {showReserved ? 'Hide' : 'View'} {reserved.length} already reserved offering{reserved.length === 1 ? '' : 's'}</button></div>
      {showReserved && (
        <ul className="list" data-testid="reserved-list" style={{ marginBottom: 14 }}>
          {reserved.map((o) => (
            <li key={o.id}><span style={{ flex: 1 }}><b>{o.title}</b>{o.day ? <small className="muted"> · {o.day}</small> : null}<br /><small className="muted">Reserved by {o.reservedBy}{o.reservedUnit ? ` (${o.reservedUnit})` : ''} · {inr(o.pledgeValue)}</small></span>
              {(manager || (currentUser?.unit && o.reservedUnit === currentUser.unit)) && <button type="button" className="btn secondary sm" data-testid="release" onClick={() => release(o)}>Release</button>}</li>
          ))}
        </ul>
      )}

      {canPledge && open && (
        <>
          <h3 style={{ margin: '4px 0 8px' }}>2 · {profile ? 'Your details' : 'Devotee & family details'}</h3>
          <div className="card" style={{ marginBottom: 12 }}>
            {profile && (
              <div data-testid="pledge-as" style={{ marginBottom: 10 }}>Pledging as <b>{currentUser.name}</b> · <b>{currentUser.unit}</b>{currentUser.phone ? <> · {currentUser.phone}</> : null} <small className="muted">(from your profile)</small></div>
            )}
            <div className="form-grid">
              {!profile && <>
                <div className={`field${err.devotee ? ' invalid' : ''}`}><label>Devotee name *</label><input aria-label="Devotee name" placeholder="e.g. Ramesh Kumar" value={f.devotee} onChange={(e) => set('devotee', e.target.value)} />{err.devotee && <div className="field-error">{err.devotee}</div>}</div>
                <div className={`field${err.unit ? ' invalid' : ''}`}><label>Primary villa number *</label><input aria-label="Villa number" placeholder="e.g. Villa 124" value={f.unit} onChange={(e) => set('unit', e.target.value)} />{err.unit && <div className="field-error">{err.unit}</div>}</div>
              </>}
              {(!profile || !currentUser?.phone) && <div className={`field${err.phone ? ' invalid' : ''}`}><label>WhatsApp / mobile <small className="muted">(for updates)</small></label><PhoneInput value={f.phone} onChange={(v) => set('phone', v)} label="WhatsApp" invalid={!!err.phone} testid="offer-phone" />{err.phone && <div className="field-error">{err.phone}</div>}</div>}
              <div className="field"><label>Contributing family / group members <small className="muted">(optional)</small></label><input aria-label="Family members" placeholder="e.g. Sunita, Villa 125" value={f.members} onChange={(e) => set('members', e.target.value)} /></div>
              <div className="field" style={{ gridColumn: '1 / -1' }}><label>Special devotional notes / sankalpam <small className="muted">(optional)</small></label><input aria-label="Sankalpam" placeholder="e.g. In loving memory of parents / Family archana" value={f.sankalpam} onChange={(e) => set('sankalpam', e.target.value)} /></div>
            </div>
          </div>
          <div className="card" style={{ background: '#fffaf0' }} data-testid="pledge-review">
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><b>Review your seva details</b>{!pick && <span className="tag orange">Action required</span>}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}><span className="muted">Selected seva</span><b data-testid="review-title">{pick ? pick.title : 'Please choose an offering above'}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span className="muted">Festival day / schedule</span><b>{pick?.day || '–'}</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}><b>Pledge offering amount</b>
              {pick?.kind === 'Community pool'
                ? <span className={err.amount ? 'invalid' : ''}><input type="number" min="0" aria-label="Pool amount" style={{ width: 120, textAlign: 'right' }} value={f.amount} onChange={(e) => set('amount', e.target.value)} /></span>
                : <b style={{ fontSize: 22 }} data-testid="review-amount">{inr(amount)}</b>}</div>
            {err.amount && <div className="field-error">{err.amount}</div>}
            <button type="button" className="btn" style={{ width: '100%', marginTop: 10 }} disabled={busy} data-testid="confirm-pledge" onClick={confirm}>{busy ? 'Reserving…' : '✅ Confirm & pledge reservation'}</button>
          </div>
        </>
      )}
      {paying && (
        <PayPanel ev={ev} donation={paying} title="Complete your payment" onClose={() => setPaying(null)}
          onClaim={async (utr) => { const o = await claimPayment(paying, utr, saveDonation, ev, currentUser?.name || ''); if (o) setPaying(o); }}
          onPaid={() => setPaying(null)} />
      )}
    </div>
  );
}
