import React from 'react';

/** One colour rule for bill status across the portal: Paid is green; Unpaid / Overdue / Not paid is red. Anything else is left alone. */
export const payTone = (v) => (/^paid$/i.test(String(v)) ? 'green' : /^(unpaid|overdue|not paid)$/i.test(String(v)) ? 'red' : '');
export function StatusTag({ v, children }) {
  const t = payTone(v);
  return <span className={`tag ${t}`.trim()} data-pay={t || undefined}>{children ?? v}</span>;
}
/** For table cells: wrap plain text "Paid" / "Unpaid" / "Overdue" in the coloured tag, pass everything else through. */
export const statusify = (text) => (payTone(text) ? <StatusTag v={text} /> : condTone(text) != null ? <CondTag v={text} /> : text);

/** Amenity booking payment status colours (bookings list, booking detail). Anything not listed (Not required) is plain. */
export const BOOKING_PAY_TONE = Object.freeze({ Paid: 'green', Pending: 'orange', 'Refund due': 'orange', Refunded: 'blue', 'Partially refunded': 'blue', Cancelled: '' });

/** Asset condition colours, the same as the map: green working, amber needs attention, blue under repair, coral out of service. */
const COND_TONE = { Working: 'green', 'Needs attention': 'orange', 'Under repair': 'blue', 'Out of service': 'red', Standby: '', Retired: '' };
export const condTone = (v) => (Object.prototype.hasOwnProperty.call(COND_TONE, String(v)) ? COND_TONE[v] : null);
export const CondTag = ({ v }) => <span className={`tag ${condTone(v) || ''}`.trim()} data-cond={v}>● {v}</span>;
