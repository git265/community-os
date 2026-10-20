import React from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

/**
 * Shows the payments made for a financial task (read only). Paying is done by the Treasurer in Payments: once the quotation or
 * invoice is fully approved it appears there to be reviewed and paid.
 */
export default function LedgerLink({ ticket }) {
  const { records } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check');
  const linked = records.filter((l) => l.taskRef === ticket.ticketNumber);
  return (
    <div className="ledger-link">
      <b>Payments</b>
      {linked.length === 0 ? (
        <div className="muted">Not paid yet. Once approved, it shows up in Payments for the Treasurer to review and pay.</div>
      ) : (
        <ul className="list">
          {linked.map((l) => (
            <li key={l.id}><span><b className="mono">{l.shortId}</b> · {l.description}<br /><small className="muted">{l.account} · {l.type} · {l.date}{Number(l.gstAmount) > 0 ? ` · GST input credit ${inr(l.gstAmount)} @ ${l.gstRate}%` : ''}</small></span><b>{inr(l.amount)}</b></li>
          ))}
        </ul>
      )}
    </div>
  );
}
