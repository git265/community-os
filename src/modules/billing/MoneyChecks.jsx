import React, { useEffect, useState } from 'react';
import { KIND_LABEL, listIssues, reconOnServer, resolveIssue, runChecks } from '../../lib/reconIssues.js';
import { fmtDateTime, money } from '../../lib/locale.js';
import { getPrincipal } from '../../lib/security/principal.js';

/**
 * Money checks: where receipts, bills, online payments, refunds and the books disagree (found by the server every few minutes, or now).
 * The accounts mark each one Resolved (put right) or Ignored (known and accepted) with a note; both are kept in the audit trail.
 */
export default function MoneyChecks() {
  const [status, setStatus] = useState('Open');
  const [rows, setRows] = useState(null); const [err, setErr] = useState(''); const [said, setSaid] = useState('');
  const [answering, setAnswering] = useState(null); const [note, setNote] = useState('');
  const p = getPrincipal();
  const canResolve = p?.role?.id === 'super_admin' || p?.role?.permissions?.includes('MANAGE_LEDGER');
  const load = () => listIssues(status).then((r) => { setRows(r); setErr(''); }).catch((e) => { setRows([]); setErr(e.message); });
  useEffect(() => { if (reconOnServer()) load(); }, [status]);   // eslint-disable-line react-hooks/exhaustive-deps
  if (!reconOnServer()) return null;
  async function checkNow() {
    try { const r = await runChecks(); setSaid(r.fresh ? `${r.fresh} new item${r.fresh === 1 ? '' : 's'} found` : 'Checked: nothing new'); await load(); } catch (e) { setErr(e.message); }
  }
  async function answer(issue, how) {
    if (!note.trim()) { setErr('Say what was done, or why it is set aside'); return; }
    try { await resolveIssue(issue, how, note.trim()); setAnswering(null); setNote(''); await load(); } catch (e) { setErr(e.message); }
  }
  return (
    <section className="card recon-sec" data-testid="money-checks">
      <div className="recon-head"><b>Money checks</b><span className={`tag ${rows?.length && status === 'Open' ? 'red' : 'green'}`}>{rows === null ? '…' : status === 'Open' ? (rows.length || '✓ none') : rows.length}</span></div>
      <small className="muted">Receipts against the bills they paid, online payments against the payment provider, refunds, the books' balance and the units' credit - checked by the server every few minutes.</small>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
        {['Open', 'Resolved', 'Ignored'].map((s) => <button key={s} type="button" className={`chip-btn${status === s ? ' on' : ''}`} onClick={() => setStatus(s)}>{s}</button>)}
        <button type="button" className="btn secondary sm" data-testid="checks-run" onClick={checkNow}>Check now</button>
        {said && <small className="muted" role="status">{said}</small>}
      </div>
      {err && <div className="field-error" role="alert">{err}</div>}
      {rows?.length > 0 && (
        <ul className="list recon-list">
          {rows.map((i) => (
            <li key={i.id} data-testid="money-check" style={{ flexWrap: 'wrap' }}>
              <span><b>{KIND_LABEL[i.kind] || i.kind}</b>{i.refShortId ? <> · <span className="mono">{i.refShortId}</span></> : null}<br /><small className="muted">{i.detail}</small>
                <br /><small className="muted">{i.shortId} · found {fmtDateTime(i.foundAt)}{i.status !== 'Open' ? ` · ${i.status.toLowerCase()} by ${i.resolvedByName || 'the system'}: ${i.note}` : ''}</small></span>
              {i.expected != null && <b title="expected / found">{money(i.expected, { round: false })}{i.actual != null ? ` / ${money(i.actual, { round: false })}` : ''}</b>}
              {canResolve && i.status === 'Open' && (answering === i.id ? (
                <div style={{ flexBasis: '100%', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <input aria-label="What was done" placeholder="What was done, or why it is set aside" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} style={{ flex: 1, minWidth: 200 }} />
                  <button type="button" className="btn good sm" onClick={() => answer(i, 'Resolved')}>Resolved</button>
                  <button type="button" className="btn secondary sm" onClick={() => answer(i, 'Ignored')}>Ignore</button>
                  <button type="button" className="btn secondary sm" onClick={() => { setAnswering(null); setNote(''); }}>Cancel</button>
                </div>) : <button type="button" className="btn secondary sm" onClick={() => { setAnswering(i.id); setNote(''); setErr(''); }}>Answer…</button>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
