import React, { useMemo, useState } from 'react';
import { usePrompt } from '../../components/PromptDialog.jsx';
import { RecentNote, recentCutoff, inRecent } from '../../components/RecentWindow.jsx';
import RecordDetail from './RecordDetail.jsx';
import { useAssocBills, inr, dmy, UTIL_ICON as ICON } from './useAssocBills.js';

/**
 * Payments → Utilities (Association): the pay queue for the bills the association itself pays, like Maintenance does for task invoices.
 * The bills themselves are added and browsed in Utilities → Association bills; here the Treasurer pays them (or skips them).
 *   To pay · Paid · Skipped, with Pay… opening the payment dialog already linked to the bill (sourceId elec: / assoc: / dgfuel:).
 */
export default function UtilityPayments({ onPay, canPay, onNavigate }) {
  const { bills, paidBy, skipOf, isPaid, overdue, saveSkip, removeSkip } = useAssocBills();
  const { ask, node } = usePrompt();
  const [show, setShow] = useState('todo');
  const [fUtil, setFUtil] = useState('');
  const [all, setAll] = useState(false);
  const [detail, setDetail] = useState(null);
  const cutoff = recentCutoff();
  const paidDate = (b) => paidBy(b.key)[0]?.date || b.paidOn || b.date;
  const skipDate = (b) => String(skipOf(b.key)?.createdAt || b.date || '').slice(0, 10);
  const f0 = bills.filter((b) => !fUtil || b.utility === fUtil);
  const full = {
    todo: f0.filter((b) => !isPaid(b) && !skipOf(b.key) && b.amount > 0),
    paid: f0.filter((b) => isPaid(b)).sort((a, b) => String(paidDate(b)).localeCompare(String(paidDate(a)))),
    skipped: f0.filter((b) => !isPaid(b) && skipOf(b.key)),
  };
  const by = { todo: full.todo, paid: all ? full.paid : full.paid.filter((b) => inRecent(paidDate(b), cutoff)), skipped: all ? full.skipped : full.skipped.filter((b) => inRecent(skipDate(b), cutoff)) };
  const utilities = [...new Set(bills.map((b) => b.utility))];
  const TABS = [['todo', 'To pay', by.todo.length], ['paid', 'Paid', by.paid.length], ['skipped', 'Skipped', by.skipped.length]];
  const owing = by.todo.reduce((s, b) => s + b.amount, 0);
  const summary = useMemo(() => { const m = new Map(); bills.filter((b) => !isPaid(b) && !skipOf(b.key) && b.amount > 0).forEach((b) => m.set(b.utility, (m.get(b.utility) || 0) + b.amount)); return [...m.entries()]; }, [bills]); // eslint-disable-line react-hooks/exhaustive-deps
  /** One line of record details that fits the tab: what is owed (To pay), how it was settled (Paid), why it was left (Skipped). */
  function details(b, tab) {
    const base = [b.location, b.vendor, b.src === 'elec' ? b.sub : b.rec?.accountNo ? `A/c ${b.rec.accountNo}` : '', b.rec?.quantity ? `${b.rec.quantity} used` : '', b.src === 'elec' ? '' : `bill ${dmy(b.date)}`].filter(Boolean);
    if (tab === 'todo') return (b.due ? base : [...base, 'no due date']).join(' · ');
    if (tab === 'paid') { const l = paidBy(b.key)[0]; return [...base, l ? `paid ${dmy(l.date)} via ${l.mode || 'bank'}${l.reference ? ` · ref ${l.reference}` : ''} · ${l.account}` : `paid ${b.paidOn ? dmy(b.paidOn) : 'outside the portal'}`].join(' · '); }
    const sk = skipOf(b.key); return [...base, `skipped ${dmy(String(sk?.createdAt || '').slice(0, 10))}${sk?.createdBy ? ` by ${sk.createdBy}` : ''}`].join(' · ');
  }
  async function skip(b) {
    const v = await ask({ title: 'Skip this payment', subtitle: 'It moves to “Skipped” so it stops showing as waiting. You can restore it later.', confirm: 'Skip', fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }] });
    if (v) await saveSkip({ sourceId: b.key, label: `${b.title} · ${inr(b.amount)}`, reason: v.reason });
  }
  return (
    <div className="card" style={{ marginBottom: 16 }} data-testid="utility-payments">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🏢 Utilities (Association)</h2>
        <div className="tabs" style={{ margin: 0 }}>{TABS.map(([k, l, n]) => <button key={k} className={show === k ? 'active' : ''} data-testid={`up-${k}`} onClick={() => setShow(k)}>{l} ({n})</button>)}</div>
      </div>
      <p className="muted" style={{ margin: '4px 0 8px' }}>Bills the association pays — electricity (common area, STP, WTP, clubhouse), water, diesel and more. Add and browse them in <b>Utilities → Association bills</b>; pay them here.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '0 0 8px' }} data-testid="assoc-summary">
        <span className="tag orange">To pay {inr(owing)} · {by.todo.length} bill{by.todo.length === 1 ? '' : 's'}</span>
        {summary.map(([u, n]) => <span key={u} className="tag">{ICON[u] || '🧾'} {u}: <b style={{ color: 'var(--viz-bad, #c7364a)' }}>{inr(n)}</b></span>)}
      </div>
      <div className="exp-tools">
        <select aria-label="Utility" data-testid="assoc-util" value={fUtil} onChange={(e) => setFUtil(e.target.value)}><option value="">All utilities</option>{utilities.map((u) => <option key={u}>{u}</option>)}</select>
        {onNavigate && <button type="button" className="btn secondary sm" data-testid="assoc-manage" onClick={() => { try { sessionStorage.setItem('communityos:openTab', 'assoc'); } catch { /* ignore */ } onNavigate('utilities'); }}>Manage bills in Utilities →</button>}
      </div>
      {by[show].length === 0 ? <div className="empty">{show === 'todo' ? 'No association utility bill is waiting to be paid.' : show === 'paid' ? 'Nothing paid yet.' : 'Nothing has been skipped.'}</div> : (
        <ul className="list bk-list">
          {by[show].map((b) => (
            <li key={b.key} className="row-link" data-testid={show === 'todo' ? 'util-ready-row' : 'util-row'} onClick={() => setDetail(b)}>
              <span><b>{ICON[b.utility] || '🧾'} {b.title}</b> <small className="mono muted">{b.shortId}</small><br />
                <small className="muted" data-testid="util-detail">{details(b, show)}</small>
                {b.due && show === 'todo' && <span className={`tag ${overdue(b) ? 'red' : ''}`} style={{ marginLeft: 6 }}>{overdue(b) ? 'Overdue · ' : 'Due '}{dmy(b.due)}</span>}
                {show === 'paid' && paidBy(b.key).map((l) => <span key={l.id} className="tag blue" style={{ marginLeft: 6 }}>Paid {l.shortId} · {l.account}</span>)}
                {show === 'skipped' && <><br /><small className="muted">Not recorded: {skipOf(b.key).reason}</small></>}</span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}><b>{inr(b.amount)}</b>
                {show === 'todo' && canPay && <><button className="btn sm good" data-testid="pay-util" onClick={() => onPay({ area: 'Utilities', link: b.key, amount: b.amount, vendor: b.vendor, description: b.title })}>Pay</button><button className="btn secondary sm" onClick={() => skip(b)}>Skip</button></>}
                {show === 'skipped' && canPay && <button className="btn sm secondary" onClick={() => removeSkip(skipOf(b.key).id)}>Restore</button>}</span>
            </li>
          ))}
        </ul>
      )}
      {show !== 'todo' && <RecentNote total={full[show].length} shown={by[show].length} all={all} onToggle={() => setAll((v) => !v)} />}
      {node}
      {detail && (() => { const b = detail; const r = b.rec || {}; const st = isPaid(b) ? 'Paid' : overdue(b) ? 'Overdue' : skipOf(b.key) ? 'Skipped' : 'To pay';
        return <RecordDetail title={b.title} shortId={b.shortId} tag={st} tagTone={st === 'Paid' ? 'green' : st === 'Overdue' ? 'red' : 'orange'}
          rows={[['Utility', b.utility], ['Used for', b.location], ['Supplier', b.vendor], ['Account / connection', r.accountNo], ['Bill period', r.period], ['Bill date', dmy(b.date)], ['Due date', b.due ? dmy(b.due) : ''], ['Quantity', r.quantity], ['Total payable', inr(b.amount)], ['Paid outside the portal', r.paidOn ? dmy(r.paidOn) : ''], ['Details', b.src === 'assoc' ? '' : b.sub], ['Skipped', skipOf(b.key)?.reason]]}
          payments={paidBy(b.key)} files={r.billFile || []} note={r.notes ? String(r.notes).replace(/<[^>]*>/g, ' ') : undefined}
          link={onNavigate ? { label: 'Open in Utilities', onClick: () => { try { sessionStorage.setItem('communityos:openTab', 'assoc'); } catch { /* ignore */ } onNavigate('utilities'); } } : undefined} onClose={() => setDetail(null)} />; })()}
    </div>
  );
}
