import React, { useEffect, useState } from 'react';
import { communityTaxId, todayLocal } from '../../lib/locale.js';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import { Segmented } from '../../components/ui.jsx';
import { quote, priceLabel, RESERVATION_MODES, RATE_UNITS, GST_MODES, DEFAULT_CANCELLATION, tiersOf, inr } from '../../lib/amenityEngine.js';
import { PriceLines } from './BookingDetail.jsx';
import AmenityItems from './AmenityItems.jsx';

const Need = ({ perm, children }) => <div className="notice" style={{ marginBottom: 8 }}>🔒 {children} — ask a Super Admin to grant <b>{perm}</b> to your role (Roles &amp; Permissions).</div>;

/** Rates, GST, deposit, cancellation rules and rules text. Each group is gated by its own permission (so any role can be trusted with it). */
export default function AmenityRates() {
  const { roleId, hasPermission, roles } = useApp();
  const overrideChoices = (roles || []).filter((r) => r.id !== 'super_admin' && ['EC', 'Staff', 'Facility', 'Admin'].some((c) => String(r.category || '').includes(c)) || /facility|amenit|president|secretary/.test(r.id)).map((r) => ({ id: r.id, name: r.name }));
  const { records: catalog, save, remove } = useCollection(COLLECTIONS.AMENITY_TYPES, 'Amenity Catalog');
  // how many bookings point at each amenity: the back end counts them on the amenity; in the browser demo they are counted here
  const serverCounts = catalog.some((a) => a.bookings !== undefined && a.bookings !== '');
  const { records: allBookings } = useCollection(COLLECTIONS.AMENITIES, 'Amenity Bookings', { enabled: !serverCounts });
  const { records: settingsRows, save: saveSettings } = useCollection(COLLECTIONS.AMENITY_SETTINGS, 'Amenity Settings');
  const { records: banks } = useCollection(COLLECTIONS.BANK_ACCOUNTS, 'Bank Accounts');
  const { records: facilities } = useCollection(COLLECTIONS.FACILITIES, 'Facilities & Locations');
  const admin = roleId === 'super_admin';
  const canRates = admin || hasPermission('MANAGE_AMENITY_RATES');
  const canRules = admin || hasPermission('MANAGE_AMENITY_RULES');
  const canOps = admin || hasPermission('MANAGE_AMENITIES');
  const settings = settingsRows[0] || {};

  const [name, setName] = useState('');
  const amenity = catalog.find((a) => a.name === name) || catalog[0];
  const [draft, setDraft] = useState(null);
  const [sd, setSd] = useState(null);
  const [saved, setSaved] = useState('');
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  useEffect(() => { if (amenity) setDraft({ ...amenity, cancellationRules: tiersOf(amenity) }); }, [amenity?.id, amenity?.recVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (settingsRows[0]) setSd({ ...settingsRows[0] }); }, [settingsRows[0]?.id, settingsRows[0]?.recVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!amenity || !draft || !sd) return <div className="empty">Loading…</div>;
  const todayIso = todayLocal();
  const use = serverCounts
    ? { all: Number(amenity.bookings) || 0, upcoming: Number(amenity.upcomingBookings) || 0 }
    : (() => { const mine = allBookings.filter((b) => b.amenity === amenity.name); return { all: mine.length, upcoming: mine.filter((b) => b.status !== 'Cancelled' && String(b.date) >= todayIso).length }; })();
  async function deleteAmenity() {
    if (!window.confirm(`Delete ${amenity.name}? It has never been booked, so nothing else changes.`)) return;
    try { if (await remove(amenity.id)) { setName(''); setSaved(`${amenity.name} deleted`); } } catch (e) { setSaved(''); window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: e?.message || String(e) } })); }
  }
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  const num = (v) => (v === '' ? '' : Number(v));
  const q = quote(draft, '2026-10-12', sd); // a weekday
  const qw = Number(draft.weekendRate) > 0 ? quote(draft, '2026-10-17', sd) : null;
  const tiers = draft.cancellationRules;
  const setTier = (i, k, v) => set('cancellationRules', tiers.map((t, j) => (j === i ? { ...t, [k]: num(v) } : t)));
  const tierErr = (() => {
    const hrs = tiers.map((t) => Number(t.hoursBefore));
    if (new Set(hrs).size !== hrs.length) return 'Each tier needs a different number of hours.';
    if (!hrs.includes(0)) return 'Add a final tier at 0 hours (less than the last notice period).';
    if (tiers.some((t) => Number(t.refundPct) < 0 || Number(t.refundPct) > 100)) return 'Refund % must be between 0 and 100.';
    return '';
  })();

  async function saveAmenity(keys, okMsg) {
    const patch = {};
    keys.forEach((k) => { patch[k] = draft[k]; });
    const next = { ...amenity, ...patch };
    if (keys.includes('rate')) next.price = priceLabel(next);
    if (keys.includes('cancellationRules')) next.cancellationRules = [...tiers].sort((a, b) => b.hoursBefore - a.hoursBefore);
    const out = await save(next);
    if (out?.name) setName(out.name);   // a rename: keep this amenity open under its new name
    setSaved(out ? okMsg : '');
  }
  const saveRates = () => saveAmenity(['rateUnit', 'rate', 'weekendRate', 'gstApplicable', 'gstRate', 'gstMode', 'depositAmount', 'minNoticeHours', 'maxAdvanceDays', 'cancellationRules'].filter((k) => k !== 'cancellationRules' || !tierErr), 'Rates saved');
  async function saveSet() { const out = await saveSettings({ ...settingsRows[0], defaultGstRate: Number(sd.defaultGstRate) || 0, receiptAccount: sd.receiptAccount, refundMode: sd.refundMode, paymentDueHours: Number(sd.paymentDueHours) || 0 }); setSaved(out ? 'Settings saved' : ''); }
  async function addAmenity() {
    if (!newName.trim()) return;
    const out = await save({ name: newName.trim(), icon: '⭐', active: true, rate: 0, rateUnit: 'Free', gstApplicable: false, gstRate: sd.defaultGstRate || 18, gstMode: 'Exclusive', depositAmount: 0, minNoticeHours: 2, maxAdvanceDays: 90, cancellationRules: DEFAULT_CANCELLATION, capacity: 1, hours: '06:00–22:00', bookingMode: 'Time slot', rules: '', price: 'Free for residents' });
    if (out) { setName(out.name); setAdding(false); setNewName(''); }
  }

  return (
    <div>
      {saved && <div className="notice" data-testid="rates-saved">✔ {saved}</div>}

      <AmenityItems />

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Tax &amp; payment settings</h3>
        {!canRates && !canOps && <Need perm="MANAGE_AMENITY_RATES">You can view but not change these</Need>}
        <div className="form-grid">
          <div className="field"><label>{`Tax number (${'GSTIN'})`}</label><div className="ro-value" data-testid="amenity-taxid">{communityTaxId() || 'Not set - the community is not registered, or add it in Community setup'}<br /><small className="muted">Printed on receipts and reports. Change it once, in Community setup → Community details.</small></div></div>
          <div className="field"><label>Default GST rate (%)</label><input type="number" min="0" max="40" value={sd.defaultGstRate ?? ''} disabled={!(canRates || canOps)} onChange={(e) => setSd({ ...sd, defaultGstRate: e.target.value })} /></div>
          <div className="field"><label>Receipts are recorded in account</label>
            <select value={sd.receiptAccount || ''} disabled={!(canRates || canOps)} onChange={(e) => setSd({ ...sd, receiptAccount: e.target.value })}>
              <option value="">First bank account</option>
              {banks.map((b) => <option key={b.id}>{b.name}</option>)}
            </select></div>
          <div className="field"><label>Refunds are returned as</label>
            <select value={sd.refundMode || 'Credit to unit account'} disabled={!(canRates || canOps)} onChange={(e) => setSd({ ...sd, refundMode: e.target.value })}>
              <option>Credit to unit account</option><option>Original payment mode (manual)</option>
            </select></div>
          <div className="field"><label>Release unpaid (cash / cheque) bookings after (hours, 0 = never)</label><input type="number" min="0" value={sd.paymentDueHours ?? 0} disabled={!(canRates || canOps)} onChange={(e) => setSd({ ...sd, paymentDueHours: e.target.value })} /></div>
        </div>
        <div className="muted" style={{ fontSize: 12, margin: '6px 0' }}>Whether GST applies to an amenity (and at what rate) depends on your association's turnover and the member charges involved — confirm with your auditor, then set it per amenity below.</div>
        <button className="btn secondary" disabled={!(canRates || canOps)} onClick={saveSet} data-testid="save-settings">Save settings</button>
      </div>

      <div className="chip-row" style={{ marginTop: 14 }}>
        {catalog.map((a) => <button key={a.id} className={`chip-btn${a.id === amenity.id ? ' on' : ''}`} onClick={() => { setName(a.name); setSaved(''); }}>{a.icon} {a.name}</button>)}
        {canRates && canOps && <button className="chip-btn" onClick={() => setAdding((v) => !v)}>＋ Add amenity</button>}
      </div>
      {adding && (
        <div className="assign"><div className="field"><label>New amenity name</label><input value={newName} onChange={(e) => setNewName(e.target.value)} /></div><button className="btn" onClick={addAmenity}>Create</button></div>
      )}

      <div className="card" style={{ marginTop: 12 }} data-testid="rates-card">
        <h3 style={{ marginTop: 0 }}>{amenity.icon} {amenity.name} · rates</h3>
        {!canRates && <Need perm="MANAGE_AMENITY_RATES">Rates, GST, deposit and cancellation rules are read-only for you</Need>}
        <div className="form-grid">
          <div className="field"><label>Charged</label>
            <Segmented label="Rate unit" value={draft.rateUnit || 'Free'} onChange={(v) => canRates && set('rateUnit', v)} options={RATE_UNITS} />
          </div>
          {draft.rateUnit !== 'Free' && <div className="field"><label>Rate (₹) {draft.gstApplicable ? (draft.gstMode === 'Inclusive' ? '— GST included' : '— before GST') : ''}</label><input type="number" min="0" aria-label="Rate" value={draft.rate ?? ''} disabled={!canRates} onChange={(e) => set('rate', num(e.target.value))} /></div>}
          {draft.rateUnit !== 'Free' && <div className="field"><label>Weekend rate (₹, optional)</label><input type="number" min="0" aria-label="Weekend rate" value={draft.weekendRate || ''} disabled={!canRates} onChange={(e) => set('weekendRate', num(e.target.value))} /></div>}
          <div className="field"><label className="check"><input type="checkbox" aria-label="GST applicable" checked={!!draft.gstApplicable} disabled={!canRates || draft.rateUnit === 'Free'} onChange={(e) => set('gstApplicable', e.target.checked)} /> GST applicable</label></div>
          {draft.gstApplicable && draft.rateUnit !== 'Free' && (
            <>
              <div className="field"><label>GST rate (%)</label><input type="number" min="0" max="40" aria-label="GST rate" value={draft.gstRate ?? ''} disabled={!canRates} onChange={(e) => set('gstRate', num(e.target.value))} /></div>
              <div className="field"><label>The rate above is</label><Segmented label="GST mode" value={draft.gstMode || 'Exclusive'} onChange={(v) => canRates && set('gstMode', v)} options={[{ value: 'Exclusive', label: 'before GST' }, { value: 'Inclusive', label: 'GST included' }]} /></div>
            </>
          )}
          <div className="field"><label>Refundable security deposit (₹)</label><input type="number" min="0" aria-label="Security deposit" value={draft.depositAmount || ''} disabled={!canRates} onChange={(e) => set('depositAmount', num(e.target.value))} /></div>
          <div className="field"><label>Minimum notice to book (hours)</label><input type="number" min="0" value={draft.minNoticeHours ?? ''} disabled={!canRates} onChange={(e) => set('minNoticeHours', num(e.target.value))} /></div>
          <div className="field"><label>Bookable up to (days ahead)</label><input type="number" min="0" value={draft.maxAdvanceDays ?? ''} disabled={!canRates} onChange={(e) => set('maxAdvanceDays', num(e.target.value))} /></div>
        </div>

        <h4 className="bk-h">Booking rules</h4>
        <div className="form-grid" data-testid="booking-rules">
          <div className="field"><label>Reservation</label><Segmented label="Reservation" value={draft.reservation || 'Reservation required'} onChange={(v) => set('reservation', v)} options={RESERVATION_MODES} /><small className="muted">Walk-in amenities are listed as "no reservation needed" and cannot be booked. "Items only" hires out chairs, tables, linen and the like with no space held: any number of units can book the same day until the stock runs out.</small></div>
          <div className="field"><label>Most bookings one unit may hold on a day</label><input type="number" min="0" data-testid="rule-per-day" value={draft.maxPerDay ?? ''} onChange={(e) => set('maxPerDay', num(e.target.value))} /></div>
          <div className="field"><label>Most bookings one unit may make in a month</label><input type="number" min="0" data-testid="rule-per-month" value={draft.maxPerMonth ?? ''} onChange={(e) => set('maxPerMonth', num(e.target.value))} /></div>
          <div className="field"><label>Most upcoming bookings one unit may hold</label><input type="number" min="0" data-testid="rule-upcoming" value={draft.maxUpcoming ?? ''} onChange={(e) => set('maxUpcoming', num(e.target.value))} /></div>
          <div className="field"><label>Open to (blank = every unit type)</label><div className="chip-row">{['Villa', 'Apartment'].map((t) => <button key={t} type="button" className={`chip-btn${(draft.allowedUnitTypes || []).includes(t) ? ' on' : ''}`} onClick={() => set('allowedUnitTypes', (draft.allowedUnitTypes || []).includes(t) ? draft.allowedUnitTypes.filter((x) => x !== t) : [...(draft.allowedUnitTypes || []), t])}>{t}</button>)}</div></div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Closed dates</label>
            <div className="chip-row">{(draft.blackoutDates || []).map((d) => <button key={d} type="button" className="chip-btn on" title="Remove" onClick={() => set('blackoutDates', draft.blackoutDates.filter((x) => x !== d))}>{d} ✕</button>)}
              <input type="date" aria-label="Add closed date" data-testid="rule-blackout" style={{ width: 'auto' }} value="" onChange={(e) => e.target.value && !(draft.blackoutDates || []).includes(e.target.value) && set('blackoutDates', [...(draft.blackoutDates || []), e.target.value].sort())} /></div>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}><label>Who may reserve at any time, however far ahead, at short notice or over the limits</label>
            <div className="chip-row">{overrideChoices.map((r) => <button key={r.id} type="button" data-testid={`override-${r.id}`} className={`chip-btn${(draft.overrideRoles || []).includes(r.id) ? ' on' : ''}`} onClick={() => set('overrideRoles', (draft.overrideRoles || []).includes(r.id) ? draft.overrideRoles.filter((x) => x !== r.id) : [...(draft.overrideRoles || []), r.id])}>{r.name}</button>)}</div>
            <small className="muted">Super Admin can always do this. If none is picked, the whole amenities team can. Residents always follow the notice, days-ahead and limits above.</small>
          </div>
          <div className="form-actions"><button type="button" className="btn" data-testid="rules-save" onClick={() => saveAmenity(['reservation', 'maxPerDay', 'maxPerMonth', 'maxUpcoming', 'allowedUnitTypes', 'blackoutDates', 'overrideRoles'], 'Booking rules saved')}>Save booking rules</button></div>
        </div>

        <h4 className="bk-h">What the resident will see</h4>
        <div className="cols-2">
          <div><small className="muted">Weekday</small><PriceLines q={q} gstin={communityTaxId()} /></div>
          {qw && <div><small className="muted">Weekend</small><PriceLines q={qw} gstin={communityTaxId()} /></div>}
        </div>

        <h4 className="bk-h">Cancellation rules</h4>
        <p className="muted" style={{ marginTop: -4 }}>The fee refund depends on how long before the start the booking is cancelled. The security deposit is always returned in full.</p>
        <table className="tier-table"><thead><tr><th>Cancelled at least (hours before)</th><th>Refund of fee (%)</th><th /></tr></thead>
          <tbody>
            {tiers.map((t, i) => (
              <tr key={i}>
                <td><input type="number" min="0" aria-label={`Tier ${i + 1} hours`} value={t.hoursBefore} disabled={!canRates} onChange={(e) => setTier(i, 'hoursBefore', e.target.value)} /></td>
                <td><input type="number" min="0" max="100" aria-label={`Tier ${i + 1} refund`} value={t.refundPct} disabled={!canRates} onChange={(e) => setTier(i, 'refundPct', e.target.value)} /></td>
                <td>{canRates && tiers.length > 1 && <button type="button" className="btn secondary sm" onClick={() => set('cancellationRules', tiers.filter((_, j) => j !== i))}>Remove</button>}</td>
              </tr>
            ))}
          </tbody></table>
        {canRates && <button type="button" className="btn secondary sm" onClick={() => set('cancellationRules', [...tiers, { hoursBefore: 12, refundPct: 25 }])}>＋ Add tier</button>}
        {tierErr && <div className="notice error" style={{ marginTop: 8 }}>{tierErr}</div>}
        <div style={{ marginTop: 12 }}><button className="btn" disabled={!canRates || !!tierErr} onClick={saveRates} data-testid="save-rates">Save rates &amp; cancellation rules</button></div>
        <small className="muted" style={{ display: 'block', marginTop: 6 }}>Changes apply to NEW bookings. Existing bookings keep the rates and cancellation rules they were booked under ({draft.rateUnit === 'Free' ? 'free' : priceLabel(draft)} now).</small>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Booking setup</h3>
        {!canOps && <Need perm="MANAGE_AMENITIES">Read-only for you</Need>}
        <div className="form-grid">
          <div className="field"><label>Name</label><input aria-label="Amenity name" data-testid="amenity-name" value={draft.name || ''} disabled={!canOps} onChange={(e) => set('name', e.target.value)} />
            {draft.name !== amenity.name && <small className="muted">Its {use.all} booking{use.all === 1 ? '' : 's'} and add-on items move to the new name.</small>}</div>
          <div className="field"><label>Icon</label><input aria-label="Amenity icon" data-testid="amenity-icon" value={draft.icon || ''} maxLength={8} disabled={!canOps} onChange={(e) => set('icon', e.target.value)} /></div>
          <div className="field"><label className="check"><input type="checkbox" data-testid="amenity-open" checked={draft.active !== false} disabled={!canOps} onChange={(e) => set('active', e.target.checked)} /> Open for booking</label>
            {draft.active === false && <small className="muted" data-testid="amenity-closed-note">Closed: nobody can make a new booking. {use.upcoming ? `The ${use.upcoming} upcoming booking${use.upcoming === 1 ? ' stays' : 's stay'} as booked; cancel any that cannot go ahead from the bookings list (each is refunded by its cancellation rules, or waive the fee).` : 'There are no upcoming bookings.'}</small>}</div>
          <div className="field"><label>Booking mode</label><select value={draft.bookingMode || 'Time slot'} disabled={!canOps} onChange={(e) => set('bookingMode', e.target.value)}><option>Time slot</option><option>Full day</option></select></div>
          <div className="field"><label>Capacity per slot</label><input type="number" min="1" value={draft.capacity ?? 1} disabled={!canOps} onChange={(e) => set('capacity', num(e.target.value))} /></div>
          <div className="field"><label>Located at</label><select aria-label="Located at" data-testid="amenity-facility" value={draft.facility || ''} disabled={!canOps} onChange={(e) => set('facility', e.target.value)}><option value="">— whole community —</option>{facilities.filter((f) => f.active !== false).map((f) => <option key={f.id}>{f.name}</option>)}</select></div>
          <div className="field"><label>Opening hours</label><input value={draft.hours || ''} disabled={!canOps} onChange={(e) => set('hours', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn secondary" data-testid="amenity-setup-save" disabled={!canOps || !String(draft.name || '').trim()} onClick={() => saveAmenity(['name', 'icon', 'active', 'bookingMode', 'capacity', 'hours', 'facility'], 'Booking setup saved')}>Save booking setup</button>
          {canOps && (use.all === 0
            ? <button className="btn secondary danger" data-testid="amenity-delete" onClick={deleteAmenity}>Delete amenity</button>
            : <small className="muted" data-testid="amenity-keep">{use.all} booking{use.all === 1 ? '' : 's'} so far{use.upcoming ? `, ${use.upcoming} upcoming` : ''}: it cannot be deleted (its history is kept). Untick “Open for booking” to close it.</small>)}
        </div>
      </div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Rules &amp; regulations</h3>
        {!canRules && <Need perm="MANAGE_AMENITY_RULES">Read-only for you</Need>}
        <RichTextEditor value={draft.rules || ''} onChange={(h) => canRules && set('rules', h)} placeholder="Write the rules for this amenity — use bullets for each rule…" minHeight={110} />
        <div style={{ marginTop: 8 }}><button className="btn secondary" disabled={!canRules} onClick={() => saveAmenity(['rules'], 'Rules saved')}>Save rules</button></div>
      </div>
    </div>
  );
}
