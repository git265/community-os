import React, { useMemo } from 'react';
import { MoneyTiles } from '../../components/ui.jsx';
import { inr, round2, creditBalance } from '../../lib/amenityEngine.js';

const sum = (rows, k) => round2(rows.reduce((n, r) => n + (Number(r[k]) || 0), 0));

function Group({ title, hint, rows, empty, onOpen, extra }) {
  return (
    <div className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>{title} <span className="tag">{rows.length}</span></h3>
      {hint && <p className="muted" style={{ marginTop: -6 }}>{hint}</p>}
      {rows.length === 0 ? <div className="empty">{empty}</div> : (
        <ul className="list bk-list">
          {rows.map((b) => (
            <li key={b.id} style={{ cursor: 'pointer' }} onClick={() => onOpen(b.id)} data-testid={`pay-row-${b.shortId}`}>
              <span><b>{b.amenity}</b> <small className="mono muted">{b.shortId}</small><br /><small className="muted">{b.date} · {b.slot} · {b.unit}</small></span>
              <span><b>{extra(b)}</b></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the office has to do about money: collect, refund, settle deposits - and who holds unit credit. */
export default function AmenityPayments({ bookings, credits, onOpen, today }) {
  const pending = bookings.filter((b) => b.paymentStatus === 'Pending' && b.status !== 'Cancelled');
  const refunds = bookings.filter((b) => b.refundStatus === 'Refund due');
  const depRefunds = bookings.filter((b) => b.depositRefundStatus === 'Due');
  const settle = bookings.filter((b) => b.depositStatus === 'Held' && b.status !== 'Cancelled' && b.date <= today);
  const held = bookings.filter((b) => b.depositStatus === 'Held' && b.status !== 'Cancelled');
  // history: everything already paid back, credited or settled - kept for audit and for answering "what happened to my refund?"
  const history = useMemo(() => {
    const out = [];
    bookings.forEach((b) => {
      if (b.refundStatus === 'Refunded' || b.refundStatus === 'Credited to unit account') out.push({ key: `${b.id}-r`, b, kind: 'Booking refund', amount: b.refundAmount, how: b.refundPayoutMode || (b.refundStatus === 'Credited to unit account' ? 'Unit credit' : ''), ref: b.refundRef, on: b.refundPaidAt || String(b.cancelledAt || '').slice(0, 10), by: b.refundPaidBy, gw: !!b.refundInitiatedAt });
      if (b.depositRefundStatus === 'Paid' || b.depositRefundStatus === 'Credited to unit account') out.push({ key: `${b.id}-d`, b, kind: 'Deposit returned', amount: b.depositReturned, how: b.depositRefundMode, ref: b.depositRefundRef, on: b.depositRefundPaidAt || b.depositSettledAt, by: b.depositRefundPaidBy || b.depositSettledBy, gw: !!b.depositRefundInitiatedAt });
      if (b.depositSettledAt && Number(b.depositDeduction) > 0) out.push({ key: `${b.id}-x`, b, kind: 'Deposit deduction', amount: b.depositDeduction, how: 'Kept by the community', ref: '', on: b.depositSettledAt, by: b.depositSettledBy, gw: false });
    });
    return out.sort((a, c) => String(c.on).localeCompare(String(a.on)));
  }, [bookings]);
  const [showAll, setShowAll] = React.useState(false);
  const units = useMemo(() => [...new Set(credits.map((c) => c.unit))].map((u) => ({ unit: u, balance: creditBalance(credits, u) })).filter((x) => x.balance !== 0), [credits]);

  return (
    <div>
      <MoneyTiles items={[
        { label: 'Awaiting payment', value: inr(sum(pending, 'totalPayable')), sub: `${pending.length} booking${pending.length === 1 ? '' : 's'}`, tone: pending.length ? 'orange' : '' },
        { label: 'Refunds to pay', value: inr(sum(refunds, 'refundAmount') + sum(depRefunds, 'depositReturned')), sub: `${refunds.length + depRefunds.length} item${refunds.length + depRefunds.length === 1 ? '' : 's'}`, tone: refunds.length + depRefunds.length ? 'orange' : '' },
        { label: 'Deposits held', value: inr(sum(held, 'depositAmount')), sub: `${held.length} booking${held.length === 1 ? '' : 's'}` },
        { label: 'Unit credit owed', value: inr(units.reduce((n, u) => n + u.balance, 0)), sub: `${units.length} unit${units.length === 1 ? '' : 's'}` },
      ]} />
      <Group title="Awaiting payment" hint="Cash / cheque bookings. Record the payment to confirm the booking and post it to the Payments Cross-check. Unpaid ones are released automatically." rows={pending} empty="Nothing is waiting for payment." onOpen={onOpen} extra={(b) => inr(b.totalPayable)} />
      <Group title="Refunds to pay out" hint="Cancelled bookings whose refund goes back by the original payment mode. Open one and tap “Initiate refund” (UPI / card / net banking) or record a manual payout." rows={refunds} empty="No refunds are due." onOpen={onOpen} extra={(b) => `${inr(b.refundAmount)} · ${b.paymentMode || ''}`} />
      <Group title="Deposit refunds to pay" hint="Deposits already settled whose balance is waiting to be paid back." rows={depRefunds} empty="No deposit refunds are waiting." onOpen={onOpen} extra={(b) => `${inr(b.depositReturned)} · ${b.depositRefundMode || ''}`} />
      <Group title="Deposits to settle" hint="The date has come: inspect the facility, then return the deposit or deduct for damage." rows={settle} empty="No deposit needs settling." onOpen={onOpen} extra={(b) => inr(b.depositAmount)} />
      <div className="card" style={{ marginTop: 12 }} data-testid="refund-history">
        <h3 style={{ marginTop: 0 }}>History <span className="tag">{history.length}</span></h3>
        <p className="muted" style={{ marginTop: -6 }}>Every refund, returned deposit and deduction is kept here for the record - open one to see its full trail.</p>
        {history.length === 0 ? <div className="empty">Nothing has been refunded or settled yet.</div> : (
          <ul className="list bk-list">
            {(showAll ? history : history.slice(0, 8)).map((h) => (
              <li key={h.key} style={{ cursor: 'pointer' }} onClick={() => onOpen(h.b.id)} data-testid={`hist-${h.b.shortId}`}>
                <span><b>{h.kind}</b> · {h.b.amenity} <small className="mono muted">{h.b.shortId}</small><br /><small className="muted">{h.on} · {h.b.unit} · {h.how}{h.gw ? ' (gateway)' : ''}{h.ref ? ` · ref ${h.ref}` : ''}{h.by ? ` · ${h.by}` : ''}</small></span>
                <span><b>{inr(h.amount)}</b></span>
              </li>
            ))}
          </ul>
        )}
        {history.length > 8 && <button type="button" className="btn secondary sm" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Show fewer' : `Show all ${history.length}`}</button>}
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Unit credit balances</h3>
        {units.length === 0 ? <div className="empty">No unit holds credit.</div> : (
          <ul className="list">{units.map((u) => <li key={u.unit}><span>{u.unit}</span><b>{inr(u.balance)}</b></li>)}</ul>
        )}
      </div>
    </div>
  );
}
