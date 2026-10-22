import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { SegTabs, MoneyTiles } from '../../components/ui.jsx';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import RichText from '../../components/RichText.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import { persistPending } from '../../lib/files/attachments.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { uuid } from '../../lib/uuid.js';
import AuditTimeline from './AuditTimeline.jsx';

const DEFAULT_AREAS = ['STP (sewage treatment)', 'WTP (water treatment)', 'Swimming pool water', 'Drinking water quality', 'Fire safety', 'Lifts', 'Electrical safety', 'DG set', 'Structural', 'Security / CCTV', 'Financial'];
const RESULTS = ['Pass', 'Pass with observations', 'Fail', 'Pending'];
const TONE = { Pass: 'green', 'Pass with observations': 'orange', Fail: 'red', Pending: '' };
const today = () => new Date().toISOString().slice(0, 10);
const dmy = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setMonth(d.getMonth() + Number(n)); return d.toISOString().slice(0, 10); };
const daysTo = (iso) => Math.round((new Date(`${iso}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000);
const params = (a) => (Array.isArray(a?.parameters) ? a.parameters : []);
const outOfRange = (p) => { const v = Number(p.value); if (p.value === '' || Number.isNaN(v)) return false; return (p.min !== '' && p.min != null && v < Number(p.min)) || (p.max !== '' && p.max != null && v > Number(p.max)); };

function dueState(last) {
  if (!last?.nextDue) return { key: 'none', text: 'No next date', tone: '' };
  const d = daysTo(last.nextDue);
  if (d < 0) return { key: 'overdue', text: `Overdue by ${-d} day${d === -1 ? '' : 's'}`, tone: 'red' };
  if (d <= 30) return { key: 'soon', text: `Due in ${d} day${d === 1 ? '' : 's'}`, tone: 'orange' };
  return { key: 'ok', text: `Next ${dmy(last.nextDue)}`, tone: 'green' };
}

const AGENCY = 'Audit / inspection agency';

function AuditForm({ record, area, areas, onClose, onSaved }) {
  const { save } = useCollection(C.AUDITS, 'Audits');
  const { records: vendors, save: saveVendor } = useCollection(C.VENDORS, 'Vendors');
  const agencies = vendors.filter((v) => v.category === AGENCY);
  const [f, setF] = useState(() => ({ area: area || '', auditDate: today(), auditor: '', result: 'Pass', score: '', findings: '', actions: '', frequencyMonths: 6, nextDue: '', visibility: 'Internal', ...(record || {}) }));
  const [ps, setPs] = useState(() => params(record).map((x) => ({ ...x })));
  const [files, setFiles] = useState(Array.isArray(record?.report) ? record.report : []);
  const [pending, setPending] = useState([]);
  const [due, setDue] = useState(!!record?.nextDue);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [id] = useState(() => record?.id || uuid());
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const nextDue = due ? f.nextDue : (Number(f.frequencyMonths) > 0 && f.auditDate ? addMonths(f.auditDate, f.frequencyMonths) : '');
  // when the same area was audited before, offer the same parameter list so results line up for comparison
  const prefill = () => { const last = areas.find((a) => a.area === f.area); setPs(params(last).map((x) => ({ ...x, value: '' }))); };
  async function submit() {
    setErr('');
    if (!String(f.area).trim()) return setErr('Say what was audited');
    if (!f.auditDate) return setErr('Enter the audit date');
    setBusy(true);
    try {
      // the auditor is a vendor record (category "Audit / inspection agency"); a new name creates one so it can be linked next time
      let vendorId = f.auditorVendorId || '';
      const name = String(f.auditor || '').trim();
      const match = agencies.find((v) => v.name.toLowerCase() === name.toLowerCase());
      if (match) vendorId = match.id;
      else if (name) {
        let created = null;
        try { created = await saveVendor({ name, category: AGENCY, contractType: 'Local / no contract', service: String(f.area).trim() }); } catch { created = null; }
        vendorId = created?.id || '';
      } else vendorId = '';
      let metas = files;
      if (pending.length) { const added = await persistPending(pending, { ownerType: 'audit', ownerId: id }); if (!added) { setBusy(false); return; } metas = [...files, ...added]; }
      const rec = await save({ ...(record || {}), ...f, auditor: name, auditorVendorId: vendorId, id, area: String(f.area).trim(), score: f.score === '' ? '' : Number(f.score), frequencyMonths: Number(f.frequencyMonths) || 0, nextDue, parameters: ps.filter((x) => String(x.name).trim()), report: metas });
      setBusy(false);
      if (rec) onSaved(rec);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={record ? 'Edit audit' : 'Record an audit'} subtitle="Every audit is kept, so results can be compared over time." onClose={onClose} wide>
      {err && <div className="notice error">{err}</div>}
      <div className="form-grid" data-testid="audit-form">
        <div className="field"><label>Audit of *</label><Combobox value={f.area} onChange={(v) => set('area', v)} options={areas.length ? [...new Set([...DEFAULT_AREAS, ...areas.map((a) => a.area)])].map((a) => ({ value: a, label: a })) : DEFAULT_AREAS.map((a) => ({ value: a, label: a }))} allowCustom placeholder="STP, pool, fire…" /></div>
        <div className="field"><label>Audit date *</label><input type="date" aria-label="Audit date" value={f.auditDate} max={today()} onChange={(e) => set('auditDate', e.target.value)} /></div>
        <div className="field"><label>Auditor / agency <small className="muted">(from Vendors · type a new name to add one)</small></label>
          <Combobox value={f.auditor} onChange={(v) => setF((x) => ({ ...x, auditor: v, auditorVendorId: agencies.find((a) => a.name === v)?.id || '' }))} allowCustom placeholder="Pick or add an agency" options={agencies.map((a) => ({ value: a.name, label: a.name, hint: a.contactPhone || a.service }))} />
          {f.auditorVendorId && <small className="muted" data-testid="auditor-linked">Linked to the vendor record{(() => { const v = agencies.find((a) => a.id === f.auditorVendorId); return v?.contactPhone ? ` · ${v.contactPhone}` : ''; })()}</small>}</div>
        <div className="field"><label>Result *</label><select aria-label="Result" value={f.result} onChange={(e) => set('result', e.target.value)}>{RESULTS.map((r) => <option key={r}>{r}</option>)}</select></div>
        <div className="field"><label>Score (optional, %)</label><input type="number" aria-label="Score" min="0" max="100" value={f.score} onChange={(e) => set('score', e.target.value)} /></div>
        <div className="field"><label>Repeat every (months)</label><input type="number" aria-label="Repeat months" min="0" value={f.frequencyMonths} onChange={(e) => set('frequencyMonths', e.target.value)} /></div>
        <div className="field"><label>Next audit due</label>
          <input type="date" aria-label="Next due" value={nextDue || ''} onChange={(e) => { setDue(true); set('nextDue', e.target.value); }} />
          <small className="muted">{due ? 'Set by hand.' : 'Worked out from the date and the repeat period.'}</small></div>
        <div className="field"><label>Show to residents</label><select aria-label="Visibility" value={f.visibility} onChange={(e) => set('visibility', e.target.value)}><option>Internal</option><option>Published</option></select></div>
      </div>
      <h4 style={{ margin: '12px 0 4px' }}>Measured parameters <small className="muted">(pH, BOD, chlorine, pressure… — compared across audits)</small></h4>
      <div data-testid="audit-params">
        {ps.map((x, i) => (
          <div key={i} className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', alignItems: 'end', marginBottom: 6 }}>
            <div className="field"><label>Parameter</label><input aria-label={`Parameter ${i + 1}`} value={x.name} onChange={(e) => setPs(ps.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} /></div>
            <div className="field"><label>Value</label><input type="number" aria-label={`Value ${i + 1}`} value={x.value} onChange={(e) => setPs(ps.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} /></div>
            <div className="field"><label>Unit</label><input aria-label={`Unit ${i + 1}`} value={x.unit || ''} onChange={(e) => setPs(ps.map((y, j) => (j === i ? { ...y, unit: e.target.value } : y)))} /></div>
            <div className="field"><label>Min</label><input type="number" aria-label={`Min ${i + 1}`} value={x.min ?? ''} onChange={(e) => setPs(ps.map((y, j) => (j === i ? { ...y, min: e.target.value } : y)))} /></div>
            <div className="field"><label>Max</label><input type="number" aria-label={`Max ${i + 1}`} value={x.max ?? ''} onChange={(e) => setPs(ps.map((y, j) => (j === i ? { ...y, max: e.target.value } : y)))} /></div>
            <button type="button" className="btn secondary sm" onClick={() => setPs(ps.filter((_, j) => j !== i))}>Remove</button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary sm" data-testid="add-param" onClick={() => setPs([...ps, { name: '', value: '', unit: '', min: '', max: '' }])}>+ Add parameter</button>
          {areas.some((a) => a.area === f.area) && <button type="button" className="btn secondary sm" data-testid="copy-params" onClick={prefill}>Use last audit’s parameters</button>}
        </div>
      </div>
      <div className="field" style={{ marginTop: 10 }}><label>Findings</label><RichTextEditor value={f.findings} onChange={(v) => set('findings', v)} placeholder="Observations, deviations, remarks…" minHeight={90} /></div>
      <div className="field" style={{ marginTop: 10 }}><label>Corrective actions</label><RichTextEditor value={f.actions} onChange={(v) => set('actions', v)} placeholder="What will be fixed, by whom, by when" minHeight={70} /></div>
      <div className="field" style={{ marginTop: 10 }}><label>Audit report &amp; lab certificates</label>
        <AttachmentList items={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
        <AttachmentPicker pending={pending} onChange={setPending} label="Add report / certificate" /></div>
      <div className="form-actions"><button className="btn" disabled={busy} data-testid="audit-save" onClick={submit}>{busy ? 'Saving…' : 'Save audit'}</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function ScoreLine({ list }) {
  // score over time for any number of audits (10 years of monthly audits is ~120 points): a single SVG line, oldest left
  const pts = [...list].filter((a) => a.score !== '' && a.score != null).sort((a, b) => String(a.auditDate).localeCompare(String(b.auditDate)));
  if (pts.length < 2) return null;
  const W = 600; const H = 90; const x = (i) => 8 + (i * (W - 16)) / (pts.length - 1); const yv = (v) => H - 8 - (Math.max(0, Math.min(100, v)) * (H - 16)) / 100;
  return (
    <div className="card" style={{ marginBottom: 10 }} data-testid="score-line"><b>Score over time</b> <small className="muted">{dmy(pts[0].auditDate)} → {dmy(pts[pts.length - 1].auditDate)} · {pts.length} audits</small>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="90" role="img" aria-label="Audit score over time" style={{ display: 'block', marginTop: 4 }}>
        <line x1="8" x2={W - 8} y1={yv(50)} y2={yv(50)} stroke="#e2e8f0" /><polyline fill="none" stroke="#2563eb" strokeWidth="2" points={pts.map((a, i) => `${x(i)},${yv(a.score)}`).join(' ')} />
        {pts.length <= 60 && pts.map((a, i) => <circle key={a.id} cx={x(i)} cy={yv(a.score)} r="3" fill={a.result === 'Fail' ? '#e5484d' : '#2563eb'}><title>{dmy(a.auditDate)}: {a.score}%</title></circle>)}
      </svg></div>
  );
}

function AreaHistory({ area, audits, canWrite, onEdit, onClose, period = '' }) {
  const [per, setPer] = useState(period);
  const [shownN, setShownN] = useState(12);
  const allRows = [...audits].filter((a) => a.area === area).sort((a, b) => String(b.auditDate).localeCompare(String(a.auditDate)));
  const yrs = [...new Set(allRows.map((a) => String(a.auditDate).slice(0, 4)))];
  const rows = allRows.filter((a) => !per || String(a.auditDate).startsWith(per));
  const recent = rows.slice(0, 6).reverse();
  const names = [...new Set(recent.flatMap((a) => params(a).map((p) => p.name)))];
  const scores = recent.filter((a) => a.score !== '' && a.score != null);
  return (
    <Modal title={`${area} · audit history`} subtitle={`${allRows.length} audit${allRows.length === 1 ? '' : 's'} on record`} onClose={onClose} wide>
      <div data-testid="area-history">
        {yrs.length > 1 && <div style={{ marginBottom: 8 }}><select aria-label="Period" data-testid="hist-year" value={per.slice(0, 4)} onChange={(e) => setPer(e.target.value)} style={{ width: 'auto' }}><option value="">All years ({allRows.length})</option>{yrs.map((v) => <option key={v} value={v}>{v} ({allRows.filter((a) => String(a.auditDate).startsWith(v)).length})</option>)}</select>{per.length > 4 && <span className="tag" style={{ marginLeft: 8 }}>{per}</span>}</div>}
        <ScoreLine list={rows} />
        {false && scores.length > 1 && (
          <div className="card" style={{ marginBottom: 10 }}><b>Score over time</b>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 70, marginTop: 6 }}>
              {scores.map((a) => <div key={a.id} title={`${dmy(a.auditDate)}: ${a.score}%`} style={{ flex: 1, textAlign: 'center' }}><div style={{ height: `${Math.max(6, a.score * 0.6)}px`, background: a.result === 'Fail' ? '#e5484d' : '#2563eb', borderRadius: 4 }} /><small className="muted">{a.score}</small></div>)}
            </div></div>
        )}
        {names.length > 0 && (
          <div className="card" style={{ marginBottom: 10, overflowX: 'auto' }}><b>Parameters across audits</b>
            <table data-keep style={{ marginTop: 6, minWidth: 360 }} data-testid="param-trend"><thead><tr><th>Parameter</th>{recent.map((a) => <th key={a.id}>{dmy(a.auditDate)}</th>)}</tr></thead>
              <tbody>{names.map((n) => (
                <tr key={n}><td><b>{n}</b></td>{recent.map((a) => { const p = params(a).find((x) => x.name === n); return <td key={a.id} style={p && outOfRange(p) ? { color: '#c7364a', fontWeight: 700 } : undefined}>{p ? `${p.value}${p.unit ? ' ' + p.unit : ''}` : '—'}</td>; })}</tr>
              ))}</tbody></table>
            <small className="muted">Values outside the allowed min / max are shown in red.</small></div>
        )}
        <ul className="list bk-list">
          {rows.slice(0, shownN).map((a) => (
            <li key={a.id} data-testid="audit-row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><b>{dmy(a.auditDate)}</b><span className={`tag ${TONE[a.result] || ''}`}>{a.result}</span>{a.score !== '' && a.score != null && <span className="tag">{a.score}%</span>}{a.visibility === 'Published' && <span className="tag blue">Published</span>}<small className="muted" style={{ flex: 1 }}>{a.auditor}</small>{canWrite && <button className="btn secondary sm" onClick={() => onEdit(a)}>Edit</button>}</div>
              {a.findings && <RichText html={a.findings} />}
              {a.actions && <div style={{ marginTop: 4 }}><b>Corrective actions</b><RichText html={a.actions} /></div>}
              {(a.report || []).length > 0 && <AttachmentList items={a.report} />}
            </li>
          ))}
        </ul>
        {rows.length > shownN && <button type="button" className="btn secondary" data-testid="hist-more" onClick={() => setShownN((n) => n + 24)}>Show more ({rows.length - shownN} older)</button>}
      </div>
    </Modal>
  );
}

export default function AuditsModule() {
  const { role, tabAllowed } = useApp();
  const { records: audits, refresh } = useCollection(C.AUDITS, 'Audits');
  const canWrite = canWriteCollection(C.AUDITS, getPrincipal());
  const [tabRaw, setTab] = useState('overview');
  const [form, setForm] = useState(null);
  const [hist, setHist] = useState(null);
  const [areaFilter, setAreaFilter] = useState('');
  const [yearF, setYearF] = useState('');
  const [monthF, setMonthF] = useState('');
  const [resultF, setResultF] = useState('');
  const [shownAll, setShownAll] = useState(40);
  const [histPeriod, setHistPeriod] = useState('');
  const [aq, setAq] = useState(''); const [aYear, setAYear] = useState(''); const [aMonth, setAMonth] = useState(''); const [aResult, setAResult] = useState(''); const [aDue, setADue] = useState('');
  useEffect(() => { try { const a = sessionStorage.getItem('communityos:openTab'); if (a === 'audits.history') { setTab('history'); sessionStorage.removeItem('communityos:openTab'); } else if (['audits.overview', 'audits.timeline'].includes(a)) { setTab(a.slice(7)); sessionStorage.removeItem('communityos:openTab'); } } catch { /* ignore */ } }, []);
  const byArea = useMemo(() => {
    const m = new Map();
    [...audits].sort((a, b) => String(b.auditDate).localeCompare(String(a.auditDate))).forEach((a) => { if (!m.has(a.area)) m.set(a.area, []); m.get(a.area).push(a); });
    return [...m.entries()].map(([area, list]) => ({ area, last: list[0], count: list.length, due: dueState(list[0]) }));
  }, [audits]);
  // "By area" filters, like the timeline: a period (year / month) shows each area's latest audit inside it
  const periodOn = !!(aYear || aMonth);
  const byAreaShown = useMemo(() => {
    const inP = (a) => (!aYear || String(a.auditDate).startsWith(aYear)) && (!aMonth || String(a.auditDate).slice(5, 7) === aMonth);
    const m = new Map();
    [...audits].filter(inP).sort((a, b) => String(b.auditDate).localeCompare(String(a.auditDate))).forEach((a) => { if (!m.has(a.area)) m.set(a.area, []); m.get(a.area).push(a); });
    return [...m.entries()].map(([area, list]) => ({ area, last: list[0], count: list.length, due: dueState(audits.filter((x) => x.area === area).sort((x, y) => String(y.auditDate).localeCompare(String(x.auditDate)))[0]) }))
      .filter((x) => (!aq || x.area.toLowerCase().includes(aq.toLowerCase())) && (!aResult || x.last.result === aResult) && (!aDue || x.due.key === aDue));
  }, [audits, aYear, aMonth, aq, aResult, aDue]);
  const overdue = byArea.filter((x) => x.due.key === 'overdue').length; const soon = byArea.filter((x) => x.due.key === 'soon').length; const fails = byArea.filter((x) => x.last.result === 'Fail').length;
  const auditYears = [...new Set(audits.map((a) => String(a.auditDate).slice(0, 4)))].sort().reverse();
  const all = [...audits].filter((a) => (!areaFilter || a.area === areaFilter) && (!yearF || String(a.auditDate).startsWith(yearF)) && (!monthF || String(a.auditDate).slice(5, 7) === monthF) && (!resultF || a.result === resultF)).sort((a, b) => String(b.auditDate).localeCompare(String(a.auditDate)));
  const resident = role?.category === 'Resident';
  const ATABS = [{ key: 'overview', label: 'By area' }, { key: 'timeline', label: 'Timeline' }, { key: 'history', label: 'All audits', count: audits.length }].filter((t) => tabAllowed(`audits.${t.key}`));
  const tab = ATABS.some((t) => t.key === tabRaw) ? tabRaw : ATABS[0]?.key;
  return (
    <div data-testid="audits-page">
      <div className="page-head"><div><h1>Audits</h1><p>{resident ? 'Results of the periodic audits the committee has published.' : 'Periodic audits of the STP, WTP, pool, fire safety and more - every result is kept so you can see how things change.'}</p></div>
        {canWrite && <button className="btn" data-testid="record-audit" onClick={() => setForm({ record: null })}>+ Record audit</button>}</div>
      {!resident && <MoneyTiles items={[
        { label: 'Areas audited', value: byArea.length }, { label: 'Overdue', value: overdue, tone: overdue ? 'red' : '' }, { label: 'Due in 30 days', value: soon, tone: soon ? 'orange' : '' }, { label: 'Last audit failed', value: fails, tone: fails ? 'red' : '' },
      ]} />}
      <SegTabs label="Audit views" value={tab} onChange={setTab} tabs={ATABS} />
      {tab === 'overview' && (byArea.length === 0 ? <div className="empty">No audits recorded yet.</div> : (<>
        <div className="exp-tools" data-testid="area-filters" style={{ marginTop: 10 }}>
          <input type="search" aria-label="Search areas" data-testid="area-q" placeholder="Search area…" value={aq} onChange={(e) => setAq(e.target.value)} />
          <select aria-label="Year" data-testid="area-year" value={aYear} onChange={(e) => setAYear(e.target.value)}><option value="">All years</option>{auditYears.map((y) => <option key={y}>{y}</option>)}</select>
          <select aria-label="Month" data-testid="area-month" value={aMonth} onChange={(e) => setAMonth(e.target.value)}><option value="">All months</option>{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select>
          <select aria-label="Result" data-testid="area-result" value={aResult} onChange={(e) => setAResult(e.target.value)}><option value="">Any result</option>{['Pass', 'Pass with observations', 'Fail', 'Pending'].map((r) => <option key={r}>{r}</option>)}</select>
          {!resident && <select aria-label="Due" data-testid="area-due" value={aDue} onChange={(e) => setADue(e.target.value)}><option value="">Any due state</option><option value="overdue">Overdue</option><option value="soon">Due in 30 days</option></select>}
          {(aq || aYear || aMonth || aResult || aDue) && <button type="button" className="btn secondary sm" data-testid="area-clear" onClick={() => { setAq(''); setAYear(''); setAMonth(''); setAResult(''); setADue(''); }}>Clear</button>}
          <span className="muted" style={{ fontSize: 12 }} data-testid="area-count">{byAreaShown.length} of {byArea.length} areas</span>
        </div>
        {byAreaShown.length === 0 && <div className="empty">No area matches these filters.</div>}
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(250px,1fr))', gap: 10, marginTop: 10 }}>
          {byAreaShown.map((x) => (
            <div key={x.area} className="card" style={{ cursor: 'pointer' }} data-testid={`area-card`} onClick={() => setHist(x.area)}>
              <b>{x.area}</b>
              <div style={{ margin: '6px 0', display: 'flex', gap: 6, flexWrap: 'wrap' }}><span className={`tag ${TONE[x.last.result] || ''}`}>{x.last.result}</span>{x.last.score !== '' && x.last.score != null && <span className="tag">{x.last.score}%</span>}{!resident && !periodOn && <span className={`tag ${x.due.tone}`}>{x.due.text}</span>}</div>
              <small className="muted">{periodOn ? 'Latest in period: ' : 'Last: '}{dmy(x.last.auditDate)}{x.last.auditor ? ` · ${x.last.auditor}` : ''}<br />{x.count} audit{x.count === 1 ? '' : 's'} on record</small>
              {params(x.last).some(outOfRange) && <div style={{ marginTop: 4 }}><small style={{ color: '#c7364a' }}>⚠ {params(x.last).filter(outOfRange).map((p) => p.name).join(', ')} out of range</small></div>}
            </div>
          ))}
        </div></>
      ))}
      {tab === 'timeline' && <AuditTimeline audits={audits} onOpen={(area, per) => { setHistPeriod(per.length > 4 ? per.slice(0, 4) : per); setHist(area); }} />}
      {tab === 'history' && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="exp-tools"><select aria-label="Area" value={areaFilter} onChange={(e) => { setAreaFilter(e.target.value); setShownAll(40); }} style={{ width: 'auto' }}><option value="">All areas</option>{byArea.map((x) => <option key={x.area}>{x.area}</option>)}</select>
            <select aria-label="Year" data-testid="aud-year" value={yearF} onChange={(e) => { setYearF(e.target.value); setShownAll(40); }} style={{ width: 'auto' }}><option value="">All years</option>{auditYears.map((v) => <option key={v}>{v}</option>)}</select>
            <select aria-label="Month" data-testid="aud-month" value={monthF} onChange={(e) => { setMonthF(e.target.value); setShownAll(40); }} style={{ width: 'auto' }}><option value="">All months</option>{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select>
            <select aria-label="Result" data-testid="aud-result" value={resultF} onChange={(e) => { setResultF(e.target.value); setShownAll(40); }} style={{ width: 'auto' }}><option value="">All results</option>{RESULTS.map((r) => <option key={r}>{r}</option>)}</select></div>
          <div className="muted" style={{ fontSize: 13 }}>{all.length} audit{all.length === 1 ? '' : 's'}</div>
          <table className="resp-table" style={{ marginTop: 8 }} data-testid="audit-table"><thead><tr><th>Date</th><th>Audit of</th><th>Result</th><th>Score</th><th>Auditor</th><th>Next due</th></tr></thead>
            <tbody>{all.slice(0, shownAll).map((a) => <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => setHist(a.area)}><td data-label="Date">{dmy(a.auditDate)}</td><td data-label="Audit of"><b>{a.area}</b></td><td data-label="Result"><span className={`tag ${TONE[a.result] || ''}`}>{a.result}</span></td><td data-label="Score">{a.score ?? ''}</td><td data-label="Auditor">{a.auditor}</td><td data-label="Next due">{dmy(a.nextDue)}</td></tr>)}</tbody></table>
          {all.length > shownAll && <button type="button" className="btn secondary" data-testid="aud-more" style={{ marginTop: 8 }} onClick={() => setShownAll((n) => n + 60)}>Show more ({all.length - shownAll} older)</button>}
        </div>
      )}
      {hist && <AreaHistory period={histPeriod} area={hist} audits={audits} canWrite={canWrite} onEdit={(a) => { setHist(null); setForm({ record: a }); }} onClose={() => { setHist(null); setHistPeriod(''); }} />}
      {form && <AuditForm record={form.record} area={form.area} areas={audits} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh?.(); }} />}
    </div>
  );
}
