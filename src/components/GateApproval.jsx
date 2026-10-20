import React, { useEffect, useState } from 'react';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { COLLECTIONS } from '../lib/storage/index.js';
import { answerApproval } from '../lib/gate/engine.js';
import { Photo, StateTag, Countdown, clock } from '../modules/gate/gateUi.jsx';

/** Approve / Deny / Always allow, straight from a notification or the My Gate page. The first answer wins. */
export function ApprovalButtons({ approvalId, compact = false, onDone }) {
  const [ap, setAp] = useState(null); const [busy, setBusy] = useState(false);
  const load = async () => setAp((await secureStorage.list(COLLECTIONS.GATE_APPROVALS)).find((a) => a.id === approvalId) || null);
  useEffect(() => { load(); const h = (e) => { if (!e.detail?.collection || e.detail.collection === COLLECTIONS.GATE_APPROVALS) load(); }; window.addEventListener('communityos:changed', h); return () => window.removeEventListener('communityos:changed', h); }, [approvalId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!ap) return null;
  const open = ['Pending', 'No answer'].includes(ap.status);
  async function act(decision, always) {
    setBusy(true);
    try { await answerApproval(ap.id, decision, { always }); await load(); window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.GATE_APPROVALS } })); onDone?.(decision); } finally { setBusy(false); }
  }
  if (!open) return <div className="gg-approve-actions" data-testid="approval-answered"><StateTag state={ap.status} /> <small className="muted">{ap.answeredBy ? `by ${ap.answeredBy}` : ''} {ap.answeredAt ? `at ${clock(ap.answeredAt)}` : ''}</small></div>;
  return (
    <div className="gg-approve-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="btn good" data-testid="approve" disabled={busy} onClick={() => act('Approved', false)}>Approve</button>
      <button type="button" className="btn deny" data-testid="deny" disabled={busy} onClick={() => act('Denied', false)}>Deny</button>
      {!compact && <button type="button" className="btn secondary" data-testid="approve-always" disabled={busy} onClick={() => act('Approved', true)}>Always allow</button>}
    </div>
  );
}

/** One approval request as a card: photo, who, why, countdown, buttons. */
export function ApprovalCard({ ap }) {
  const open = ['Pending', 'No answer'].includes(ap.status);
  return (
    <div className={`gg-card ${open ? 'hot' : ap.status === 'Approved' ? 'good' : 'bad'}`} data-testid="approval-card">
      <Photo src={ap.photo} name={ap.name} size={72} />
      <div className="gg-main">
        <b>{ap.name}</b>
        <span className="muted">{[ap.purpose || ap.kind, ap.company, ap.vehicle].filter(Boolean).join(' · ')}</span>
        <small className="muted">{ap.gate} · asked {clock(ap.requestedAt)}{ap.status === 'Pending' && ap.expiresAt ? <> · <Countdown until={ap.expiresAt} /></> : null}</small>
        <ApprovalButtons approvalId={ap.id} />
      </div>
    </div>
  );
}
