// How the payee of a release is to be paid: mode (UPI, bank transfer, cash, cheque), their UPI id or account details, and a QR code to scan
// (a file on the release). Given by whoever asks for the money; shown to the Treasurer when paying it.
import React from 'react';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { planState, decide } from '../../lib/approval/engine.js';
import { getDataSource } from '../../lib/storage/dataSource.js';

export const PAY_MODES = ['UPI', 'Bank transfer', 'Cash', 'Cheque'];

/** The fields in an "ask for money" form. value: { payMode, payTo }; pending: the QR picked, stored when the form is saved. */
export function PayeeFields({ value, onChange, pending, onPending }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <>
      <div className="field"><label>Pay by</label>
        <select aria-label="Pay by" data-testid="rel-pay-mode" value={value.payMode || ''} onChange={(e) => set('payMode', e.target.value)}>
          <option value="">— the Treasurer decides —</option>{PAY_MODES.map((m) => <option key={m}>{m}</option>)}
        </select>
      </div>
      {(value.payMode === 'UPI' || value.payMode === 'Bank transfer') && (
        <div className="field"><label>{value.payMode === 'UPI' ? 'UPI id' : 'Account details (name, number, IFSC)'}</label>
          <input aria-label="Pay to details" data-testid="rel-pay-to" maxLength={300} value={value.payTo || ''} onChange={(e) => set('payTo', e.target.value)}
            placeholder={value.payMode === 'UPI' ? 'e.g. ganesh@okicici' : 'e.g. Sri Ganesh Stores · 50100123456789 · HDFC0001234'} />
        </div>
      )}
      {value.payMode === 'UPI' && (
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>QR code (optional)</label>
          <AttachmentPicker pending={pending} onChange={onPending} label="Attach the payee's QR code" />
        </div>
      )}
    </>
  );
}

/** How to pay it, for the one paying: mode, UPI id / account, the QR to scan. */
export function PayeeView({ release }) {
  if (!release || (!release.payMode && !release.payTo && !(release.payQr || []).length)) return null;
  return (
    <div className="payee-view" data-testid="payee-view">
      <div><b>Pay by {release.payMode || 'any mode'}</b>{release.payTo ? <> · <span className="mono">{release.payTo}</span></> : null}</div>
      {(release.payQr || []).length > 0 && <AttachmentList items={release.payQr} />}
    </div>
  );
}

/**
 * An EC member asking for money gives the EC's say with it: in the browser demo the EC step is recorded as their approval right after the
 * request is saved (on the server the request does this itself). Returns the plan to save, or null when it does not apply.
 */
export function ecAskPlan(plan, me) {
  if (getDataSource().mode === 'v2' || !plan || !me?.name || me.roleId === 'super_admin' || me.role?.category !== 'EC') return null;
  const st = planState(plan);
  if (st.key !== 'pending' || !st.step.approvers.some((a) => a.kind === 'group' && a.value === 'EC members')) return null;
  const r = decide(plan, me.name, 'Approved', { comment: `Asked for by ${me.name} - counts as the EC approval` });
  return r.plan || null;
}
