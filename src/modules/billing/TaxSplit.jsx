import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { MODES, DEFAULT_SETTINGS, analyse, gstStatus, monthsOf } from '../../lib/finance/tax.js';
import { downloadCsv } from '../../lib/finance/csv.js';
import { inr } from '../../lib/finance/rules.js';
import { Kpi } from '../gate/gateUi.jsx';

const CATEGORIES = ['Maintenance', 'Sinking fund', 'Corpus fund', 'Special levy', 'DG', 'Water', 'Amenity booking', 'Late fee', 'Adjustment', 'Other'];

/** Billing → Tax split: which bill categories count toward the GST limit, where each is banked, and a per-unit test with a live preview. */
export default function TaxSplit() {
  const { hasPermission, roleId } = useApp();
  const canEdit = roleId === 'super_admin' || hasPermission('MANAGE_LEDGER');
  const { records: setRows, save: saveSet } = useCollection(C.TAX_SETTINGS, 'Tax split settings');
  const { records: compRows, save: saveComp } = useCollection(C.TAX_COMPONENTS, 'Tax split components');
  const { records: dues } = useCollection(C.DUES, 'Billing & finance');
  const { records: accounts } = useCollection(C.BANK_ACCOUNTS, 'Bank accounts');
  const [st, setSt] = useState(DEFAULT_SETTINGS);
  const [comps, setComps] = useState([]);
  const [month, setMonth] = useState('');
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => { if (!dirty) setSt({ ...DEFAULT_SETTINGS, ...(setRows[0] || {}) }); }, [setRows, dirty]);
  useEffect(() => {
    if (dirty) return;
    const cats = [...new Set([...CATEGORIES, ...dues.map((d) => d.category).filter(Boolean)])];
    setComps(cats.map((c) => compRows.find((r) => r.category === c) || { category: c, mode: 'Counts toward limit', gstRate: 18, account: '', reason: '', _new: true }));
  }, [compRows, dues, dirty]);
  const months = useMemo(() => monthsOf(dues), [dues]);
  useEffect(() => { if (!month && months.length) setMonth(months[0]); }, [months, month]);

  const status = gstStatus(st);
  const result = useMemo(() => analyse({ dues, rules: comps, settings: st, month }), [dues, comps, st, month]);
  const flagged = result.rows.filter((r) => r.over || r.near);
  const setS = (k, v) => { setSt((x) => ({ ...x, [k]: v })); setDirty(true); setMsg(''); };
  const setC = (cat, k, v) => { setComps((l) => l.map((r) => (r.category === cat ? { ...r, [k]: v } : r))); setDirty(true); setMsg(''); };

  async function save() {
    const { _new, ...s } = st;
    await saveSet({ ...s, ...(setRows[0]?.id ? { id: setRows[0].id } : { id: undefined }), limitPerMonth: Number(st.limitPerMonth) || 0, annualTurnover: Number(st.annualTurnover) || 0, registrationThreshold: Number(st.registrationThreshold) || 0 });
    for (const r of comps) {
      const old = compRows.find((x) => x.category === r.category);
      const { _new: n, ...row } = r;
      const changed = !old || ['mode', 'gstRate', 'account', 'reason'].some((k) => String(old[k] ?? '') !== String(row[k] ?? ''));
      if (changed) await saveComp({ ...row, gstRate: Number(row.gstRate) || 0 });
    }
    setDirty(false); setMsg('Saved');
  }

  return (
    <div data-testid="tax-split">
      <div className="notice" style={{ marginBottom: 12 }}>
        Planning aid, not tax advice. Each setting below must be confirmed with your Chartered Accountant. This page measures and previews. It does not change any bill.
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>GST limit</h2>
        <div className="form-grid">
          <div className="field"><label htmlFor="tx-reg">Registered for GST?</label>
            <select id="tx-reg" data-testid="tx-registered" disabled={!canEdit} value={st.registered} onChange={(e) => setS('registered', e.target.value)}><option>No</option><option>Yes</option></select></div>
          <div className="field"><label htmlFor="tx-limit">Exempt up to (₹ per unit per month)</label>
            <input id="tx-limit" data-testid="tx-limit" type="number" inputMode="numeric" disabled={!canEdit} value={st.limitPerMonth} onChange={(e) => setS('limitPerMonth', e.target.value)} /></div>
          <div className="field"><label htmlFor="tx-turn">Yearly turnover (₹)</label>
            <input id="tx-turn" data-testid="tx-turnover" type="number" inputMode="numeric" disabled={!canEdit} value={st.annualTurnover} onChange={(e) => setS('annualTurnover', e.target.value)} /></div>
          <div className="field"><label htmlFor="tx-thr">Registration threshold (₹ a year)</label>
            <input id="tx-thr" type="number" inputMode="numeric" disabled={!canEdit} value={st.registrationThreshold} onChange={(e) => setS('registrationThreshold', e.target.value)} /></div>
        </div>
        <div className={`notice${status.tone === 'bad' ? ' warn' : ''}`} data-testid="tx-status" style={status.tone === 'bad' ? { borderColor: '#e5484d', color: '#c7364a' } : undefined}>{status.text}</div>
        <div className="field" style={{ marginTop: 8 }}><label htmlFor="tx-note">Note from your CA</label>
          <textarea id="tx-note" rows={2} disabled={!canEdit} value={st.note || ''} onChange={(e) => setS('note', e.target.value)} /></div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <h2 style={{ marginTop: 0 }}>How each bill category is treated</h2>
        <p className="muted" style={{ marginTop: 0 }}>Choose whether a category counts toward the limit, its GST rate, and the bank account it belongs to.</p>
        <div className="tax-comps">
          {comps.map((r) => (
            <div key={r.category} className="tax-comp" data-testid={`tx-comp-${r.category}`}>
              <b className="tax-name">{r.category}</b>
              <div className="field"><label>Treatment</label>
                <select aria-label={`${r.category} treatment`} data-testid={`tx-mode-${r.category}`} disabled={!canEdit} value={r.mode} onChange={(e) => setC(r.category, 'mode', e.target.value)}>{MODES.map((m) => <option key={m}>{m}</option>)}</select></div>
              <div className="field"><label>GST %</label>
                <input aria-label={`${r.category} GST rate`} type="number" inputMode="decimal" disabled={!canEdit} value={r.gstRate ?? ''} onChange={(e) => setC(r.category, 'gstRate', e.target.value)} /></div>
              <div className="field"><label>Account</label>
                <select aria-label={`${r.category} account`} disabled={!canEdit} value={r.account || ''} onChange={(e) => setC(r.category, 'account', e.target.value)}><option value="">Choose…</option>{accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}</select></div>
              <div className="field tax-why"><label>Why</label>
                <input aria-label={`${r.category} reason`} disabled={!canEdit} value={r.reason || ''} onChange={(e) => setC(r.category, 'reason', e.target.value)} placeholder="Reason for the record" /></div>
            </div>
          ))}
        </div>
        {canEdit && <div className="form-actions"><button type="button" className="btn" data-testid="tx-save" disabled={!dirty} onClick={save}>Save</button>{dirty && <span className="muted">Preview below uses your unsaved changes.</span>}{msg && <span className="notice" data-testid="tx-saved">{msg}</span>}</div>}
      </div>

      <div className="card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Test by month</h2>
          <select aria-label="Month" data-testid="tx-month" value={month} onChange={(e) => setMonth(e.target.value)}>{months.map((m) => <option key={m}>{m}</option>)}</select>
        </div>
        <div className="gg-kpis" style={{ marginTop: 10 }}>
          <Kpi label="Units billed" value={result.totals.units} />
          <Kpi label="Over the limit" short="Over" value={result.totals.over} warn={result.totals.over > 0} />
          <Kpi label="Close to the limit" short="Close" value={result.totals.near} />
          <Kpi label="GST that would apply" short="GST" value={inr(result.totals.gst)} sub={status.charges ? '' : 'not charged'} />
        </div>
        <h3 style={{ margin: '8px 0 4px' }}>Collected by account</h3>
        <ul className="list" data-testid="tx-accounts">{result.byAccount.length === 0 ? <li className="muted">No bills in this month.</li> : result.byAccount.map((a) => <li key={a.account}><span>{a.account}</span><b>{inr(a.amount)}</b></li>)}</ul>
        <h3 style={{ margin: '12px 0 4px' }}>Units over or close to the limit</h3>
        {flagged.length === 0 ? <div className="empty" data-testid="tx-none">No unit is over or close to {inr(result.limit)}.</div> : (
          <ul className="list" data-testid="tx-units">
            {flagged.map((r) => (
              <li key={r.unit} data-testid={`tx-unit-${r.unit}`} style={{ display: 'block' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><b>{r.unit}</b><span className={`tag ${r.over ? 'red' : 'orange'}`}>{r.over ? 'Over' : 'Close'}</span></div>
                <small className="muted">Counted {inr(r.counted)} of {inr(result.limit)}{r.over ? ` · GST ${inr(r.gst)}` : ` · ${inr(r.headroom)} left`}</small>
              </li>
            ))}
          </ul>
        )}
        <div className="form-actions"><button type="button" className="btn secondary" data-testid="tx-csv" onClick={() => downloadCsv(`tax-split-${month}`, ['Unit', 'Month', 'Counted', 'Excluded', 'Taxed separately', 'All bills', 'Limit', 'Over limit', 'GST'], result.rows.map((r) => [r.unit, month, r.counted, r.excluded, r.separate, r.total, result.limit, r.over ? 'Yes' : 'No', r.gst]))}>Download all units (CSV)</button></div>
      </div>
    </div>
  );
}
