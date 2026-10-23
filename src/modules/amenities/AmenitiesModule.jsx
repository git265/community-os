import { takeHint } from '../../lib/openHint.js';
import { communityTaxId } from '../../lib/locale.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import RichText from '../../components/RichText.jsx';
import CustomFields from '../../components/CustomFields.jsx';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';
import { SegTabs } from '../../components/ui.jsx';
import Combobox from '../../components/Combobox.jsx';
import { quote, priceExtras, itemsFor, itemLeft, parseExtras, priceLabel, bookingWindowError, bookingRulesError, canOverrideRules, isWalkIn, isItemsOnly, inr, creditBalance, ONLINE_MODES, OFFICE_MODES } from '../../lib/amenityEngine.js';
import { defaultOnlineMode } from '../../lib/region/paymentModes.js';
import BookingsTable from './BookingsTable.jsx';
import BookingDetail, { PriceLines, PolicyList } from './BookingDetail.jsx';
import AmenityPayments from './AmenityPayments.jsx';
import AmenityRates from './AmenityRates.jsx';
import AmenityNotifications from './AmenityNotifications.jsx';
import { useGatewayPay, PaymentResult } from '../../components/GatewayCheckout.jsx';

import { AMENITY_SLOTS as SLOTS } from '../../lib/lists/configLists.js'; // live list: edited in Community setup -> Lists
const PAGE = 10;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const todayStr = () => { const n = new Date(); return fmt(n.getFullYear(), n.getMonth(), n.getDate()); };

function monthCells(year, month) {
  const cells = [];
  const first = new Date(year, month, 1).getDay();
  for (let i = 0; i < first; i++) cells.push(null);
  const count = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= count; d++) cells.push(d);
  return cells;
}

export default function AmenitiesModule() {
  const { role, roleId, currentUser, hasPermission, tabAllowed } = useApp();
  const { records: catalog } = useCollection(COLLECTIONS.AMENITY_TYPES, 'Amenity Catalog');
  const { records: bookings, save: saveBooking } = useCollection(COLLECTIONS.AMENITIES, 'Amenities');
  const { records: settingsRows } = useCollection(COLLECTIONS.AMENITY_SETTINGS, 'Amenity Settings');
  const { records: credits } = useCollection(COLLECTIONS.UNIT_CREDITS, 'Unit Credits');
  const { records: allItems } = useCollection(COLLECTIONS.AMENITY_ITEMS, 'Amenity add-on items');
  const { records: properties } = useCollection(COLLECTIONS.PROPERTIES, 'Properties');
  const { roles: appRoles = [] } = useApp();
  const subcommittees = useMemo(() => appRoles.filter((r) => r.id.startsWith('committee_')).map((r) => ({ name: r.name.replace(/ Committee$/, '') })), [appRoles]);
  const settings = settingsRows[0] || {};

  const isResident = role?.category === 'Resident';
  const isStaff = !isResident && (hasPermission('MANAGE_AMENITIES') || role?.category === 'EC' || roleId === 'super_admin');
  const myUnit = currentUser?.unit || '';

  const [tab, setTab] = useState(() => takeHint(['book', 'payments', 'rates', 'notifications', 'reports']) || 'book');
  const now = new Date();
  const [view, setView] = useState({ y: now.getFullYear(), m: now.getMonth() });
  const [selected, setSelected] = useState(null);
  const [pickedDate, setPickedDate] = useState(null);
  const [slot, setSlot] = useState('');
  const [unit, setUnit] = useState(() => currentUser?.unit || '');   // a committee member who owns a unit books for it by default
  const [forWho, setForWho] = useState('Unit'); // staff: book for a unit or for an association
  const [assoc, setAssoc] = useState('');
  const [free, setFree] = useState(false);
  const [freeWhy, setFreeWhy] = useState('');
  const [paymentMode, setPaymentMode] = useState(() => defaultOnlineMode());
  const [useCredit, setUseCredit] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState('');
  const [fe, setFe] = useState({});
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState(null);
  const [deepNo, setDeepNo] = useState(() => { try { const v = sessionStorage.getItem('communityos:openBooking'); sessionStorage.removeItem('communityos:openBooking'); return v; } catch { return null; } });
  const [receipt, setReceipt] = useState(null);
  const [picks, setPicks] = useState({}); // add-on items: { itemId: quantity }
  const [custom, setCustom] = useState({}); // custom attributes the Super Admin added to bookings (Studio)
  const [busy, setBusy] = useState(false);
  const gw = useGatewayPay();
  const [payAttempt, setPayAttempt] = useState(null);
  const [facFilter, setFacFilter] = useState(''); // a community with several clubhouses / pools: narrow the amenity list to one place

  const today = todayStr();
  const openCatalog = catalog.filter((a) => a.active !== false && !isWalkIn(a));
  const facilityNames = [...new Set(openCatalog.map((a) => a.facility).filter(Boolean))].sort();
  const amenity = catalog.find((a) => a.name === selected);
  const dayBased = amenity?.bookingMode === 'Full day';
  const capacity = amenity?.capacity || 1;
  const active = (b) => b.status !== 'Cancelled';
  const isAssoc = isStaff && forWho === 'Association';
  const bookUnit = isResident ? myUnit : isAssoc ? (assoc.trim() ? `Association · ${assoc.trim()}` : '') : unit.trim();
  const slotKey = dayBased ? 'Full day' : slot;
  const offered = amenity ? itemsFor(allItems, amenity.name) : [];
  const ex = useMemo(() => (pickedDate && slotKey ? priceExtras(picks, allItems, bookings, amenity?.name, pickedDate, slotKey) : { lines: [], total: 0 }), [picks, allItems, bookings, amenity?.name, pickedDate, slotKey]);
  const rawQ = amenity && pickedDate ? quote(amenity, pickedDate, settings, ex.error ? 0 : ex.total) : null;
  const waivedNow = isStaff && free && !!rawQ && rawQ.total > 0;
  const q = waivedNow ? { ...rawQ, free: true, rate: 0, base: 0, gst: 0, gstRate: 0, fee: 0, deposit: 0, total: 0, halves: 0 } : rawQ;
  const unitOptions = useMemo(() => [...properties].sort((a, b) => String(a.unit).localeCompare(String(b.unit), undefined, { numeric: true })).map((x) => ({ value: x.unit, label: x.unit, hint: x.owner })), [properties]);
  const assocOptions = useMemo(() => [...new Set([...subcommittees.map((c) => c.name), ...bookings.map((b) => b.association)].filter(Boolean))].map((n) => ({ value: n, label: n })), [subcommittees, bookings]);
  const balance = bookUnit ? creditBalance(credits, bookUnit) : 0;
  const canUseCredit = !!q && q.total > 0 && balance >= 0.01;
  const creditCover = canUseCredit && useCredit ? Math.min(balance, q.total) : 0; // credit can pay all of a booking or just part of it
  const fullCredit = creditCover > 0 && creditCover >= q.total;
  const toPay = q ? Math.max(0, Math.round((q.total - creditCover) * 100) / 100) : 0;
  const detail = bookings.find((b) => b.id === detailId) || null;
  useEffect(() => { if (deepNo && bookings.length) { const b = bookings.find((x) => x.shortId === deepNo); if (b) setDetailId(b.id); setDeepNo(null); } }, [deepNo, bookings]);

  // Residents never see other villas' bookings.
  const visibleBookings = useMemo(() => (isResident ? bookings.filter((b) => b.unit === myUnit) : bookings), [bookings, isResident, myUnit]);

  const listed = useMemo(() => {
    let list = [...visibleBookings].sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.recordCreatedAt).localeCompare(String(a.recordCreatedAt)));
    if (query) {
      const s = query.toLowerCase();
      list = list.filter((b) => `${b.amenity} ${b.unit} ${b.date} ${b.status} ${b.shortId} ${b.paymentStatus}`.toLowerCase().includes(s));
    }
    return list;
  }, [visibleBookings, query]);
  const pages = Math.max(1, Math.ceil(listed.length / PAGE));
  const pageRows = listed.slice(0, Math.min(page, pages) * PAGE);
  const moreRef = useRef(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || typeof IntersectionObserver === 'undefined' || page >= pages) return undefined;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) setPage((n) => n + 1); }, { rootMargin: '200px' });
    io.observe(el);
    return () => io.disconnect();
  }, [page, pages, pageRows.length]);

  // Availability is computed from ALL bookings (so a day shows as full) without exposing who booked it.
  // An items-only amenity (chairs, tables, linen hired on their own) holds no space: it is full only when every item is gone for that day or slot.
  const itemsOnly = isItemsOnly(amenity);
  const takenOn = (date, s) => bookings.filter((b) => active(b) && b.amenity === selected && b.date === date && (s ? b.slot === s : true)).length;
  const slotFull = (date, s) => (itemsOnly ? offered.every((it) => itemLeft(it, bookings, date, s || 'Full day') <= 0) : (s ? takenOn(date, s) : takenOn(date)) >= capacity);
  const dayFull = (date) => (dayBased ? slotFull(date) : SLOTS.every((s) => slotFull(date, s)));

  function pickAmenity(name) {
    setSelected(name); setPickedDate(null); setSlot(''); setAcknowledged(false); setError(''); setFe({}); setReceipt(null); setUseCredit(false); setPicks({});
  }
  function shiftMonth(delta) {
    setView((v) => { const d = new Date(v.y, v.m + delta, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  }

  const payNow = ONLINE_MODES.includes(paymentMode) && !fullCredit;
  const atOffice = OFFICE_MODES.includes(paymentMode) && !fullCredit && !isStaff;

  async function confirmBooking() {
    const er = {};
    if (!bookUnit) er.unit = isAssoc ? 'Association name is required' : 'Unit is required';
    if (waivedNow && !freeWhy.trim()) er.free = 'Give a reason for waiving the charges';
    if (!dayBased && !slot) er.slot = 'Choose a time slot';
    if (!acknowledged) er.ack = 'Please acknowledge the rules and the cancellation policy';
    setFe(er);
    if (Object.keys(er).length) return;
    const bypass = canOverrideRules(amenity, roleId, isStaff);
    const w = !bypass && (bookingWindowError(amenity, pickedDate, dayBased ? 'Full day' : slot) || bookingRulesError(amenity, { date: pickedDate, unit: bookUnit, unitType: properties.find((x) => x.unit === bookUnit)?.type || '', bookings }));
    if (w) return setError(w);
    if (!itemsOnly && (dayBased ? takenOn(pickedDate) >= capacity : takenOn(pickedDate, slot) >= capacity)) return setError('That booking is no longer available.');
    if (ex.error) return setError(ex.error);
    if (itemsOnly && !ex.lines.length) return setError(`Choose how many of each item you need from ${amenity.name}`);
    setBusy(true);
    try {
      // an online payment always goes through the payment gateway (the simulator in this demo) - an owner's own booking or the office
      // taking a card / UPI payment for a villa - and the booking is saved with its payment id
      if (payNow && toPay > 0 && !waivedNow) {
        setPayAttempt(null);
        const res = await gw.start({ purpose: 'booking', refs: [], amount: toPay, unit: bookUnit, payer: currentUser?.name || '', description: `${selected} · ${pickedDate}` });
        if (res.status !== 'Paid') { setBusy(false); setPayAttempt(res); return; }
        return await saveBookingPaid(res);
      }
      return await saveBookingPaid(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  /**
   * Save the booking - with the payment it was paid by (`res`, a Paid result), or none (office / credit / free). Also what "Done" does after
   * a slow bank confirmed the payment: the money is in, so the booking is made with it - the payment is never started a second time.
   */
  async function saveBookingPaid(res) {
    setBusy(true);
    try {
      const gwRef = res ? (res.utr ? `UTR ${res.utr}${res.payerVpa ? ` · ${res.payerVpa}` : ''}` : res.paymentId || '') : '';   // UPI: the bank's UTR (browser demo); the back end keeps its own payment id
      const gwMode = res ? (res.order?.method || paymentMode) : paymentMode;
      if (res && !gwRef) { setError('The payment is confirmed but its reference has not reached this screen yet. Your booking is not lost - the money is kept as your unit\'s credit; open Billing to see it, or ask the office.'); return; }
      const saved = await saveBooking({ ...custom, ...(ex.lines.length ? { extras: JSON.stringify(Object.fromEntries(ex.lines.map((l) => [l.itemId, l.qty]))) } : {}), amenity: selected, unit: bookUnit, date: pickedDate, slot: dayBased ? 'Full day' : slot, paymentMode: gwMode, ...(gwRef ? { paymentRef: gwRef } : {}), useCredit: creditCover > 0 && !waivedNow, ...(isAssoc ? { bookedFor: 'Association', association: assoc.trim() } : {}), ...(waivedNow ? { freeOfCharge: true, waiveReason: freeWhy.trim() } : {}) });
      setBusy(false);
      if (!saved) return; // a rule said no: the toast shows why
      setReceipt(saved);
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); document.querySelector('.content')?.scrollIntoView({ block: 'start' }); document.querySelector('.main')?.scrollTo?.({ top: 0 }); } catch { /* ignore */ }
      setPickedDate(null); setSlot(''); setUnit(currentUser?.unit || ''); setAssoc(''); setFree(false); setFreeWhy(''); setForWho('Unit'); setAcknowledged(false); setError(''); setFe({}); setUseCredit(false); setCustom({}); setPicks({});
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  async function onAction(record) {
    return !!(await saveBooking(record));
  }

  const cells = monthCells(view.y, view.m);
  const monthLabel = new Date(view.y, view.m, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const canPeek = !isResident;
  const tabs = [
    { key: 'book', label: isResident ? 'Book & my bookings' : 'Bookings' },
    { key: 'payments', label: 'Payments', hidden: !isStaff || !tabAllowed('amenities.payments') },
    { key: 'rates', label: 'Rates & rules', hidden: !canPeek || !tabAllowed('amenities.rates') },
    { key: 'notifications', label: 'Notifications', hidden: !canPeek || !tabAllowed('amenities.notifications') },
    { key: 'reports', label: 'Reports', hidden: !canPeek || !tabAllowed('amenities.reports') },
  ];
  const cta = !q ? '' : q.total <= 0 ? 'Confirm booking' : fullCredit ? `Pay ${inr(q.total)} from unit credit` : atOffice ? `Reserve · pay ${inr(toPay)} at the office` : payNow ? `Pay ${inr(toPay)} & confirm` : `Confirm booking · ${inr(toPay)} received`;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Amenity reservations</h1>
          <p>{isResident ? 'Book an amenity, see what it costs and what a cancellation refunds.' : 'Bookings, payments, rates, GST, deposits, notifications and reports.'}</p>
        </div>
        {isResident && balance > 0 && <span className="tag green credit-chip" data-testid="credit-chip">Unit credit {inr(creditBalance(credits, myUnit))}</span>}
      </div>

      {canPeek && <SegTabs tabs={tabs} value={tab} onChange={setTab} label="Amenity sections" />}

      {tab === 'payments' && isStaff && <AmenityPayments bookings={bookings} credits={credits} settings={settings} catalog={catalog} onOpen={setDetailId} today={today} />}
      {tab === 'rates' && canPeek && <AmenityRates />}
      {tab === 'notifications' && canPeek && <AmenityNotifications mode="notifications" />}
      {tab === 'reports' && canPeek && <AmenityNotifications mode="reports" />}

      {tab === 'book' && (
        <>
          {receipt && (
            <div className="card receipt" data-testid="receipt">
              <b>{receipt.status === 'Pending payment' ? '⏳ Reserved — pay at the office to confirm' : '✅ Booking confirmed'} · {receipt.shortId}</b>
              <div className="muted">{receipt.amenity} · {receipt.date} · {receipt.slot} · {receipt.unit}</div>
              <PriceLines q={{ free: !(receipt.rate > 0), rate: receipt.rate, addOn: receipt.extrasTotal || 0, rateUnit: receipt.rateUnit || 'Per day / event', gstRate: receipt.gstRate, gstMode: receipt.gstMode, halves: (receipt.gstAmount || 0) / 2, base: receipt.baseAmount, gst: receipt.gstAmount, fee: receipt.feeTotal, deposit: receipt.depositAmount, total: receipt.totalPayable }} gstin={communityTaxId()} extras={parseExtras(receipt.extras)} />
              <small className="muted">A summary has been queued for the owner and the admin recipients (see Notifications → Outbox).</small>
              <div><button className="btn secondary" onClick={() => setReceipt(null)}>Done</button></div>
            </div>
          )}

          <h2 className="amen-book-h" style={{ margin: '0 0 8px' }} data-testid="book-heading">Book an amenity</h2>
          {isResident && creditBalance(credits, myUnit) >= 0.01 && (
            <div className="notice" data-testid="credit-banner">💳 Your villa has <b>{inr(creditBalance(credits, myUnit))}</b> of unit credit (from a refund). Choose “Use unit credit” when you pay for your next booking — it can cover all of it or just part.</div>
          )}
          {facilityNames.length > 1 && (
            <div className="field" style={{ maxWidth: 320, marginBottom: 8 }}>
              <label>Where</label>
              <select aria-label="Facility filter" data-testid="facility-filter" value={facFilter} onChange={(e) => setFacFilter(e.target.value)}><option value="">All locations</option>{facilityNames.map((f) => <option key={f}>{f}</option>)}</select>
            </div>
          )}
          <div className="chip-row amen-picks" data-testid="amen-picks">
            {openCatalog.filter((a) => !facFilter || a.facility === facFilter).map((a) => (
              <button key={a.id} className={`chip-btn${selected === a.name ? ' on' : ''}`} onClick={() => pickAmenity(a.name)}>
                {a.icon} {a.name}{a.facility && !facFilter && facilityNames.length > 1 && !a.name.includes(a.facility) ? <small className="muted"> · {a.facility}</small> : null}
              </button>
            ))}
          </div>

          {amenity && (
            <div className="card" style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <h3 style={{ margin: 0 }}>{amenity.icon} {amenity.name}</h3>
                <span className="muted" data-testid="price-label">{priceLabel(amenity)}{Number(amenity.depositAmount) > 0 ? ` · ${inr(amenity.depositAmount)} refundable deposit` : ''} · {amenity.hours}{capacity > 1 ? ` · capacity ${capacity}` : ''}</span>
              </div>

              <div className="rules-box" style={{ marginTop: 12 }}>
                <label>Rules &amp; regulations</label>
                {isEmptyHtml(amenity.rules) ? <p style={{ margin: '4px 0' }}>No specific rules.</p> : <RichText html={amenity.rules} />}
                {canPeek && <small className="muted">Rates, GST, deposit and rules are edited under Rates &amp; rules.</small>}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '12px 0 8px' }}>
                <button className="btn secondary" onClick={() => shiftMonth(-1)}>‹</button>
                <b>{monthLabel}</b>
                <button className="btn secondary" onClick={() => shiftMonth(1)}>›</button>
              </div>
              <div className="calendar-grid">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <div key={i} className="muted" style={{ textAlign: 'center', fontSize: 11 }}>{d}</div>)}
                {cells.map((d, i) => {
                  if (!d) return <div key={i} className="calendar-day empty" />;
                  const ds = fmt(view.y, view.m, d);
                  const past = ds < today;
                  const full = dayFull(ds);
                  const cls = full ? 'booked' : past ? 'past' : ds === pickedDate ? 'picked' : '';
                  return (
                    <div key={i} className={`calendar-day ${cls}`} title={full ? 'Fully booked' : ''}
                      onClick={() => { if (!full && !past) { setPickedDate(ds); setSlot(''); setError(''); setFe({}); setReceipt(null); } }}>
                      {d}
                    </div>
                  );
                })}
              </div>
              <p className="muted" style={{ fontSize: 12 }}>Greyed-out days are {dayBased ? 'already booked' : 'fully booked'} or in the past.</p>

              {pickedDate && (
                <div className="assign">
                  <b>{amenity.name} · {pickedDate}</b>
                  {!dayBased && <div className={`field${fe.slot ? ' invalid' : ''}`} style={{ marginTop: 10 }}><label>Time slot *</label></div>}
                  {!dayBased && (
                    <div className="grid slot-grid">
                      {SLOTS.map((s) => {
                        const n = takenOn(pickedDate, s);
                        const full = slotFull(pickedDate, s);
                        return (
                          <div key={s} className={`person slot-cell ${full ? 'booked' : slot === s ? 'picked' : 'free'}`} onClick={() => { if (!full) { setSlot(s); setFe((f) => ({ ...f, slot: undefined })); } }}>
                            <b>{s.split('–')[0]}</b><br />
                            <small className={`tag ${full ? 'red' : ''}`}>{itemsOnly ? (full ? 'Sold out' : 'Open') : capacity > 1 ? `${n}/${capacity}` : full ? 'Booked' : 'Free'}</small>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {fe.slot && <div className="field invalid"><div className="field-error">{fe.slot}</div></div>}

                  {isResident ? null : (
                    <div style={{ marginTop: 12 }}>
                      <div className="field"><label>Booked for</label>
                        <div className="chips" role="group" aria-label="Booked for">{['Unit', 'Association'].map((k) => <button key={k} type="button" data-testid={`for-${k}`} aria-pressed={forWho === k} className={`chip${forWho === k ? ' on' : ''}`} onClick={() => { setForWho(k); setFree(k === 'Association'); setFe({}); }}>{k === 'Unit' ? 'A villa / unit' : 'An association / committee'}</button>)}</div>
                      </div>
                      {forWho === 'Unit' ? (
                        <div className={`field${fe.unit ? ' invalid' : ''}`}><label>Unit *</label>
                          <Combobox value={unit} onChange={setUnit} options={unitOptions} placeholder="Search a villa or owner…" invalid={!!fe.unit} />
                          {fe.unit && <div className="field-error">{fe.unit}</div>}
                        </div>
                      ) : (
                        <div className={`field${fe.unit ? ' invalid' : ''}`}><label>Association *</label>
                          <Combobox value={assoc} onChange={setAssoc} options={assocOptions} allowCustom placeholder="Pick a committee or type a name…" invalid={!!fe.unit} />
                          {fe.unit && <div className="field-error">{fe.unit}</div>}
                        </div>
                      )}
                      <label className="check" style={{ marginTop: 8 }}><input type="checkbox" data-testid="free-of-charge" checked={free} onChange={(e) => setFree(e.target.checked)} /> Free of charge (waive the fee, GST and deposit)</label>
                      {free && rawQ && rawQ.total > 0 && (
                        <div className={`field${fe.free ? ' invalid' : ''}`}><label>Reason for waiving {inr(rawQ.total)} *</label>
                          <input data-testid="free-reason" value={freeWhy} onChange={(e) => setFreeWhy(e.target.value)} placeholder="e.g. Community event organised by the cultural committee" />
                          {fe.free && <div className="field-error">{fe.free}</div>}
                        </div>
                      )}
                    </div>
                  )}

                  {offered.length > 0 && (dayBased || slot) && (
                    <div data-testid="addon-items">
                      <h4 className="bk-h">{itemsOnly ? 'What do you need?' : <>Add chairs, tables and more <small className="muted">(optional)</small></>}</h4>
                      <div className="addon-grid">
                        {offered.map((it) => {
                          const left = itemLeft(it, bookings, pickedDate, slotKey);
                          const max = Math.min(left, Number(it.maxPerBooking) > 0 ? Number(it.maxPerBooking) : left);
                          const qty = Math.floor(Number(picks[it.id]) || 0);
                          const setQty = (v) => setPicks((p) => ({ ...p, [it.id]: Math.max(0, Math.min(max, Math.floor(Number(v) || 0))) }));
                          return (
                            <div key={it.id} className={`addon-card${qty > 0 ? ' on' : ''}${max <= 0 ? ' out' : ''}`} data-testid="addon-row">
                              <div className="addon-name"><b>{it.name}</b><small className="muted">{Number(it.price) > 0 ? `${inr(it.price)} ${it.perLabel || 'each'}` : 'Free'}</small></div>
                              <small className={`tag${left <= 0 ? ' red' : ''}`}>{left <= 0 ? 'None left' : `${left} left`}</small>
                              <div className="stepper" role="group" aria-label={`Quantity of ${it.name}`}>
                                <button type="button" aria-label={`One less ${it.name}`} disabled={qty <= 0} onClick={() => setQty(qty - 1)}>−</button>
                                <input type="text" inputMode="numeric" aria-label={`Quantity of ${it.name}`} data-testid={`addon-qty-${it.shortId || it.id}`} disabled={max <= 0} value={qty || ''} placeholder="0"
                                  onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} />
                                <button type="button" aria-label={`One more ${it.name}`} disabled={qty >= max} onClick={() => setQty(qty + 1)}>+</button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                      {ex.error && <div className="field invalid"><div className="field-error" data-testid="addon-error">{ex.error}</div></div>}
                    </div>
                  )}

                  {q && (dayBased || slot) && (
                    <>
                      <h4 className="bk-h">Price</h4>
                      <PriceLines q={q} gstin={communityTaxId()} extras={ex.lines} />
                      <h4 className="bk-h">If you cancel</h4>
                      <PolicyList amenity={amenity} date={pickedDate} slot={dayBased ? 'Full day' : slot} />
                      {q.total > 0 && (
                        <>
                          <h4 className="bk-h">Payment</h4>
                          <div className="chips" role="group" aria-label="Payment option">
                            {[...ONLINE_MODES, ...OFFICE_MODES].map((m) => (
                              <button key={m} type="button" aria-pressed={paymentMode === m && !fullCredit} className={`chip${paymentMode === m && !fullCredit ? ' on' : ''}`} onClick={() => { setPaymentMode(m); }}>{m}</button>
                            ))}
                          </div>
                          <small className="muted">{ONLINE_MODES.includes(paymentMode) ? 'Paid now through the payment gateway (simulated in this demo).' : isStaff ? 'You are collecting this payment now.' : `Pay at the office${settings.paymentDueHours ? ` within ${settings.paymentDueHours} hours` : ''}; unpaid reservations are released automatically.`}</small>
                          {canUseCredit && (
                            <label className="check" style={{ marginTop: 8 }}><input type="checkbox" checked={useCredit} onChange={(e) => setUseCredit(e.target.checked)} data-testid="use-credit" /> Use unit credit ({inr(balance)} available{balance < q.total ? ` — covers part of this booking` : ''})</label>
                          )}
                          {creditCover > 0 && (
                            <div className="price-box" style={{ marginTop: 8 }} data-testid="credit-split">
                              <div className="pr-row sub"><span>Paid from unit credit</span><b>− {inr(creditCover)}</b></div>
                              <div className="pr-row total"><span>{fullCredit ? 'Nothing more to pay' : `Still to pay (${paymentMode})`}</span><b data-testid="to-pay">{inr(toPay)}</b></div>
                            </div>
                          )}
                        </>
                      )}
                    </>
                  )}

                  <CustomFields sectionId={COLLECTIONS.AMENITIES} value={custom} onChange={(k, v) => setCustom((c) => ({ ...c, [k]: v }))} />
                  {!isEmptyHtml(amenity.rules) || q ? (
                    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 10, fontSize: 13 }}>
                      <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} style={{ marginTop: 3, width: 'auto' }} />
                      I acknowledge the rules &amp; regulations and the cancellation policy. *
                    </label>
                  ) : null}
                  {fe.ack && <div className="field invalid"><div className="field-error">{fe.ack}</div></div>}
                  {error && <div className="notice error" style={{ marginTop: 10 }}>{error}</div>}
                  {payAttempt && <PaymentResult result={payAttempt} onRetry={confirmBooking} onDone={(paid) => { setPayAttempt(null); if (paid?.status === 'Paid') saveBookingPaid(paid); }} />}
                  {gw.node}
                  <div style={{ marginTop: 12 }}>
                    <button className="btn" disabled={busy || !q || payAttempt?.status === 'Pending'} onClick={confirmBooking} data-testid="book-btn">{cta || 'Choose a time'}</button>
                  </div>
                </div>
              )}
            </div>
          )}
          <BookingsTable bookings={visibleBookings} isResident={isResident} onOpen={setDetailId} title={isResident ? 'My bookings' : 'All bookings'} />

        </>
      )}

      {detail && (
        <BookingDetail booking={detail} amenity={catalog.find((a) => a.name === detail.amenity)} settings={settings} isStaff={isStaff} today={today}
          onClose={() => setDetailId(null)} onAction={onAction} />
      )}
    </div>
  );
}
