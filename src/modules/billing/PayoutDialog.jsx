import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { matchPayout, proposePayout } from '../../lib/payouts.js';
import { fmtDate, fmtDateTime, money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false });

/** Match a money-in bank line to the provider payout it is: tick the online payments it carries; the difference is the provider's fees. */
export default function PayoutDialog({ line, onClose, onDone }) {
  const [p, setP] = useState(null); const [err, setErr] = useState(''); const [pick, setPick] = useState(new Set()); const [busy, setBusy] = useState(false);
  useEffect(() => {
    proposePayout(line.id).then((r) => { setP(r); setPick(new Set(r.fits ? r.payments.map((x) => x.id) : [])); }).catch((e) => setErr(e.message));
  }, [line.id]);
  const gross = useMemo(() => (p?.payments || []).filter((x) => pick.has(x.id)).reduce((n, x) => n + Number(x.amount), 0), [p, pick]);
  const net = Number(line.credit) || 0; const fees = Math.round((gross - net) * 100) / 100;
  const ok = pick.size > 0 && fees >= 0 && fees <= gross * 0.05 + 0.005;
  const toggle = (id) => setPick((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  async function save() {
    setBusy(true); setErr('');
    try { await matchPayout(line.id, [...pick]); onDone?.(); onClose(); } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  return (
    <Modal title="Match a payout" subtitle={`${fmtDate(line.date)} · ${line.narration || ''} · ${inr(net)} received`} onClose={onClose} wide>
      {!p && !err && <div className="muted">Finding the online payments…</div>}
      {p && p.payments.length === 0 && <div className="empty">No online payments are waiting for a payout up to this date.</div>}
      {p && p.payments.length > 0 && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>{p.fits ? 'The oldest payments that make up this amount are ticked. Change them if the provider\'s report says otherwise.' : 'Nothing adds up on its own - tick the payments this payout carries.'}</p>
          <ul className="list" data-testid="payout-payments">{p.payments.map((x) => (
            <li key={x.id}><label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}><input type="checkbox" checked={pick.has(x.id)} onChange={() => toggle(x.id)} />
              <span><b className="mono">{x.receiptNo}</b> · {x.provider}<br /><small className="muted">{fmtDateTime(x.receivedAt)}</small></span></label><b>{inr(x.amount)}</b></li>))}</ul>
          <div className="notice" data-testid="payout-sum">Payments {inr(gross)} − received {inr(net)} = provider fees <b>{inr(fees)}</b>{!ok && pick.size > 0 ? ' (fees must be 0 to 5 % of the payments)' : ''}</div>
        </>
      )}
      {err && <div className="field-error" role="alert">{err}</div>}
      <div className="form-actions"><button type="button" className="btn" disabled={!ok || busy} onClick={save}>Match payout</button><button type="button" className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}
