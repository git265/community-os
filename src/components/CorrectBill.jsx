import React, { useMemo, useState } from 'react';
import Modal from './Modal.jsx';
import { useApp, useCollection } from '../context/AppContext.jsx';
import { useUnitRoster } from '../lib/unitRoster.js';
import { COLLECTIONS } from '../lib/storage/index.js';
import { cancelBill, reissueBill, reverseBillPayment } from '../lib/finance/correct.js';

/** "Something is wrong with this bill": cancel it, replace it with a corrected one, or reverse a payment recorded by mistake. History is kept. */
export default function CorrectBill({ due, onClose }) {
  const { records: props } = useUnitRoster();
  const paid = due.status === 'Paid';
  const [mode, setMode] = useState(paid ? 'reverse' : 'reissue');
  const [reason, setReason] = useState(''); const [unit, setUnit] = useState(due.unit || ''); const [amount, setAmount] = useState(String(due.amount ?? '')); const [dueDate, setDueDate] = useState(due.dueDate || '');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const units = useMemo(() => props.map((p) => p.unit).sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })), [props]);
  async function go() {
    setBusy(true); setErr('');
    let r;
    try {
      r = mode === 'reverse' ? await reverseBillPayment(due, reason) : mode === 'cancel' ? await cancelBill(due, reason) : await reissueBill(due, { unit, amount, dueDate }, reason);
    } catch (e) { setErr(e.message); return; } finally { setBusy(false); }
    if (r.error) { setErr(r.error); return; }
    onClose(true);
  }
  return (
    <Modal title={`Correct bill ${due.shortId || ''}`} subtitle={`${due.unit} · ${due.category} · ₹${due.amount}`} onClose={() => onClose(false)}>
      <div data-testid="correct-bill">
        <div className="chip-row" role="group" aria-label="What to do">
          {paid ? <button type="button" className={`chip-btn${mode === 'reverse' ? ' on' : ''}`} data-testid="cb-reverse" onClick={() => setMode('reverse')}>Reverse the payment</button> : (
            <>
              <button type="button" className={`chip-btn${mode === 'reissue' ? ' on' : ''}`} data-testid="cb-reissue" onClick={() => setMode('reissue')}>Replace with a corrected bill</button>
              <button type="button" className={`chip-btn${mode === 'cancel' ? ' on' : ''}`} data-testid="cb-cancel" onClick={() => setMode('cancel')}>Cancel this bill</button>
            </>
          )}
        </div>
        <p className="muted">
          {mode === 'reverse' && 'The bill goes back to Unpaid and its line leaves Payments. Do this when the payment was recorded wrongly. To give money back to the owner instead, issue a credit note from the Dues toolbar.'}
          {mode === 'reissue' && 'The wrong bill is cancelled and a new one is issued for the right unit, amount and date. The two are linked, and nothing is deleted.'}
          {mode === 'cancel' && 'The bill is cancelled and stops counting as owed. Its unpaid late fees are cancelled with it. Nothing is deleted.'}
        </p>
        {mode === 'reissue' && (
          <div className="form-grid">
            <div className="field"><label>Unit *</label><input list="cb-units" data-testid="cb-unit" value={unit} onChange={(e) => setUnit(e.target.value)} /><datalist id="cb-units">{units.map((u) => <option key={u} value={u} />)}</datalist></div>
            <div className="field"><label>Correct amount (₹) *</label><input type="number" min="0" data-testid="cb-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
            <div className="field"><label>Payable by *</label><input type="date" data-testid="cb-date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
          </div>
        )}
        <div className="field"><label>Reason *</label><input data-testid="cb-reason" maxLength={500} value={reason} onChange={(e) => { setReason(e.target.value); setErr(''); }} placeholder="e.g. Billed to the wrong villa" /></div>
        {err && <div className="field-error" data-testid="cb-error">{err}</div>}
        <div className="form-actions"><button type="button" className="btn" data-testid="cb-go" disabled={busy || !reason.trim()} onClick={go}>{mode === 'reverse' ? 'Reverse payment' : mode === 'cancel' ? 'Cancel bill' : 'Issue corrected bill'}</button><button type="button" className="btn secondary" onClick={() => onClose(false)}>Close</button></div>
      </div>
    </Modal>
  );
}
