import React, { useEffect, useState } from 'react';
import { taxBreakdown, dueInfo, penaltyRule, penaltyExample } from '../lib/billText.js';
import { lateFeeSettings, finalDue, todayIso } from '../lib/finance/rules.js';
import { storage, COLLECTIONS } from '../lib/storage/index.js';
import { money } from '../lib/locale.js';

/**
 * The same explanation everywhere a charge is shown (bill detail, booking detail, payment screens):
 * tax breakdown, the due date (highlighted) and how a late fee will be applied.
 * Pass the figures; the wording and the tax style come from lib/billText.js and the active country.
 */
export default function BillTerms({ amount, rate, mode, flatTax, dueDate, status, due, showPenalty = true, taxId = '', compact = false }) {
  const [settings, setSettings] = useState(null);
  const [all, setAll] = useState([]);
  useEffect(() => { if (showPenalty) lateFeeSettings().then(setSettings).catch(() => {}); }, [showPenalty]);
  useEffect(() => { if (showPenalty && due?.id) storage.list(COLLECTIONS.DUES).then((r) => setAll(r.filter((x) => x.lateFeeFor === due.id))).catch(() => {}); }, [showPenalty, due?.id]);
  const today = todayIso();
  const tb = taxBreakdown({ amount, rate, mode, flatTax });
  const di = dueDate ? dueInfo(dueDate, status, today) : null;
  const fd = showPenalty && settings && due?.id && !['Paid', 'Cancelled'].includes(status) ? finalDue({ ...due, amount }, all, settings, today) : null;
  const ex = showPenalty && settings ? penaltyExample({ ...(due || {}), amount, dueDate, status }, settings, today) : null;
  return (
    <div className={`bill-terms${compact ? ' compact' : ''}`} data-testid="bill-terms">
      {tb.tax > 0 && (
        <div className="bt-block" data-testid="bt-tax">
          <div className="bt-h">{tb.taxName} breakdown</div>
          <div className="pr-row sub"><span>Taxable value</span><span>{money(tb.taxable)}</span></div>
          {tb.lines.map((l) => <div key={l.label} className="pr-row sub"><span>{l.label}{l.rate ? ` ${l.rate}%` : ''}</span><span>{money(l.amount)}</span></div>)}
          <div className="pr-row"><span>Total{tb.mode === 'Inclusive' && tb.rate ? ` (${tb.taxName} included)` : ` incl. ${tb.taxName}`}</span><b>{money(tb.total)}</b></div>
          {taxId && <div className="pr-gstin muted">{tb.idLabel} {taxId}</div>}
        </div>
      )}
      {di && status !== 'Paid' && <div className={`bt-due bt-${di.tone}`} data-testid="bt-due">📅 {di.text}</div>}
      {showPenalty && settings && status !== 'Paid' && (
        <div className="bt-pen" data-testid="bt-penalty">
          <div className="bt-h">Late fee</div>
          <div>{penaltyRule(settings, due?.category)}</div>
          {fd && (fd.charged > 0 || fd.pending > 0) && (
            <div data-testid="bt-final">
              <div className="pr-row sub"><span>Bill amount</span><span>{money(fd.base)}</span></div>
              <div className="pr-row sub"><span>Late fee{fd.charged > 0 && fd.pending > 0 ? ' (added + accruing)' : fd.charged > 0 ? ' (added to dues)' : ' (accrued)'}</span><span>{money(fd.charged + fd.pending)}</span></div>
              <div className="pr-row"><span>Final amount due</span><b>{money(fd.total)}</b></div>
            </div>
          )}
          {ex && !(fd && (fd.charged > 0 || fd.pending > 0)) && <div className={ex.accrued ? 'due-over' : 'muted'}>{ex.accrued ? `So far: ${ex.months} month(s) × ${money(ex.per)} = ${money(ex.total)}.` : `Example: unpaid after ${ex.from}, ${money(ex.per)} is added each month.`}</div>}
        </div>
      )}
    </div>
  );
}
