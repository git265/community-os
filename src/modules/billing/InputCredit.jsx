import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { ITC, NO_CREDIT, carriesCredit, checkLine, validateGstin } from '../../lib/finance/itc.js';
import { gstGateway, applyGstSettings } from '../../lib/finance/gstGateway.js';
import { inr, dmy } from '../../lib/finance/rules.js';
import { Kpi, Chips } from '../gate/gateUi.jsx';

const TONE = { [ITC.ok]: 'green', [ITC.na]: 'blue', [ITC.unreg]: 'blue', [ITC.none]: 'blue', [ITC.missing]: 'red', [ITC.gstin]: 'orange', [ITC.details]: 'orange' };

/** Billing → Input credit: did each vendor really file the GST we pay them? On demand here; once a day in the background if switched on. */
export default function InputCredit() {
  const { hasPermission, roleId } = useApp();
  const canEdit = roleId === 'super_admin' || hasPermission('MANAGE_LEDGER');
  const { records: ledger, save: saveLine } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: vendors } = useCollection(C.VENDORS, 'Vendors');
  const { records: tax, save: saveTax } = useCollection(C.TAX_SETTINGS, 'Tax split settings');
  const [busy, setBusy] = useState(''); const [msg, setMsg] = useState(''); const [filter, setFilter] = useState([]);
  const s = tax[0] || {};
  const registered = s.registered === 'Yes';
  const rows = useMemo(() => ledger.filter(carriesCredit).sort((a, b) => String(b.date).localeCompare(String(a.date))), [ledger]);
  const st = (l) => l.itcStatus || ITC.none;
  const shown = rows.filter((l) => !filter.length || filter.includes(st(l)));
  const risk = rows.filter((l) => [ITC.missing, ITC.gstin, ITC.details].includes(st(l))).reduce((n, l) => n + (Number(l.gstAmount) || 0), 0);
  const count = (k) => rows.filter((l) => st(l) === k).length;
  const total = rows.reduce((n, l) => n + (Number(l.gstAmount) || 0), 0);

  // what the last check of each payment said (the GST service's answer, or why it could not be checked), shown under its "Check this" button
  const [said, setSaid] = useState({});
  async function checkOne(l) {
    let r;
    try { r = await checkLine(l, vendors, { registered }); } catch (e) { return { bad: true, failed: true, text: `The GST service did not answer: ${e?.message || e}` }; }
    let out = null; let why = '';
    try { out = await saveLine({ ...l, ...r, itcCheckedAt: new Date().toISOString() }); } catch (e) { why = e?.message || String(e); }
    if (!out || out.error) return { bad: true, failed: true, text: `Checked (${r.itcStatus}) but the result was not saved: ${out?.error || why || 'the server refused it'}` };
    const fine = r.itcStatus === ITC.ok || NO_CREDIT.includes(r.itcStatus);
    return { bad: !fine, status: r.itcStatus, text: `${r.itcStatus}${r.itcNote ? `: ${r.itcNote}` : ''}` };
  }
  async function run(list, one = false) {
    setMsg(''); setBusy(one ? list[0].id : 'all'); let ok = 0; let bad = 0; let failed = 0; applyGstSettings(s);
    for (const l of list) {
      const res = await checkOne(l);
      setSaid((m) => ({ ...m, [l.id]: { ...res, at: new Date().toLocaleTimeString() } }));
      if (res.failed) failed += 1; else if (res.bad) bad += 1; else ok += 1;
    }
    setBusy('');
    if (!one) setMsg(list.length ? `Checked ${list.length}: ${ok} fine, ${bad} need attention${failed ? `, ${failed} could not be checked` : ''}.` : 'Nothing to check.');
  }
  const [conn, setConn] = useState(null); const [draft, setDraft] = useState(null); const [gin, setGin] = useState({});
  const cfg = draft || { gstApiMode: s.gstApiMode || 'Simulated', gstApiUrl: s.gstApiUrl || '', gstApiSource: s.gstApiSource || 'GSTR-2B' };
  const setCfg = (k, v) => setDraft({ ...cfg, [k]: v });
  async function saveCfg() { applyGstSettings(cfg); const out = await saveTax({ ...s, ...cfg }); if (out) { setDraft(null); setConn({ ok: true, note: 'Saved.' }); } }
  async function test() {
    setConn({ busy: true }); applyGstSettings(cfg);
    try { const r = await gstGateway().ping(); setConn({ ok: r.ok, note: `${r.label}${r.detail ? ' - ' + r.detail : ''}` }); } catch (e) { setConn({ ok: false, note: String(e.message || e) }); }
  }
  async function verifyGstin(v) {
    applyGstSettings(cfg); setGin((g) => ({ ...g, [v.id]: { busy: true } }));
    const f = validateGstin(v.gstin); if (!f.ok) return setGin((g) => ({ ...g, [v.id]: { text: f.reason, bad: true } }));
    try { const r = await gstGateway().lookupGstin(v.gstin); setGin((g) => ({ ...g, [v.id]: { text: r.valid ? `${r.legalName || ''} · ${r.status || ''}`.replace(/^ · /, '') : 'Not found on the GST portal', bad: !r.valid } })); } catch (e) { setGin((g) => ({ ...g, [v.id]: { text: String(e.message || e), bad: true } })); }
  }
  const gstinOf = (n) => vendors.find((v) => v.name === n)?.gstin;

  return (
    <div data-testid="input-credit">
      <div className="notice" style={{ marginBottom: 12 }}>
        Checks that each vendor really filed the GST you paid them, so the credit can be claimed. {gstGateway().id === 'simulated' ? 'This demo uses a simulated GST portal. Connect a GST service provider to get real answers.' : `Source: ${gstGateway().label}.`}
        {!registered && <b> The society is set as not registered for GST, so no credit is claimed. Change this under Tax split.</b>}
      </div>
      {canEdit && (
        <details className="card" style={{ marginBottom: 12 }} data-testid="itc-connection">
          <summary><b>GST connection</b> <small className="muted">· {cfg.gstApiMode === 'Live' ? 'live' : 'demo'}</small></summary>
          <div className="form-grid" style={{ marginTop: 8 }}>
            <div className="field"><label>Data source</label><select data-testid="gst-mode" value={cfg.gstApiMode} onChange={(e) => setCfg('gstApiMode', e.target.value)}><option>Simulated</option><option>Live</option></select></div>
            <div className="field"><label>GST service address (your server)</label><input data-testid="gst-url" value={cfg.gstApiUrl} placeholder="/api" onChange={(e) => setCfg('gstApiUrl', e.target.value)} /></div>
            <div className="field"><label>Statement to check</label><select data-testid="gst-source" value={cfg.gstApiSource} onChange={(e) => setCfg('gstApiSource', e.target.value)}><option value="GSTR-2B">GSTR-2B (monthly, final)</option><option value="GSTR-2A">GSTR-2A (updates as vendors file)</option></select></div>
          </div>
          {cfg.gstApiMode === 'Live' && !cfg.gstApiUrl.trim() && <div className="field-error">Enter the address of your GST service.</div>}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            <button type="button" className="btn secondary sm" data-testid="gst-test" onClick={test}>{conn?.busy ? 'Testing…' : 'Test connection'}</button>
            <button type="button" className="btn sm" data-testid="gst-save" disabled={cfg.gstApiMode === 'Live' && !cfg.gstApiUrl.trim()} onClick={saveCfg}>Save</button>
          </div>
          {conn && !conn.busy && <div className={conn.ok ? 'notice' : 'notice error'} data-testid="gst-conn" style={{ marginTop: 8 }}>{conn.ok ? '✔ ' : '✖ '}{conn.note}</div>}
          <p className="muted" style={{ fontSize: 13, marginBottom: 4 }}>Your server holds the GST provider's keys and the society's GST login. The browser never sees them. Details: docs/GST_API.md.</p>
          <b style={{ fontSize: 14 }}>Vendor GSTINs</b>
          {vendors.filter((v) => v.gstin).length === 0 ? <p className="muted">No vendor has a GSTIN yet. Add it on the vendor's record.</p> : vendors.filter((v) => v.gstin).map((v) => (
            <div key={v.id} className="pr-row" data-testid="gstin-row" style={{ alignItems: 'center', gap: 8 }}>
              <span><b>{v.name}</b><br /><small className="muted">{v.gstin}</small>{gin[v.id]?.text && <><br /><small className={gin[v.id].bad ? 'field-error' : 'muted'} data-testid="gstin-result">{gin[v.id].text}</small></>}</span>
              <button type="button" className="btn secondary sm" data-testid="gstin-verify" onClick={() => verifyGstin(v)}>Verify</button>
            </div>
          ))}
        </details>
      )}
      <div className="gg-kpis">
        <Kpi label="Payments with GST" short="Payments" value={rows.length} sub={inr(total)} />
        <Kpi label="Verified" value={count(ITC.ok)} />
        <Kpi label="Need attention" short="Attention" value={rows.length - count(ITC.ok) - count(ITC.none) - count(ITC.na) - count(ITC.unreg)} warn={risk > 0} sub={risk ? `${inr(risk)} at risk` : ''} />
        <Kpi label="Not checked yet" short="Unchecked" value={count(ITC.none)} />
      </div>
      <div className="gg-row" style={{ flexWrap: 'wrap', margin: '10px 0' }}>
        {canEdit && <button type="button" className="btn" data-testid="itc-all" disabled={!!busy || !rows.length} onClick={() => run(rows)}>{busy ? 'Checking…' : 'Check all now'}</button>}
        {canEdit && <button type="button" className="btn secondary" data-testid="itc-pending" disabled={!!busy} onClick={() => run(rows.filter((l) => st(l) !== ITC.ok))}>Check only those not verified</button>}
        <label className="check" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" data-testid="itc-auto" disabled={!canEdit || !registered} checked={s.itcAuto !== false} onChange={(e) => saveTax({ ...s, itcAuto: e.target.checked })} /> Also check automatically each day
        </label>
      </div>
      {s.itcLastRun && <small className="muted" data-testid="itc-last">Last automatic check: {new Date(s.itcLastRun).toLocaleString()}</small>}
      {msg && <div className="notice" data-testid="itc-msg">{msg}</div>}
      <Chips multi options={Object.values(ITC)} value={filter} onChange={setFilter} label="Status" />
      {shown.length === 0 ? <div className="empty" data-testid="itc-empty">{rows.length ? 'Nothing matches this filter.' : 'No payment with GST yet.'}</div> : (
        <ul className="list" style={{ display: 'block' }} data-testid="itc-list">
          {shown.map((l) => (
            <li key={l.id} data-testid="itc-row" style={{ display: 'block', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <span><b>{l.vendor || 'No vendor'}</b><br /><small className="muted">{dmy(l.date)} · {l.invoiceNo || l.billNo || 'no invoice no.'} · GST {inr(l.gstAmount)}</small></span>
                <span className={`tag ${TONE[st(l)] || 'blue'}`} data-testid="itc-status">{st(l)}</span>
              </div>
              {(l.itcNote || (!validateGstin(gstinOf(l.vendor)).ok && st(l) === ITC.none)) && <small className="muted">{l.itcNote || validateGstin(gstinOf(l.vendor)).reason}</small>}
              {canEdit && (
                <div style={{ marginTop: 4, display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <button type="button" className="btn secondary sm" data-testid="itc-one" disabled={!!busy} onClick={() => run([l], true)}>{busy === l.id ? 'Checking…' : 'Check this'}</button>
                  {said[l.id] && <small className={said[l.id].bad ? 'field-error' : 'ok-text'} role="status" data-testid="itc-said" style={{ flex: '1 1 240px' }}>{said[l.id].text} <span className="muted">· {said[l.id].at}</span></small>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
