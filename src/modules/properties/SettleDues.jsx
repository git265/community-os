import React, { useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS, storage } from '../../lib/storage/index.js';
import { applyCredits, r2, todayIso, dmy } from '../../lib/finance/rules.js';
import { money } from '../../lib/locale.js';
import { DocButton } from '../../components/DocumentPreview.jsx';
import { billReceipt, combineDocs } from '../../lib/documents/builders.js';
import { useGatewayPay, PaymentResult } from '../../components/GatewayCheckout.jsx';

import { ONLINE_MODES as ONLINE, ALL_MODES as OFFLINE } from '../../lib/region/paymentModes.js';

/**
 * Settle a unit's dues in one go. Tick the bills (oldest first by default), optionally use the unit's advance,
 * and pay the rest with ONE payment. Every bill gets its own receipt; the advance is used oldest-bill-first.
 */
export default function SettleDues({ unit, dues, credit, resident, onClose }) {
  const { currentUser } = useApp();
  const { save } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');
  const today = todayIso();
  const open = useMemo(() => dues.filter((d) => !['Paid', 'Cancelled'].includes(d.status)).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))), [dues]);
  const [picked, setPicked] = useState(() => new Set(open.map((d) => d.id)));
  const [useAdv, setUseAdv] = useState(credit > 0);
  const modes = resident ? ONLINE : OFFLINE;
  const [mode, setMode] = useState(modes[0]);
  const [ref, setRef] = useState('');
  const [paidOn, setPaidOn] = useState(today);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const gw = useGatewayPay();
  const [attempt, setAttempt] = useState(null);

  const sel = open.filter((d) => picked.has(d.id));
  const total = r2(sel.reduce((n, d) => n + (Number(d.amount) || 0), 0));
  const adv = useAdv ? Math.min(credit, total) : 0;
  const toPay = r2(total - adv);
  const toggle = (id) => setPicked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  async function confirm() {
    setErr('');
    if (!sel.length) return setErr('Tick at least one bill');
    const reference = resident ? `TXN-${Date.now().toString(36).toUpperCase()}` : ref.trim();
    if (toPay > 0 && !resident && mode !== 'Cash' && !reference) return setErr(`Enter the ${mode === 'Cheque' ? 'cheque number' : 'transaction reference'}`);
    if (toPay > 0 && !resident && paidOn > today) return setErr('The payment date cannot be in the future');
    setBusy(true);
    const ids = sel.map((d) => d.id);
    if (resident && toPay > 0) { // owners pay through the payment gateway; the verified webhook marks the bills paid (and uses the advance first)
      setAttempt(null);
      const res = await gw.start({ purpose: 'due', refs: ids, amount: toPay, unit, payer: currentUser?.name || '', description: `${sel.length} bill(s) · ${unit}`, meta: { useCredit: adv > 0 } });
      setBusy(false);
      if (res.status === 'Paid') setDone({ ids, count: sel.length, adv, paid: toPay, mode: res.order?.method || 'Online', reference: res.paymentId });
      else setAttempt(res);
      return;
    }
    if (adv > 0) await applyCredits({ units: [unit], only: ids, actor: currentUser?.name || 'Billing' });
    const fresh = (await storage.list(COLLECTIONS.DUES)).filter((d) => ids.includes(d.id) && !['Paid', 'Cancelled'].includes(d.status));
    let paid = 0;
    for (const d of fresh.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))) {
      const out = await save({ ...d, status: 'Paid', paymentMode: mode, paymentRef: reference || '—', paidAt: resident ? today : paidOn, paidBy: currentUser?.name || '', receiptNo: `RCT-${String(d.shortId || '').replace(/^DUE-/, '') || Date.now()}` });
      if (!out) { setBusy(false); return setErr(`Stopped at ${d.shortId || d.category}: ${paid} bill(s) were settled before that.`); }
      paid += 1;
    }
    setBusy(false);
    setDone({ ids, count: sel.length, adv, paid: toPay, mode, reference });
  }

  if (done) {
    return (
      <Modal title="Dues settled" subtitle={`${unit} · ${done.count} bill(s) cleared`} onClose={onClose}>
        <div className="ro-block" data-testid="settle-done">
          <h3>✅ {money(r2(done.adv + done.paid))} cleared</h3>
          <div className="kv"><span>From advance</span><b>{money(done.adv)}</b><span>Paid now ({done.mode})</span><b>{money(done.paid)}</b>{done.reference && done.paid > 0 && <><span>Reference</span><b>{done.reference}</b></>}</div>
          <p className="muted" style={{ fontSize: 12 }}>Each bill now shows Paid with its own receipt number.</p>
        </div>
        <div className="form-actions"><DocButton className="btn secondary" testid="settle-receipts" label="🧾 Receipts (print / PDF)" title={`Receipts · ${unit}`} fileName={`receipts-${unit}`} build={async () => { const ids = done.ids || []; const rows = (await storage.list(COLLECTIONS.DUES)).filter((d) => ids.includes(d.id)); return combineDocs(await Promise.all(rows.map((d) => billReceipt(d)))); }} /><button className="btn" onClick={onClose}>Done</button></div>
      </Modal>
    );
  }

  return (
    <Modal title={`Settle dues · ${unit}`} subtitle="Pick the bills, use the advance if there is one, and pay the rest in one go." onClose={onClose}>
      <div className="settle-list" data-testid="settle-list">
        {open.map((d) => {
          const late = d.dueDate && d.dueDate < today;
          return (
            <label key={d.id} className={`settle-row${picked.has(d.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={picked.has(d.id)} onChange={() => toggle(d.id)} />
              <span className="grow"><b>{d.category}{d.billedMonth ? ` · ${d.billedMonth}` : ''}</b> <small className="muted">{d.shortId}</small><br />
                <small className={late ? 'due-over' : 'muted'}>Due {dmy(d.dueDate) || '—'}{late ? ' · overdue' : ''}</small></span>
              <b>{money(d.amount)}</b>
            </label>
          );
        })}
        {!open.length && <div className="empty">Nothing to settle.</div>}
      </div>
      <div className="ro-block" style={{ margin: '10px 0' }}>
        <div className="kv"><span>Selected bills</span><b>{money(total)}</b>
          {credit > 0 && <><span>Advance available</span><b>{money(credit)}</b></>}
          {adv > 0 && <><span>Advance used</span><b>− {money(adv)}</b></>}
          <span><b>To pay now</b></span><b data-testid="settle-topay">{money(toPay)}</b></div>
        {credit > 0 && <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={useAdv} onChange={(e) => setUseAdv(e.target.checked)} /> Use the unit's advance first</label>}
      </div>
      {toPay > 0 && !resident && (
        <div className="form-grid">
          <div className="field"><label>{resident ? 'Pay using' : 'Payment mode'} *</label><select value={mode} onChange={(e) => setMode(e.target.value)}>{modes.map((m) => <option key={m}>{m}</option>)}</select></div>
          {!resident && <>
            <div className="field"><label>{mode === 'Cheque' ? 'Cheque number' : 'Reference'}{mode !== 'Cash' ? ' *' : ''}</label><input value={ref} onChange={(e) => setRef(e.target.value)} /></div>
            <div className="field"><label>Received on *</label><input type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} /></div>
          </>}
        </div>
      )}
      {err && <div className="field-error" role="alert">{err}</div>}
      {attempt && <PaymentResult result={attempt} onRetry={confirm} onDone={() => setDone({ ids: sel.map((d) => d.id), count: sel.length, adv, paid: toPay, mode: attempt.order?.method || 'Online', reference: attempt.paymentId })} />}
      {gw.node}
      <div className="form-actions">
        <button className="btn" data-testid="settle-confirm" disabled={busy || !sel.length} onClick={confirm}>{busy ? 'Processing…' : toPay > 0 ? (resident ? `Pay ${money(toPay)}` : 'Record payment') : 'Settle from advance'}</button>
        <button className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
