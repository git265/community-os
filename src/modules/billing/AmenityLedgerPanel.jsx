import React from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { inr } from '../../lib/amenityEngine.js';

/** Amenity money at a glance inside Payments cross-check: what was collected, refunded, credited back to units and still awaited. Bookings, cancellations and refunds post here automatically. */
export default function AmenityLedgerPanel({ onNavigate }) {
  const { records: ledger } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check');
  const { records: bookings } = useCollection(COLLECTIONS.AMENITIES, 'Amenity Bookings');
  const rows = ledger.filter((l) => l.category === 'Amenities' && Number(l.amount) > 0);
  const sum = (f) => rows.filter(f).reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const cash = (r) => !r.nonCash;
  const gst = rows.filter((r) => r.type === 'Credit' && r.gstAmount).reduce((n, r) => n + (Number(r.gstAmount) || 0), 0);
  const awaiting = bookings.filter((b) => b.status === 'Pending payment' && b.paymentStatus === 'Pending');
  const refundDue = bookings.filter((b) => b.refundStatus === 'Refund due' || b.depositRefundStatus === 'Due');
  const tiles = [
    { label: 'Collected (fees + deposits)', value: inr(sum((r) => cash(r) && r.type === 'Credit')), sub: `incl. GST ${inr(gst)}` },
    { label: 'Refunded in cash', value: inr(sum((r) => cash(r) && r.type === 'Debit')) },
    { label: 'Refunded to unit credit', value: inr(sum((r) => r.nonCash && r.type === 'Debit' && /credited to unit/.test(r.description))), sub: 'non-cash' },
    { label: 'Awaiting payment', value: awaiting.length, sub: inr(awaiting.reduce((n, b) => n + (Number(b.totalPayable) || 0), 0)) },
    { label: 'Refunds to pay', value: refundDue.length, sub: inr(refundDue.reduce((n, b) => n + (Number(b.refundAmount) || 0) + (b.depositRefundStatus === 'Due' ? Number(b.depositReturned) || 0 : 0), 0)) },
  ];
  return (
    <div className="card" style={{ marginBottom: 16 }} data-testid="amenity-ledger-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div><h3 style={{ margin: 0 }}>Amenity bookings in the books</h3><div className="muted" style={{ fontSize: 13 }}>Bookings, cancellations and refunds are posted here automatically (filter the list below by category “Amenities”).</div></div>
        {onNavigate && <button type="button" className="btn secondary sm" onClick={() => onNavigate('amenities')}>Open Amenities ›</button>}
      </div>
      <div className="stat-cards" style={{ marginTop: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {tiles.map((t) => <div key={t.label} className="stat-card" style={{ cursor: 'default' }}><span className="sc-label">{t.label}</span><span className="sc-value" style={{ fontSize: 22 }}>{t.value}</span>{t.sub && <span className="muted" style={{ fontSize: 12 }}>{t.sub}</span>}</div>)}
      </div>
    </div>
  );
}
