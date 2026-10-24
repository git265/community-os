import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { RecentNote, recentCutoff, inRecent } from '../../components/RecentWindow.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import RecordDetail from './RecordDetail.jsx';
import { fmtDate, money, localDay } from '../../lib/locale.js';
import Tabs from '../../components/Tabs.jsx';

const inr = (n) => money(n);
const dmy = (s) => fmtDate(s, { empty: '—' });

/** Where a cultural expense stands, in one short phrase. */
export function expenseStage(x) {
  if (x.status === 'Rejected') return { text: x.ecApproval === 'Rejected' ? 'Rejected by EC' : 'Rejected', tone: 'red', step: 'rejected' };
  if (x.status === 'Paid') return { text: 'Paid', tone: 'green', step: 'paid' };
  if (x.status === 'Approved') return { text: x.finalRequired === false ? 'Approved (EC)' : 'Approved', tone: 'blue', step: 'approved' };
  return x.ecApproval === 'Approved' ? { text: 'Awaiting Treasurer', tone: 'orange', step: 'final' } : { text: 'Awaiting EC', tone: 'orange', step: 'ec' };
}

/**
 * Cultural money for the Treasurer, in one place.
 *   To pay       approved expenses not yet paid -> Pay…
 *   In approval  raised, waiting for the EC / Treasurer
 *   Paid         paid expenses (with the ledger entry)
 *   Credits      unused event budget credited back to the fund (an internal record, no bank movement)
 */
export default function CulturalPayments({ onPay, canPay }) {
  const { records: expenses } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const { records: events } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const { records: ledger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: skips, save: saveSkip, remove: removeSkip } = useCollection(C.LEDGER_SKIPS, 'Not Recorded Payments');
  const { records: allRel } = useCollection(C.RELEASES, 'Fund releases');
  const { ask, node } = usePrompt();
  const [show, setShow] = useState('todo');
  const [all, setAll] = useState(false);
  const [detail, setDetail] = useState(null); // { kind:'exp'|'rel', row }
  const skipOf = (x) => skips.find((s) => s.sourceId === `cultural:${x.id}`);
  const ev = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
  const paidIds = useMemo(() => new Set(ledger.map((l) => l.sourceId)), [ledger]);
  const expOf = useMemo(() => new Map(expenses.map((x) => [x.id, x])), [expenses]);
  const relOf = (st) => allRel.filter((r) => r.expenseId && expOf.has(r.expenseId) && r.status === st);
  // an expense paid in parts: only the part not yet covered by a release is left to pay as a whole
  const taken = (x) => allRel.filter((r) => r.expenseId === x.id && r.status !== 'Rejected').reduce((n, r) => n + (Number(r.amount) || 0), 0);
  const balance = (x) => Math.max(0, Math.round(((Number(x.amount) || 0) - taken(x)) * 100) / 100);
  const by = useMemo(() => ({
    todo: expenses.filter((x) => x.status === 'Approved' && !paidIds.has(`cultural:${x.id}`) && !skipOf(x) && balance(x) > 0.5),
    skipped: expenses.filter((x) => x.status === 'Approved' && !paidIds.has(`cultural:${x.id}`) && skipOf(x)),
    approval: expenses.filter((x) => x.status === 'Pending approval'),
    relTodo: relOf('Approved'), relWait: relOf('Waiting approval'), relPaid: relOf('Paid'),
    paid: expenses.filter((x) => x.status === 'Paid' || (x.status === 'Approved' && paidIds.has(`cultural:${x.id}`))),
    credits: ledger.filter((l) => l.sourceType === 'culturalCredit'),
  }), [expenses, ledger, paidIds, skips, allRel]); // eslint-disable-line react-hooks/exhaustive-deps
  async function skip(x) {
    const v = await ask({ title: 'Skip this payment', subtitle: 'It moves to “Skipped” so it stops showing as waiting. You can restore it later.', confirm: 'Skip', fields: [{ key: 'reason', label: 'Reason', type: 'textarea', required: true }] });
    if (!v) return;
    await saveSkip({ sourceId: `cultural:${x.id}`, label: `${x.item} · ${inr(x.amount)}`, reason: v.reason });
  }
  const TABS = [['todo', 'To pay'], ['approval', 'In approval'], ['paid', 'Paid'], ['skipped', 'Skipped'], ['credits', 'Budget credits']];
  const cutoff = recentCutoff();
  const dateOf = (x) => (show === 'skipped' ? localDay(skipOf(x)?.createdAt || x.date || '') : (ledger.find((l) => l.sourceId === `cultural:${x.id}`)?.date || x.date));
  const allRows = by[show];
  const rows = (show === 'paid' || show === 'skipped') && !all ? allRows.filter((x) => inRecent(dateOf(x), cutoff)) : allRows;
  const relRows = show === 'todo' ? by.relTodo : show === 'approval' ? by.relWait : show === 'paid' ? by.relPaid : [];
  const relLabel = (r) => `${expOf.get(r.expenseId)?.item || 'Expense'} · release ${r.shortId || ''}`;
  return (
    <div className="card" style={{ marginBottom: 16 }} data-testid="cultural-payments">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>🎭 Cultural</h2>
        <Tabs style={{ margin: 0 }}>
          {TABS.map(([k, l]) => <button key={k} className={show === k ? 'active' : ''} data-testid={`cp-${k}`} onClick={() => setShow(k)}>{l} ({by[k].length + (k === 'todo' ? by.relTodo.length : k === 'approval' ? by.relWait.length : k === 'paid' ? by.relPaid.length : 0)})</button>)}
        </Tabs>
      </div>
      {rows.length === 0 && relRows.length === 0 ? <div className="empty">{show === 'todo' ? 'No approved cultural expense is waiting to be paid.' : show === 'approval' ? 'No cultural expense is waiting for approval.' : show === 'paid' ? 'Nothing paid yet.' : show === 'skipped' ? 'Nothing has been skipped.' : 'No unused budget has been credited back.'}</div> : (
        <ul className="list bk-list">
          {show === 'credits' ? rows.map((l) => (
            <li key={l.id} data-testid="credit-row"><span><b>{l.description}</b><br /><small className="muted">{dmy(l.date)} · {l.account} · internal record, no bank movement{l.creditNote ? ` · ${l.creditNote}` : ''}</small></span><b style={{ color: '#15803d' }}>+{inr(l.amount)}</b></li>
          )) : rows.map((x) => {
            const st = expenseStage(x);
            const entry = ledger.find((l) => l.sourceId === `cultural:${x.id}`);
            return (
              <li key={x.id} className="row-link" data-testid={show === 'todo' ? 'ready-row' : 'cp-row'} onClick={() => setDetail({ kind: 'exp', row: x })}>
                <span><b>{x.item}</b> <small className="muted">· {ev.get(x.eventId)?.name}</small><br /><small className="muted">{x.vendor || '—'} · {x.category || ''} · {dmy(x.date)}</small>{' '}
                  <span className={`tag ${st.tone}`}>{st.text}</span>{entry && <span className="tag blue">Paid {entry.shortId} · {entry.account}</span>}{show === 'skipped' && skipOf(x) && <><br /><small className="muted">Not recorded: {skipOf(x).reason}</small></>}</span>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}><b>{inr(show === 'todo' ? balance(x) : x.amount)}</b>{show === 'todo' && balance(x) < (Number(x.amount) || 0) - 0.5 && <small className="muted">balance</small>}
                  {show === 'todo' && canPay && <button className="btn sm good" data-testid="pay-ready" onClick={() => onPay({ area: 'Cultural', link: `cultural:${x.id}`, amount: balance(x), vendor: x.vendor, description: `${x.item} · ${ev.get(x.eventId)?.name || ''}` })}>Pay</button>}
                  {show === 'todo' && canPay && <button className="btn sm secondary" data-testid="skip-ready" onClick={() => skip(x)}>Skip</button>}
                  {show === 'skipped' && canPay && <button className="btn sm secondary" data-testid="restore-skip" onClick={() => removeSkip(skipOf(x).id)}>Restore</button>}</span>
              </li>
            );
          })}
          {relRows.map((r) => (
            <li key={r.id} className="row-link" data-testid="cp-release-row" onClick={() => setDetail({ kind: 'rel', row: r })}>
              <span><b>{relLabel(r)}</b><br /><small className="muted">to {r.vendor}{r.note ? ` · ${r.note}` : ''} · asked by {r.requestedBy}</small>{' '}<span className={`tag ${r.status === 'Paid' ? 'blue' : r.status === 'Approved' ? 'green' : 'orange'}`}>{r.status === 'Approved' ? 'Release approved' : r.status === 'Paid' ? 'Release paid' : 'Release awaiting approval'}</span></span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}><b>{inr(r.amount)}</b>
                {show === 'todo' && canPay && <button className="btn sm good" data-testid="pay-release" onClick={() => onPay({ area: 'Cultural', link: `culrel:${r.id}`, amount: r.amount, vendor: r.vendor, description: relLabel(r) })}>Pay</button>}</span>
            </li>
          ))}
        </ul>
      )}
      {(show === 'paid' || show === 'skipped') && <RecentNote total={allRows.length} shown={rows.length} all={all} onToggle={() => setAll((v) => !v)} />}
      {node}
      {detail && <ExpenseDetail d={detail} ev={ev} ledger={ledger} releases={allRel} expOf={expOf} onClose={() => setDetail(null)} />}
    </div>
  );
}

const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const stepsOf = (planJson) => { const pl = parse(planJson); return (pl?.steps || []).map((st) => { const ds = (st.decisions || []).filter((d) => d.value !== 'Pending'); const last = ds[ds.length - 1]; const rej = ds.some((d) => d.value === 'Rejected'); const ok = new Set(ds.filter((d) => d.value === 'Approved').map((d) => d.by)).size >= (Number(st.needed) || 1); return { name: st.name, state: st.skipped ? 'approved' : rej ? 'rejected' : ok ? 'approved' : 'pending', who: last?.by, at: last?.at }; }); };

/** What Payments shows when a cultural expense or release row is opened. */
function ExpenseDetail({ d, ev, ledger, releases, expOf, onClose }) {
  const go = (label) => ({ label, onClick: () => { window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link: '#/cultural' } })); onClose(); } });
  if (d.kind === 'rel') {
    const r = d.row; const x = expOf.get(r.expenseId);
    return <RecordDetail title={`Release · ${x?.item || 'Event expense'}`} shortId={r.shortId} tag={r.status} tagTone={r.status === 'Paid' ? 'blue' : r.status === 'Approved' ? 'green' : 'orange'}
      rows={[['Event', ev.get(x?.eventId)?.name], ['Expense', x ? `${x.item} (${x.shortId})` : ''], ['Amount', inr(r.amount)], ['Pay to', r.vendor], ['Asked by', r.requestedBy], ['Note', r.note], ['Raised', dmy(localDay(r.recordCreatedAt || ''))]]}
      steps={stepsOf(r.plan)} payments={ledger.filter((l) => String(l.sourceId || '').includes(r.id))} link={go('Open in Cultural')} onClose={onClose} />;
  }
  const x = d.row; const rels = releases.filter((r) => r.expenseId === x.id && r.status !== 'Rejected');
  const st = expenseStage(x);
  return <RecordDetail title={x.item} shortId={x.shortId} tag={st.text} tagTone={st.tone}
    rows={[['Event', ev.get(x.eventId)?.name], ['Category', x.category], ['Pay to', x.vendor], ['Amount', Number(x.amount) > 0 ? inr(x.amount) : ''], ['Estimate', Number(x.estimate) > 0 ? inr(x.estimate) : ''], ['Date', dmy(x.date)], ['Fund', x.fund], ['Releases', rels.length ? `${rels.length} · ${inr(rels.reduce((n, r) => n + (Number(r.amount) || 0), 0))}` : ''], ['Note', x.note]]}
    steps={stepsOf(x.plan)} payments={ledger.filter((l) => [x.id, ...rels.map((r) => r.id)].some((k) => String(l.sourceId || '').includes(k)))} files={x.attachments || []} link={go('Open in Cultural')} onClose={onClose} />;
}
