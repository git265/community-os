// The small dialogs behind the Dues toolbar: special levy, late fees, credit notes & advances, finance rules, and a bill's payment plan.
import React, { useEffect, useMemo, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { currencySymbol } from '../../lib/locale.js';
import { BASES, LATE_KINDS, LATE_CATEGORIES, previewLevy, raiseLevy, lateFeeSettings, planLateFees, applyLateFees, issueCreditNotes, receiveAdvance, applyCredits, creditBalances, splitDue, inr, dmy, todayIso, addMonthsIso, addDaysIso } from '../../lib/finance/rules.js';
import { MODES } from '../../lib/paymentEngine.js';
import Tabs from '../../components/Tabs.jsx';

const actor = () => getPrincipal().name;

/* ------------------------------------------------------------ special levy -- */
export function LevyDialog({ onClose }) {
  const { records: funds } = useCollection(C.FUNDS, 'Fund Position');
  const { records: blocks } = useCollection(C.BLOCKS, 'Blocks');
  const { records: props } = useCollection(C.PROPERTIES, 'Properties & Residents');
  const types = useMemo(() => [...new Set(props.map((p) => p.type).filter(Boolean))], [props]);
  const [f, setF] = useState({ name: '', purpose: '', fund: '', basis: BASES[0], rate: '', kind: 'All', values: [], dueDate: addMonthsIso(todayIso(), 1) });
  const [prev, setPrev] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const scope = useMemo(() => ({ kind: f.kind, values: f.values }), [f.kind, f.values]);
  useEffect(() => { if (Number(f.rate) > 0) previewLevy({ rule: { basis: f.basis, rate: f.rate }, scope }).then(setPrev); else setPrev(null); }, [f.basis, f.rate, scope]);
  const billable = (prev || []).filter((r) => r.amount > 0);
  const total = billable.reduce((s, r) => s + r.amount, 0);
  const toggle = (v) => set('values', f.values.includes(v) ? f.values.filter((x) => x !== v) : [...f.values, v]);
  const ok = f.name.trim() && f.purpose.trim() && f.dueDate && billable.length;
  async function go() {
    setBusy(true);
    try {
      const r = await raiseLevy({ name: f.name.trim(), purpose: f.purpose.trim(), fund: f.fund, rule: { basis: f.basis, rate: Number(f.rate) }, scope, dueDate: f.dueDate, actor: actor() });
      setMsg(r.error || `Levy raised: ${r.created} bills, ${inr(r.total)} in all. Owners have been notified.`);
    } finally { setBusy(false); }
  }
  const opts = f.kind === 'Block' ? blocks.map((b) => b.name) : f.kind === 'Type' ? types : [];
  return (
    <Modal title="Special levy" subtitle="A one-time charge for a purpose (lift replacement, repainting, legal fees…). One bill per unit; payments go to the fund you choose and you can track who has paid." onClose={onClose} wide>
      <div data-testid="levy-dialog">
        <div className="form-grid">
          <div className="field"><label>Levy name *</label><input data-testid="levy-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Lift modernisation 2026" /></div>
          <div className="field"><label>Purpose *</label><input data-testid="levy-purpose" value={f.purpose} onChange={(e) => set('purpose', e.target.value)} /></div>
          <div className="field"><label>Goes into fund</label><select data-testid="levy-fund" value={f.fund} onChange={(e) => set('fund', e.target.value)}><option value="">Choose…</option>{funds.map((x) => <option key={x.id} value={x.name}>{x.name}{x.kind ? ` (${x.kind})` : ''}</option>)}</select></div>
          <div className="field"><label>Charged</label><select data-testid="levy-basis" value={f.basis} onChange={(e) => set('basis', e.target.value)}>{BASES.map((b) => <option key={b}>{b}</option>)}</select></div>
          <div className="field"><label>{f.basis === 'Per sq ft' ? 'Rate per sq ft (₹)' : f.basis === 'Per bedroom' ? 'Rate per bedroom (₹)' : 'Amount per unit (₹)'} *</label><input type="number" min="0" data-testid="levy-rate" value={f.rate} onChange={(e) => set('rate', e.target.value)} /></div>
          <div className="field"><label>Payable by *</label><input type="date" data-testid="levy-due" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></div>
          <div className="field"><label>Applies to</label><select data-testid="levy-scope" value={f.kind} onChange={(e) => setF((x) => ({ ...x, kind: e.target.value, values: [] }))}><option value="All">All units</option><option value="Block">Selected blocks</option><option value="Type">Selected property types</option></select></div>
        </div>
        {opts.length > 0 && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '8px 0' }}>{opts.map((o) => <label key={o} className="pick-row" style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" data-testid={`levy-pick-${o}`} checked={f.values.includes(o)} onChange={() => toggle(o)} />{o}</label>)}</div>}
        <p data-testid="levy-preview" style={{ margin: '10px 0 4px' }}>{prev ? <><b>{billable.length}</b> unit{billable.length === 1 ? '' : 's'} will be billed, <b>{inr(total)}</b> in all{prev.length - billable.length > 0 ? ` · ${prev.length - billable.length} skipped (no ${f.basis === 'Per sq ft' ? 'area' : 'bedrooms'} recorded)` : ''}.</> : 'Enter the amount to see what will be raised.'}</p>
        {msg && <p className="muted" data-testid="levy-msg">{msg}</p>}
        <div style={{ display: 'flex', gap: 8 }}><button className="btn" data-testid="levy-raise" disabled={busy || !ok} onClick={go}>Raise levy on {billable.length} units</button><button className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- late fees -- */
export function LateFeeDialog({ onClose }) {
  const { records: rows, save } = useCollection(C.FINANCE_SETTINGS, 'Finance Estimates');
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const row = rows[0];
  const [enabled, setEnabled] = useState(false);
  const [auto, setAuto] = useState(false);
  // rule 0 is always "all other bills"; the rest are for one bill type each (water, DG, amenity ...)
  const [rules, setRules] = useState([{ id: 'default', appliesTo: '*', kind: LATE_KINDS[0], value: 2, grace: 15, maxMonths: 6 }]);
  const [msg, setMsg] = useState('');
  useEffect(() => { lateFeeSettings().then((s) => { setEnabled(s.enabled); setAuto(s.auto); if (s.rules.length || row?.lateFeeRules !== undefined) setRules([...s.rules.filter((r) => r.appliesTo === '*'), ...s.rules.filter((r) => r.appliesTo !== '*')]); }); }, [row?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const setRule = (i, k, v) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const used = new Set(rules.map((r) => r.appliesTo));
  const free = LATE_CATEGORIES.filter((c) => !used.has(c));
  const settings = { enabled: true, auto, rules: rules.map((r) => ({ ...r, value: Number(r.value) || 0, grace: Number(r.grace) || 0, maxMonths: Number(r.maxMonths) || 0 })) };
  const plan = useMemo(() => planLateFees(dues, settings), [dues, JSON.stringify(rules)]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = plan.reduce((n, p) => n + p.amount, 0);
  const saveRule = async () => {
    const def = settings.rules.find((r) => r.appliesTo === '*') || { kind: LATE_KINDS[0], value: 0, grace: 0, maxMonths: 0 };
    await save({ ...(row || {}), lateFeeEnabled: !!enabled, lateFeeAuto: !!auto, lateFeeKind: def.kind, lateFeeValue: def.value, lateFeeGraceDays: def.grace, lateFeeMaxMonths: def.maxMonths, lateFeeRules: JSON.stringify(settings.rules) });
    setMsg('Late-fee rules saved.');
  };
  async function apply() {
    await saveRule();
    const r = await applyLateFees({ actor: actor() });
    setMsg(r.created ? `Added ${r.created} late fee${r.created === 1 ? '' : 's'} (${inr(r.total)}).` : 'No late fee is due right now.');
  }
  return (
    <Modal title="Late fees" subtitle="Set a late-fee rule for each kind of bill: a charge on bills left unpaid after the due date plus the grace days, once for each month the bill stays unpaid. Late fees never earn further fees." onClose={onClose}>
      <div data-testid="late-dialog">
        <label className="pick-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" data-testid="late-enabled" checked={!!enabled} onChange={(e) => setEnabled(e.target.checked)} /> Charge late fees</label>
        {rules.map((r, i) => { const isDef = r.appliesTo === '*'; return (
          <div key={r.id + i} className="ro-block" style={{ marginTop: 10 }} data-testid={isDef ? 'late-rule-default' : 'late-rule'}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <b>{isDef ? <span>All other bills <small className="muted" data-testid="late-covers">· covers {LATE_CATEGORIES.filter((c) => !rules.filter((x) => x.appliesTo !== '*').some((x) => x.appliesTo === c)).join(', ') || 'nothing else'}. Set the amount to 0 for no late fee on them.</small></span> : <select data-testid={`late-cat-${i}`} value={r.appliesTo} onChange={(e) => setRule(i, 'appliesTo', e.target.value)}>{[r.appliesTo, ...free].map((c) => <option key={c}>{c}</option>)}</select>}</b>
              <button type="button" className="btn secondary sm" data-testid={isDef ? 'late-del-default' : `late-del-${i}`} onClick={() => setRules((rs) => rs.filter((_, j) => j !== i))}>{isDef ? 'No late fee on other bills' : 'Remove'}</button>
            </div>
            <div className="form-grid" style={{ marginTop: 6 }}>
              <div className="field"><label>Fee is</label><select data-testid={isDef ? 'late-kind' : `late-kind-${i}`} value={r.kind} onChange={(e) => setRule(i, 'kind', e.target.value)}>{LATE_KINDS.map((k) => <option key={k}>{k}</option>)}</select></div>
              <div className="field"><label>{r.kind === 'Fixed per month' ? `Amount (${currencySymbol()})` : 'Percent of the bill (%)'}</label><input type="number" min="0" step="0.1" data-testid={isDef ? 'late-value' : `late-value-${i}`} value={r.value} onChange={(e) => setRule(i, 'value', e.target.value)} /></div>
              <div className="field"><label>Grace days after the due date</label><input type="number" min="0" data-testid={isDef ? 'late-grace' : `late-grace-${i}`} value={r.grace} onChange={(e) => setRule(i, 'grace', e.target.value)} /></div>
              <div className="field"><label>Stop after (months, 0 = no limit)</label><input type="number" min="0" data-testid={isDef ? 'late-max' : `late-max-${i}`} value={r.maxMonths} onChange={(e) => setRule(i, 'maxMonths', e.target.value)} /></div>
            </div>
          </div>
        ); })}
        {!rules.some((r) => r.appliesTo === '*') && <p className="muted" data-testid="late-none-default" style={{ marginTop: 10 }}>No late fee is charged on bills that have no rule of their own. <button type="button" className="btn secondary sm" data-testid="late-add-default" onClick={() => setRules((rs) => [{ id: 'default', appliesTo: '*', kind: LATE_KINDS[0], value: 2, grace: 15, maxMonths: 6 }, ...rs])}>Charge on all other bills too</button></p>}
        {free.length > 0 && <button type="button" className="btn secondary sm" style={{ marginTop: 8 }} data-testid="late-add" onClick={() => setRules((rs) => [...rs, { id: `r${Date.now()}`, appliesTo: free[0], kind: LATE_KINDS[0], value: 2, grace: 7, maxMonths: 6 }])}>+ Add a rule for another bill type</button>}
        <label className="pick-row" style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}><input type="checkbox" data-testid="late-auto" checked={!!auto} onChange={(e) => setAuto(e.target.checked)} /> Add late fees automatically each month (no need to press the button)</label>
        <p data-testid="late-preview" className="muted" style={{ margin: '10px 0' }}>{plan.length ? <>With these rules, <b>{plan.length}</b> late fee{plan.length === 1 ? ' is' : 's are'} due now on <b>{new Set(plan.map((p) => p.due.unit)).size}</b> unit{new Set(plan.map((p) => p.due.unit)).size === 1 ? '' : 's'}, <b>{inr(total)}</b> in all.</> : 'No late fee is due right now.'}</p>
        {msg && <p data-testid="late-msg" className="muted">{msg}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn secondary" data-testid="late-save" onClick={saveRule}>Save rules</button>
          <button className="btn" data-testid="late-apply" disabled={!plan.length} onClick={apply}>Add {plan.length} late fee{plan.length === 1 ? '' : 's'} now</button>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------- credit notes & advances -- */
function parseLines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^(.+?)[\s,;:=\t]+([\d.,]+)$/.exec(l); return m ? { unit: m[1].trim(), amount: Number(m[2].replace(/,/g, '')) } : { unit: l, amount: NaN }; });
}
export function CreditDialog({ onClose }) {
  const { records: accounts } = useCollection(C.BANK_ACCOUNTS, 'Bank Accounts');
  const { records: props } = useCollection(C.PROPERTIES, 'Properties & Residents');
  const [mode, setMode] = useState('note');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [how, setHow] = useState('credit');
  const [unit, setUnit] = useState('');
  const [amount, setAmount] = useState('');
  const [account, setAccount] = useState('');
  const [pm, setPm] = useState('Bank transfer');
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(todayIso());
  const [msg, setMsg] = useState('');
  const [bal, setBal] = useState(new Map());
  useEffect(() => { creditBalances().then(setBal); }, [msg]);
  const known = new Set(props.map((p) => p.unit));
  const lines = parseLines(text);
  const bad = lines.filter((l) => !known.has(l.unit) || !(l.amount > 0));
  const good = lines.filter((l) => known.has(l.unit) && l.amount > 0);
  async function issue() {
    const r = await issueCreditNotes({ rows: good, reason, how, account, mode: pm, ref, date, actor: actor() });
    setMsg(r.error || `${r.created} credit note${r.created === 1 ? '' : 's'}, ${inr(r.total)} ${how === 'refund' ? 'refunded' : 'kept as credit - used on the next bill automatically'}.`);
    if (!r.error) setText('');
  }
  async function advance() {
    if (!known.has(unit)) return setMsg('Choose a unit from the list');
    const r = await receiveAdvance({ unit, amount: Number(amount), account, mode: pm, ref, date, actor: actor() });
    setMsg(r.error || `Advance of ${inr(amount)} recorded for ${unit}. It will be used on its next bill.`);
    if (!r.error) { setAmount(''); setUnit(''); }
  }
  const holding = [...bal.entries()].filter(([, v]) => v > 0);
  const acct = (
    <>
      <div className="field"><label>Bank account *</label><select data-testid="cr-account" value={account} onChange={(e) => setAccount(e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id}>{a.name}</option>)}</select></div>
      <div className="field"><label>Mode</label><select data-testid="cr-mode" value={pm} onChange={(e) => setPm(e.target.value)}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
      <div className="field"><label>UTR / cheque no.</label><input data-testid="cr-ref" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
      <div className="field"><label>Date</label><input type="date" data-testid="cr-date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} /></div>
    </>
  );
  return (
    <Modal title="Credits & advances" subtitle="Give different units different credits, or record money received before a bill exists. Credit is used on the unit's next bills automatically." onClose={onClose} wide>
      <div data-testid="credit-dialog">
        <Tabs style={{ margin: '0 0 8px' }}>
          <button className={mode === 'note' ? 'active' : ''} data-testid="cr-tab-note" onClick={() => { setMode('note'); setMsg(''); }}>Credit note</button>
          <button className={mode === 'advance' ? 'active' : ''} data-testid="cr-tab-adv" onClick={() => { setMode('advance'); setMsg(''); }}>Advance received</button>
        </Tabs>
        {mode === 'note' ? (
          <>
            <div className="field"><label>Why is the credit given? *</label><input data-testid="cr-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Billing error in September, lift outage, …" /></div>
            <div className="field" style={{ marginTop: 8 }}><label>Unit and amount, one per line *</label>
              <textarea data-testid="cr-lines" rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder={'V-101, 500\nV-102, 1200'} /></div>
            <p className="muted" data-testid="cr-parse">{good.length} valid line{good.length === 1 ? '' : 's'}{bad.length ? ` · ${bad.length} to fix: ${bad.slice(0, 3).map((b) => b.unit).join(', ')}${bad.length > 3 ? '…' : ''}` : ''}{good.length ? ` · ${inr(good.reduce((n, g) => n + g.amount, 0))} in all` : ''}</p>
            <div style={{ display: 'flex', gap: 14, margin: '4px 0' }}>
              <label className="pick-row" style={{ display: 'flex', gap: 4 }}><input type="radio" name="how" data-testid="cr-how-credit" checked={how === 'credit'} onChange={() => setHow('credit')} /> Adjust against the next bill</label>
              <label className="pick-row" style={{ display: 'flex', gap: 4 }}><input type="radio" name="how" data-testid="cr-how-refund" checked={how === 'refund'} onChange={() => setHow('refund')} /> Refund now from the bank</label>
            </div>
            {how === 'refund' && <div className="form-grid">{acct}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="btn" data-testid="cr-issue" disabled={!good.length || bad.length > 0 || !reason.trim() || (how === 'refund' && !account)} onClick={issue}>Issue {good.length} credit note{good.length === 1 ? '' : 's'}</button></div>
          </>
        ) : (
          <>
            <div className="form-grid">
              <div className="field"><label>Unit *</label><input list="cr-units" data-testid="cr-unit" value={unit} onChange={(e) => setUnit(e.target.value)} /><datalist id="cr-units">{props.slice(0, 3000).map((p) => <option key={p.id} value={p.unit} />)}</datalist></div>
              <div className="field"><label>Amount received (₹) *</label><input type="number" min="0" data-testid="cr-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
              {acct}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button className="btn" data-testid="cr-advance" disabled={!unit || !(Number(amount) > 0) || !account} onClick={advance}>Record advance</button></div>
          </>
        )}
        {msg && <p className="muted" data-testid="cr-msg" style={{ marginTop: 8 }}>{msg}</p>}
        <div style={{ marginTop: 10 }}>
          <b>Credit held on units</b> <span className="muted" data-testid="cr-held">{holding.length ? `${holding.length} unit(s), ${inr(holding.reduce((n, [, v]) => n + v, 0))}` : 'none'}</span>
          {holding.length > 0 && <div className="muted" style={{ fontSize: 13 }}>{holding.slice(0, 8).map(([u, v]) => `${u} ${inr(v)}`).join(' · ')}{holding.length > 8 ? ' …' : ''}
            <div><button className="btn secondary" data-testid="cr-apply" style={{ marginTop: 6 }} onClick={async () => { const n = await applyCredits({ actor: actor() }); setMsg(n ? `Credit used on ${n} bill(s).` : 'No unpaid bill to use the credit on.'); }}>Use credit on unpaid bills now</button></div></div>}
        </div>
        <div className="form-actions"><button className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------- rules -- */
export function RulesDialog({ onClose }) {
  const { records: rows, save } = useCollection(C.FINANCE_SETTINGS, 'Finance Estimates');
  const row = rows[0];
  const { roleId } = useApp();
  const closer = roleId === 'super_admin' || roleId === 'treasurer' || roleId === 'president';
  const [f, setF] = useState({ blockDefaulters: false, blockOverdueDays: 60, blockOverdueAmount: 0, lockedUntil: '', approvalLimit: 0 });
  const [msg, setMsg] = useState('');
  useEffect(() => { if (row) setF((x) => ({ ...x, ...Object.fromEntries(Object.keys(x).filter((k) => row[k] !== undefined && row[k] !== null).map((k) => [k, row[k]])) })); }, [row?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const lockMax = addDaysIso(todayIso(), -1);
  async function go() {
    if (f.lockedUntil && f.lockedUntil > lockMax) { setMsg('The books can be closed up to yesterday at most.'); return; }
    if (row?.lockedUntil && (!f.lockedUntil || f.lockedUntil < row.lockedUntil) && roleId !== 'super_admin') { setMsg('Only the Super Admin can reopen closed books.'); return; }
    const saved = await save({ ...(row || {}), blockDefaulters: !!f.blockDefaulters, blockOverdueDays: Number(f.blockOverdueDays) || 0, blockOverdueAmount: Number(f.blockOverdueAmount) || 0, lockedUntil: f.lockedUntil || '', approvalLimit: Number(f.approvalLimit) || 0 });
    setMsg(saved ? 'Rules saved.' : 'Not saved.');
  }
  return (
    <Modal title="Finance rules" subtitle="Controls that protect the books." onClose={onClose}>
      <div data-testid="rules-dialog">
        <h4 style={{ margin: '4px 0' }}>Defaulters</h4>
        <label className="pick-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" data-testid="rules-block" checked={!!f.blockDefaulters} onChange={(e) => set('blockDefaulters', e.target.checked)} /> Stop amenity booking for units with overdue dues</label>
        <div className="form-grid" style={{ marginTop: 6 }}>
          <div className="field"><label>…overdue for at least (days)</label><input type="number" min="0" data-testid="rules-days" value={f.blockOverdueDays} onChange={(e) => set('blockOverdueDays', e.target.value)} /></div>
          <div className="field"><label>…and owing more than (₹)</label><input type="number" min="0" data-testid="rules-amount" value={f.blockOverdueAmount} onChange={(e) => set('blockOverdueAmount', e.target.value)} /></div>
        </div>
        <h4 style={{ margin: '12px 0 4px' }}>Close the books</h4>
        <div className="field"><label>No payment dated on or before this day can be added, changed or removed</label>
          <input type="date" data-testid="rules-lock" value={f.lockedUntil || ''} max={lockMax} disabled={!closer} onChange={(e) => set('lockedUntil', e.target.value)} />
          {!closer && <small className="muted">Only the Treasurer, President or Super Admin can change this.</small>}</div>
        <h4 style={{ margin: '12px 0 4px' }}>Payment approval</h4>
        <div className="field"><label>Payments above this amount (₹) need a second person to approve (0 = off)</label><input type="number" min="0" data-testid="rules-limit" value={f.approvalLimit} onChange={(e) => set('approvalLimit', e.target.value)} /></div>
        {msg && <p className="muted" data-testid="rules-msg">{msg}</p>}
        <div className="form-actions"><button className="btn" data-testid="rules-save" onClick={go}>Save rules</button><button className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- payment plan -- */
export function PlanDialog({ due, onClose }) {
  const [parts, setParts] = useState(3);
  const [first, setFirst] = useState(due.dueDate && due.dueDate > todayIso() ? due.dueDate : addMonthsIso(todayIso(), 0));
  const [msg, setMsg] = useState('');
  const each = Math.round((Number(due.amount) / Number(parts || 1)) * 100) / 100;
  async function go() {
    const r = await splitDue(due, { parts, firstDue: first, actor: actor() });
    if (r.error) setMsg(r.error); else onClose();
  }
  return (
    <Modal title="Pay in instalments" subtitle={`Split ${inr(due.amount)} (${due.category}${due.billedMonth ? ` · ${due.billedMonth}` : ''}) into equal monthly instalments.`} onClose={onClose}>
      <div data-testid="plan-dialog">
        <div className="form-grid">
          <div className="field"><label>Number of instalments</label><input type="number" min="2" max="24" data-testid="plan-parts" value={parts} onChange={(e) => setParts(e.target.value)} /></div>
          <div className="field"><label>First instalment due</label><input type="date" data-testid="plan-first" value={first} onChange={(e) => setFirst(e.target.value)} /></div>
        </div>
        <p className="muted" data-testid="plan-note">{parts} × about {inr(each)}, one every month from {dmy(first)}.</p>
        {msg && <div className="notice error">{msg}</div>}
        <div className="form-actions"><button className="btn" data-testid="plan-go" onClick={go}>Create plan</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
      </div>
    </Modal>
  );
}
