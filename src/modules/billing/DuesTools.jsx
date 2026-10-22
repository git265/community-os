import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import Modal from '../../components/Modal.jsx';
import { previewMaintenanceFee, publishMaintenanceFee, DEFAULT_FEE_BODY } from '../../lib/maintenanceFee.js';
import { fyStartMonth, money } from '../../lib/locale.js';
import { BASES } from '../../lib/finance/rules.js';
import { LevyDialog, LateFeeDialog, CreditDialog, RulesDialog } from './FinanceTools.jsx';
import { runDueReminders, REMINDER_DEFAULTS, dueForReminder, reminderSettings, DEFAULT_REMINDER_BODY } from '../../lib/dueReminders.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const inr = (n) => money(n);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function periodLabel(kind, year, month, quarter) {
  if (kind === 'Month') return `${MONTHS[month]} ${year}`;
  if (kind === 'Quarter') return `Q${quarter} ${year}`;
  return fyStartMonth() === 1 ? `FY ${year}` : `FY ${year}-${String((year + 1) % 100).padStart(2, '0')}`;
}

/** Buttons above the Dues list: publish the maintenance fee to every unit, and set / send payment reminders for all dues. */
export default function DuesTools() {
  const { roleId } = useApp();
  const [dlg, setDlg] = useState('');
  const canPublish = roleId === 'super_admin' || canWriteCollection(C.DUES, getPrincipal());
  const canRules = roleId === 'super_admin' || canWriteCollection(C.FINANCE_SETTINGS, getPrincipal());
  if (!canPublish && !canRules) return null;
  return (
    <div className="exp-tools" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }} data-testid="dues-tools">
      {canPublish && <button className="btn" data-testid="fee-open" onClick={() => setDlg('fee')}>📣 Publish maintenance fee</button>}
      {canPublish && <button className="btn secondary" data-testid="levy-open" onClick={() => setDlg('levy')}>🏗 Special levy</button>}
      {canPublish && <button className="btn secondary" data-testid="late-open" onClick={() => setDlg('late')}>⏱ Late fees</button>}
      {canPublish && <button className="btn secondary" data-testid="credit-open" onClick={() => setDlg('credit')}>💳 Credits & advances</button>}
      {canRules && <button className="btn secondary" data-testid="rem-open" onClick={() => setDlg('rem')}>🔔 Payment reminders</button>}
      {canRules && <button className="btn secondary" data-testid="rules-open" onClick={() => setDlg('rules')}>⚙ Rules</button>}
      {dlg === 'fee' && <FeeDialog onClose={() => setDlg('')} />}
      {dlg === 'levy' && <LevyDialog onClose={() => setDlg('')} />}
      {dlg === 'late' && <LateFeeDialog onClose={() => setDlg('')} />}
      {dlg === 'credit' && <CreditDialog onClose={() => setDlg('')} />}
      {dlg === 'rules' && <RulesDialog onClose={() => setDlg('')} />}
      {dlg === 'rem' && <ReminderDialog onClose={() => setDlg('')} />}
    </div>
  );
}

function FeeDialog({ onClose }) {
  const now = new Date();
  const { records: tpls, save: saveTpl } = useCollection(C.NOTICE_TEMPLATES, 'Notice Templates');
  const { roleId } = useApp();
  const tpl = tpls.find((t) => t.appliesTo === 'Maintenance fee');
  const canTpl = roleId === 'super_admin' || canWriteCollection(C.NOTICE_TEMPLATES, getPrincipal());
  const [kind, setKind] = useState('Year');
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [quarter, setQuarter] = useState(Math.floor(now.getMonth() / 3) + 1);
  const [amount, setAmount] = useState('');
  const [villa, setVilla] = useState('');
  const [apt, setApt] = useState('');
  const [basis, setBasis] = useState(BASES[0]);
  const [blockOv, setBlockOv] = useState({});
  const { records: blocks } = useCollection(C.BLOCKS, 'Blocks');
  const [due, setDue] = useState(iso(new Date(now.getFullYear(), now.getMonth() + 1, 10)));
  const [body, setBody] = useState('');
  const [prev, setPrev] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (tpl && !body) setBody(tpl.body); }, [tpl]); // eslint-disable-line react-hooks/exhaustive-deps
  const period = periodLabel(kind, Number(year), Number(month), Number(quarter));
  const overrides = useMemo(() => ({ Villa: villa, Apartment: apt }), [villa, apt]);
  const blockOverrides = useMemo(() => Object.fromEntries(Object.entries(blockOv).filter(([, v]) => v !== '')), [blockOv]);
  useEffect(() => { if (Number(amount) > 0 || villa || apt) previewMaintenanceFee({ period, amount, overrides, basis, blockOverrides }).then(setPrev); else setPrev(null); }, [period, amount, overrides, basis, blockOverrides]);
  const todo = (prev || []).filter((r) => !r.exists && r.amount > 0);
  const total = todo.reduce((s, r) => s + r.amount, 0);
  async function go() {
    setBusy(true);
    try {
      if (canTpl && tpl && body && body !== tpl.body) await saveTpl({ ...tpl, body });
      const r = await publishMaintenanceFee({ period, amount, overrides, basis, blockOverrides, dueDate: due, body: body || undefined, actor: getPrincipal().name });
      setPrev(await previewMaintenanceFee({ period, amount, overrides, basis, blockOverrides }));
      setMsg(r.created ? `Published ${period}: ${r.created} bills, ${inr(r.total)} in all.` : `Nothing to publish — every unit already has a ${period} maintenance bill.`);
    } finally { setBusy(false); }
  }
  return (
    <Modal title="Publish maintenance fee" subtitle="Raises one bill per unit. Each owner sees it in Billing & Finance → Dues and gets a notification; payments post to the ledger as separate transactions." onClose={onClose} wide>
      <div data-testid="fee-dialog">
        <div className="form-grid">
          <div className="field"><label>Billing period</label>
            <select data-testid="fee-kind" value={kind} onChange={(e) => setKind(e.target.value)}><option>Month</option><option>Quarter</option><option>Year</option></select></div>
          <div className="field"><label>Year</label><input type="number" data-testid="fee-year" value={year} onChange={(e) => setYear(e.target.value)} /></div>
          {kind === 'Month' && <div className="field"><label>Month</label><select data-testid="fee-month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}</select></div>}
          {kind === 'Quarter' && <div className="field"><label>Quarter</label><select data-testid="fee-quarter" value={quarter} onChange={(e) => setQuarter(Number(e.target.value))}>{[1, 2, 3, 4].map((q) => <option key={q} value={q}>Q{q}</option>)}</select></div>}
          <div className="field"><label>Charged</label>
            <select data-testid="fee-basis" value={basis} onChange={(e) => setBasis(e.target.value)}>{BASES.map((b) => <option key={b}>{b}</option>)}</select></div>
          <div className="field"><label>{basis === 'Per sq ft' ? 'Rate per sq ft (₹)' : basis === 'Per bedroom' ? 'Rate per bedroom (₹)' : 'Fee per unit (₹)'}</label><input type="number" data-testid="fee-amount" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Villas pay instead (₹, optional)</label><input type="number" data-testid="fee-villa" value={villa} onChange={(e) => setVilla(e.target.value)} /></div>
          <div className="field"><label>Apartments pay instead (₹, optional)</label><input type="number" data-testid="fee-apt" value={apt} onChange={(e) => setApt(e.target.value)} /></div>
          {blocks.length > 0 && (
            <details style={{ gridColumn: '1 / -1' }} data-testid="fee-blocks"><summary>Different rate for a block (optional)</summary>
              <div className="form-grid" style={{ marginTop: 6 }}>{blocks.map((b) => <div className="field" key={b.id}><label>{b.name} pays instead (₹)</label><input type="number" data-testid={`fee-block-${b.name}`} value={blockOv[b.name] ?? ''} onChange={(e) => setBlockOv((x) => ({ ...x, [b.name]: e.target.value }))} /></div>)}</div>
            </details>
          )}
          {kind === 'Year' && <p className="muted" data-testid="fee-plan-note" style={{ gridColumn: '1 / -1', margin: 0 }}>Yearly fee. Units set to “Quarterly” in Properties & Residents are billed as four instalments, the first due on the date below and the others every 3 months.</p>}
          <div className="field"><label>{kind === 'Year' ? 'First payment due by' : 'Payable by'}</label><input type="date" data-testid="fee-due" value={due} onChange={(e) => setDue(e.target.value)} /></div>
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Notice sent with each bill {tpl ? `(template “${tpl.name}”)` : ''}</label>
          <textarea data-testid="fee-body" rows={6} value={body || DEFAULT_FEE_BODY} onChange={(e) => setBody(e.target.value)} readOnly={!canTpl && !!tpl} />
          <small className="muted">Use {'{{UNIT}} {{AMOUNT}} {{MONTH}} {{DUE_DATE}} {{SOCIETY_NAME}}'}. {canTpl ? 'Edits are saved to the “Maintenance fee” template (also editable in Communications → Notice templates).' : 'Ask an admin to change the template.'}</small>
        </div>
        <p data-testid="fee-preview" style={{ margin: '12px 0 4px' }}>
          {prev ? <><b>{period}</b>: {todo.length} unit{todo.length === 1 ? '' : 's'} to bill, {inr(total)} in all{todo.some((r) => r.quarterly) ? ` · ${todo.filter((r) => r.quarterly).length} pay quarterly (4 instalments, 3 months apart)` : ''}{prev.some((r) => r.exists) ? ` · ${prev.filter((r) => r.exists).length} unit(s) already billed (skipped)` : ''}{prev.some((r) => r.missing && !r.exists) ? ` · ${prev.filter((r) => r.missing && !r.exists).length} unit(s) have no ${basis === 'Per sq ft' ? 'area' : 'bedrooms'} recorded and are skipped` : ''}.</> : 'Enter the fee to see what will be raised.'}
        </p>
        {msg && <p className="muted" data-testid="fee-msg">{msg}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn" data-testid="fee-publish" disabled={busy || todo.length === 0 || !due} onClick={go}>Publish to {todo.length} units</button>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}

function ReminderDialog({ onClose }) {
  const { records: rows, save } = useCollection(C.FINANCE_SETTINGS, 'Finance Estimates');
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const { records: tpls } = useCollection(C.NOTICE_TEMPLATES, 'Notice Templates');
  const row = rows[0];
  const [f, setF] = useState({ ...REMINDER_DEFAULTS });
  const [msg, setMsg] = useState('');
  useEffect(() => { if (row) setF((x) => ({ ...x, ...Object.fromEntries(Object.keys(REMINDER_DEFAULTS).filter((k) => row[k] !== undefined && row[k] !== '').map((k) => [k, row[k]])) })); }, [row?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const unpaid = dues.filter((d) => !['Paid', 'Cancelled'].includes(d.status) && Number(d.amount) > 0);
  const due = dueForReminder(dues, { enabled: true, everyDays: Number(f.reminderEveryDays) || 7, leadDays: Number(f.reminderLeadDays) || 0, max: Number(f.reminderMax) || 4 });
  const tpl = tpls.find((t) => t.appliesTo === 'Payment reminder');
  async function saveRules() {
    await save({ ...(row || {}), reminderEnabled: !!f.reminderEnabled, reminderEveryDays: Number(f.reminderEveryDays) || 7, reminderLeadDays: Number(f.reminderLeadDays) || 0, reminderMax: Number(f.reminderMax) || 4 });
    setMsg('Reminder rules saved.');
  }
  async function sendNow() {
    const n = await runDueReminders({ force: true, actor: getPrincipal().name });
    setMsg(`Reminder sent for ${n} unpaid bill${n === 1 ? '' : 's'}.`);
  }
  return (
    <Modal title="Payment reminders" subtitle="Applies to every unpaid bill — maintenance, water, DG and any other utility or due. Owners get an in-app notification (and SMS / e-mail / WhatsApp where they opted in)." onClose={onClose}>
      <div data-testid="rem-dialog">
        <label className="pick-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" data-testid="rem-enabled" checked={!!f.reminderEnabled} onChange={(e) => set('reminderEnabled', e.target.checked)} /> Send reminders automatically</label>
        <div className="form-grid" style={{ marginTop: 8 }}>
          <div className="field"><label>Repeat every (days)</label><input type="number" min="1" data-testid="rem-every" value={f.reminderEveryDays} onChange={(e) => set('reminderEveryDays', e.target.value)} /></div>
          <div className="field"><label>Start this many days before the due date</label><input type="number" min="0" data-testid="rem-lead" value={f.reminderLeadDays} onChange={(e) => set('reminderLeadDays', e.target.value)} /></div>
          <div className="field"><label>Stop after this many reminders</label><input type="number" min="1" data-testid="rem-max" value={f.reminderMax} onChange={(e) => set('reminderMax', e.target.value)} /></div>
        </div>
        <p className="muted" data-testid="rem-count">{unpaid.length} bill{unpaid.length === 1 ? ' is' : 's are'} unpaid · {due.length} would be reminded on the next run with these rules.</p>
        <p className="muted">Wording: the “Payment reminder” notice template{tpl ? ` (“${tpl.name}”)` : ''} — edit it in Communications → Notice templates. Tokens: {'{{UNIT}} {{AMOUNT}} {{MONTH}} {{DUE_DATE}} {{BILL_NO}} {{UTILITY_TYPE}} {{WHEN}}'}.</p>
        {!tpl && <pre className="muted" style={{ whiteSpace: 'pre-wrap' }}>{DEFAULT_REMINDER_BODY}</pre>}
        {msg && <p data-testid="rem-msg" className="muted">{msg}</p>}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" data-testid="rem-save" onClick={saveRules}>Save rules</button>
          <button className="btn secondary" data-testid="rem-now" disabled={unpaid.length === 0} onClick={sendNow}>Send to all {unpaid.length} unpaid now</button>
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
