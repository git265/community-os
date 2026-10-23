// Billing & Finance -> Defaulters: every unit with overdue bills, oldest and biggest first, with one-click reminder / demand / final notices.
import React, { useMemo, useState } from 'react';
import { escapeHtml as esc } from '../../lib/escapeHtml.js';
import Modal from '../../components/Modal.jsx';
import { Chips, MoneyTiles } from '../../components/ui.jsx';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { defaultersOf, BUCKETS, NOTICE_STAGES, noticeText, sendNotices, waiveLateFees, inr, dmy } from '../../lib/finance/rules.js';
import { downloadCsv } from '../../lib/finance/csv.js';
import { PhoneSearch, PhoneFilters } from '../../components/ToolIcons.jsx';

export default function Defaulters() {
  const { records: dues } = useCollection(C.DUES, 'Billing & Finance');
  const { records: props } = useCollection(C.PROPERTIES, 'Properties & Residents');
  const { records: notices } = useCollection(C.DEMAND_NOTICES, 'Demand notices');
  const [bucket, setBucket] = useState('All');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'amount', dir: 'desc' });
  const [pick, setPick] = useState(new Set());
  const [dlg, setDlg] = useState(false);
  const [limit, setLimit] = useState(100);
  const [msg, setMsg] = useState('');
  const canSend = canWriteCollection(C.DEMAND_NOTICES, getPrincipal()) || getPrincipal().roleId === 'super_admin';
  const all = useMemo(() => defaultersOf(dues, props, notices), [dues, props, notices]);
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list = all.filter((r) => (bucket === 'All' || r.bucket === bucket) && (!t || `${r.unit} ${r.owner} ${r.block}`.toLowerCase().includes(t)));
    const f = sort.dir === 'desc' ? -1 : 1;
    return list.sort((a, b) => (typeof a[sort.key] === 'number' ? (a[sort.key] - b[sort.key]) * f : String(a[sort.key]).localeCompare(String(b[sort.key])) * f));
  }, [all, bucket, q, sort]);
  const chosen = rows.filter((r) => pick.has(r.unit));
  const head = (key, label, right) => <th style={{ cursor: 'pointer', textAlign: right ? 'right' : undefined }} onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}>{label}{sort.key === key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}</th>;
  const toggle = (u) => setPick((s) => { const n = new Set(s); if (n.has(u)) n.delete(u); else n.add(u); return n; });
  const total = rows.reduce((n, r) => n + r.amount, 0);
  return (
    <div data-testid="defaulters">
      <MoneyTiles items={[{ label: 'Units overdue', value: String(all.length), tone: all.length ? 'bad' : 'good' }, { label: 'Total overdue', value: inr(all.reduce((n, r) => n + r.amount, 0)) }, { label: '90+ days', value: String(all.filter((r) => r.bucket === BUCKETS[3]).length) }]} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        <Chips label="Age" value={bucket} onChange={setBucket} options={[{ value: 'All', label: `All (${all.length})` }, ...BUCKETS.map((b) => ({ value: b, label: `${b} (${all.filter((r) => r.bucket === b).length})` }))]} />
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        <PhoneSearch style={{ maxWidth: 260 }} testid="def-search" placeholder="Search unit, owner, block" value={q} onChange={(v) => setQ(v)} className="" />
        {canSend && <button className="btn" data-testid="def-notice" disabled={!chosen.length} onClick={() => setDlg(true)}>Send notice to {chosen.length || ''} selected…</button>}
        <button className="btn secondary sm" data-testid="def-all" onClick={() => setPick(new Set(rows.map((r) => r.unit)))}>Select all {rows.length}</button>
        <button className="btn secondary sm" onClick={() => setPick(new Set())}>Clear</button>
        <button className="btn secondary sm" data-testid="csv" onClick={() => downloadCsv('defaulters', ['Unit', 'Owner', 'Block', 'Bills', 'Overdue', 'Late fees', 'Oldest due', 'Days', 'Last notice'], rows.map((r) => [r.unit, r.owner, r.block, r.bills, r.amount, r.lateFees, r.oldest, r.days, r.last ? `${r.last.stage} ${String(r.last.sentAt).slice(0, 10)}` : '']))}>⬇ CSV</button>
      </div>
      {msg && <div className="notice" data-testid="def-msg">{msg}</div>}
      {rows.length === 0 ? <p className="muted" data-testid="def-empty">No unit has overdue bills{bucket !== 'All' ? ' in this age group' : ''}. 🎉</p> : (
        <table className="table resp-table" data-testid="def-table">
          <thead><tr><th /><th>Unit</th><th>Owner / tenant</th><th>Block</th>{head('bills', 'Bills', true)}{head('amount', 'Overdue', true)}<th style={{ textAlign: 'right' }}>of which late fees</th>{head('days', 'Days', true)}<th>Last notice</th><th /></tr></thead>
          <tbody>
            {rows.slice(0, limit).map((r) => (
              <tr key={r.unit} data-testid="def-row">
                <td><input type="checkbox" aria-label={`Select ${r.unit}`} checked={pick.has(r.unit)} onChange={() => toggle(r.unit)} /></td>
                <td data-label="Unit"><b>{r.unit}</b></td><td data-label="Owner / tenant">{r.owner}{r.billTo === 'Tenant' ? ' (tenant)' : ''}</td><td data-label="Block">{r.block}</td>
                <td data-label="Bills" style={{ textAlign: 'right' }}>{r.bills}</td><td data-label="Overdue" style={{ textAlign: 'right' }}><b>{inr(r.amount)}</b></td><td data-label="Late fees" style={{ textAlign: 'right' }}>{r.lateFees ? inr(r.lateFees) : '—'}</td>
                <td data-label="Days" style={{ textAlign: 'right' }}>{r.days}</td><td data-label="Last notice">{r.last ? `${r.last.stage} · ${dmy(String(r.last.sentAt).slice(0, 10))}` : '—'}</td>
                <td>{canSend && r.lateFees > 0 && <button className="btn secondary sm" data-testid="def-waive" onClick={async () => { const n = await waiveLateFees(r.unit, getPrincipal().name); setMsg(`Waived ${n} late fee(s) for ${r.unit}.`); }}>Waive late fees</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rows.length > limit && <button className="btn secondary" onClick={() => setLimit((l) => l + 200)}>Show more ({rows.length - limit} more)</button>}
      <p className="muted" style={{ fontSize: 12 }}>{rows.length} unit(s) shown · {inr(total)} overdue. Notices go to the unit’s owner (or the tenant when bills go to the tenant) as an in-app notification and by SMS / e-mail / WhatsApp where they opted in, and each one is kept as a record.</p>
      {dlg && <NoticeDialog rows={chosen} onClose={() => setDlg(false)} onSent={(n) => { setMsg(`${n} notice${n === 1 ? '' : 's'} sent.`); setPick(new Set()); }} />}
    </div>
  );
}

function NoticeDialog({ rows, onClose, onSent }) {
  const [stage, setStage] = useState('Reminder');
  const [body, setBody] = useState(NOTICE_STAGES.Reminder);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  const pickStage = (s) => { setStage(s); setBody(NOTICE_STAGES[s]); };
  async function go() { setBusy(true); try { const r = await sendNotices({ rows, stage, body, actor: getPrincipal().name }); setDone(r); onSent(r.sent); } finally { setBusy(false); } }
  function printAll() {
    const w = window.open('', '_blank'); if (!w) return window.alert('Allow pop-ups to print the notices.');
    w.document.write(`<html><head><title>${esc(stage)}s</title><style>body{font:14px Arial;padding:30px}.p{page-break-after:always;white-space:pre-wrap;line-height:1.5}</style></head><body>${done.texts.map((t) => `<div class="p"><b>${esc(stage)} · ${esc(t.unit)}</b>\n\n${esc(t.text)}</div>`).join('')}</body></html>`);
    w.document.close(); setTimeout(() => w.print(), 250);
  }
  return (
    <Modal title={`Send notice to ${rows.length} unit${rows.length === 1 ? '' : 's'}`} subtitle="Pick how firm the notice is. You can edit the wording; {{OWNER}} {{UNIT}} {{AMOUNT}} {{BILLS}} {{DAYS}} fill in for each unit." onClose={onClose} wide>
      <div data-testid="notice-dialog">
        <div className="field"><label>Notice</label><select data-testid="notice-stage" value={stage} onChange={(e) => pickStage(e.target.value)}>{Object.keys(NOTICE_STAGES).map((s) => <option key={s}>{s}</option>)}</select></div>
        <div className="field" style={{ marginTop: 8 }}><label>Wording</label><textarea data-testid="notice-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} /></div>
        <p className="muted" data-testid="notice-preview" style={{ whiteSpace: 'pre-wrap' }}><b>Preview for {rows[0]?.unit}:</b>{'\n'}{rows[0] ? noticeText(stage, rows[0], 'Community', body) : ''}</p>
        {done && <p className="muted" data-testid="notice-done">Sent to {done.sent} unit(s).</p>}
        <div className="form-actions">
          {!done ? <button className="btn" data-testid="notice-send" disabled={busy} onClick={go}>Send {rows.length} {stage.toLowerCase()}{rows.length === 1 ? '' : 's'}</button> : <button className="btn" data-testid="notice-print" onClick={printAll}>🖨 Print the notices</button>}
          <button className="btn secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </Modal>
  );
}
