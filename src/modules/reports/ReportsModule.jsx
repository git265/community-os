import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { SegTabs } from '../../components/ui.jsx';
import DataHealth from './DataHealth.jsx';
import GstReport from './GstReport.jsx';
import Modal from '../../components/Modal.jsx';
import { saveXlsx } from '../../components/ExportIcon.jsx';
import AudiencePicker from '../communications/AudiencePicker.jsx';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { uuid } from '../../lib/uuid.js';
import { REPORTS, reportOf, defOf, PERIODS, FORMATS, CHANNEL_CHOICES, columnsOf, CUSTOM_SOURCES, FILTER_OPS } from '../../lib/reports/catalog.js';
import { FREQUENCIES, WEEKDAYS, AUDIENCES, audienceText, runSchedule, previewSchedule } from '../../lib/reports/run.js';
import PageActions from '../../components/PageActions.jsx';

const when = (s) => (s.frequency === 'Weekly' ? `Every ${s.weekday || 'Monday'}` : s.frequency === 'Monthly' ? `Monthly on day ${s.monthDay || 1}` : 'Every day') + ` at ${s.time || '08:00'}`;
const stamp = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const csvOf = (cols, rows) => [cols, ...rows].map((r) => r.map((x) => `"${String(x ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

function ReportTable({ columns, rows }) {
  if (!rows.length) return <div className="empty">Nothing to report.</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="resp-table" data-testid="report-table"><thead><tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
        <tbody>{rows.slice(0, 200).map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j} data-label={columns[j]}>{typeof x === 'number' ? x.toLocaleString('en-IN') : String(x ?? '')}</td>)}</tr>)}</tbody></table>
      {rows.length > 200 && <small className="muted">Showing 200 of {rows.length} lines. Download for the full table.</small>}
    </div>
  );
}

function Viewer({ run, onClose }) {
  const rows = useMemo(() => { try { return JSON.parse(run.rows || '[]'); } catch { return []; } }, [run]);
  const cols = run.columns || [];
  return (
    <Modal title={run.title} subtitle={`${run.name} · ${stamp(run.runAt)}`} onClose={onClose} wide>
      <div data-testid="run-view">
        <ul style={{ margin: '0 0 10px', paddingLeft: 18 }}>{String(run.summary || '').split('\n').map((l, i) => <li key={i}>{l}</li>)}</ul>
        <ReportTable columns={cols} rows={rows} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn secondary sm" data-testid="dl-xlsx" onClick={() => saveXlsx(cols, rows, run.name)}>Download Excel</button>
          <button className="btn secondary sm" data-testid="dl-csv" onClick={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csvOf(cols, rows)], { type: 'text/csv' })); a.download = `${run.name.replace(/[^\w.-]+/g, '_')}.csv`; a.click(); }}>Download CSV</button>
          <button className="btn secondary sm" onClick={() => window.print()}>Print</button>
        </div>
        <small className="muted" style={{ display: 'block', marginTop: 8 }}>Sent to: {run.sentTo}</small>
      </div>
    </Modal>
  );
}


const parseJ = (c) => { if (!c) return {}; if (typeof c === 'object') return c; try { return JSON.parse(c); } catch { return {}; } };

/** The no-code report builder: choose a list, its columns, filters, sorting and grouping. */
function CustomBuilder({ spec, setSpec }) {
  const { schemaFor } = useApp();
  const sources = CUSTOM_SOURCES.map((c) => ({ id: c, label: schemaFor(c)?.label || c })).sort((a, b) => a.label.localeCompare(b.label));
  const fields = spec.source ? (schemaFor(spec.source)?.fields || []) : [];
  const upd = (patch) => setSpec((x) => ({ ...x, ...patch }));
  const pickSource = (id) => { const fs = schemaFor(id)?.fields || []; const vis = fs.filter((f) => !f.hidden); const shown = (vis.filter((f) => f.showInTable).length ? vis.filter((f) => f.showInTable) : vis).slice(0, 6); setSpec({ source: id, labels: Object.fromEntries(fs.map((f) => [f.key, f.label])), dates: fs.filter((f) => f.type === 'date').map((f) => f.key), numeric: fs.filter((f) => f.type === 'number').map((f) => f.key), dateField: fs.find((f) => f.type === 'date')?.key || '', columns: shown.map((f) => f.key), filters: [], sortBy: '', sortDir: 'asc', groupBy: '', measure: 'count', measureField: '', title: sources.find((x) => x.id === id)?.label || '' }); };
  const cols = spec.columns || [];
  const flt = spec.filters || [];
  const setF = (i, patch) => upd({ filters: flt.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const sel = (v, on, opts, ph) => <select value={v || ''} onChange={(e) => on(e.target.value)}>{ph != null && <option value="">{ph}</option>}{opts.map((o) => <option key={o.key ?? o} value={o.key ?? o}>{o.label ?? o}</option>)}</select>;
  return (
    <div className="card" style={{ padding: 12, marginTop: 10 }} data-testid="custom-builder">
      <b>Build your report</b>
      <div className="form-grid" style={{ marginTop: 8 }}>
        <div className="field"><label>Report from</label><select aria-label="Report from" data-testid="cb-source" value={spec.source || ''} onChange={(e) => pickSource(e.target.value)}><option value="">Choose a list…</option>{sources.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</select></div>
        <div className="field"><label>Title</label><input aria-label="Report title" value={spec.title || ''} onChange={(e) => upd({ title: e.target.value })} /></div>
        {spec.source && <div className="field"><label>Date used for “Covers”</label>{sel(spec.dateField, (v) => upd({ dateField: v }), fields.filter((f) => f.type === 'date').map((f) => ({ key: f.key, label: f.label })), 'No date')}</div>}
      </div>
      {spec.source && (<>
        <div className="field" style={{ marginTop: 10 }}><label>Columns</label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>{fields.map((f) => <label key={f.key} style={{ display: 'flex', gap: 4, alignItems: 'center' }}><input type="checkbox" data-testid={`cb-col-${f.key}`} checked={cols.includes(f.key)} onChange={() => upd({ columns: cols.includes(f.key) ? cols.filter((x) => x !== f.key) : fields.map((x) => x.key).filter((k) => k === f.key || cols.includes(k)) })} />{f.label}</label>)}</div></div>
        <div className="field" style={{ marginTop: 10 }}><label>Only include rows where</label>
          {flt.map((f, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }} data-testid="cb-filter">
              {sel(f.field, (v) => setF(i, { field: v }), fields.map((x) => ({ key: x.key, label: x.label })), 'Field…')}
              {sel(f.op || 'is', (v) => setF(i, { op: v }), FILTER_OPS)}
              {!['empty', 'not empty'].includes(f.op) && <input aria-label="Value" placeholder="value (or @today)" value={f.value || ''} onChange={(e) => setF(i, { value: e.target.value })} style={{ width: 160 }} />}
              <button type="button" className="btn secondary sm" onClick={() => upd({ filters: flt.filter((_, j) => j !== i) })}>Remove</button>
            </div>))}
          <button type="button" className="btn secondary sm" data-testid="cb-add-filter" onClick={() => upd({ filters: [...flt, { field: '', op: 'is', value: '' }] })}>+ Add a condition</button></div>
        <div className="form-grid" style={{ marginTop: 10 }}>
          <div className="field"><label>Sort by</label><div style={{ display: 'flex', gap: 6 }}>{sel(spec.sortBy, (v) => upd({ sortBy: v }), fields.map((x) => ({ key: x.key, label: x.label })), 'No sorting')}{sel(spec.sortDir || 'asc', (v) => upd({ sortDir: v }), [{ key: 'asc', label: 'A→Z / old→new' }, { key: 'desc', label: 'Z→A / new→old' }])}</div></div>
          <div className="field"><label>Group by (optional)</label>{sel(spec.groupBy, (v) => upd({ groupBy: v }), fields.map((x) => ({ key: x.key, label: x.label })), 'No grouping — list each row')}</div>
          {spec.groupBy && <div className="field"><label>Show</label><div style={{ display: 'flex', gap: 6 }}>{sel(spec.measure || 'count', (v) => upd({ measure: v }), [{ key: 'count', label: 'Count only' }, { key: 'sum', label: 'Total of' }, { key: 'avg', label: 'Average of' }])}{(spec.measure === 'sum' || spec.measure === 'avg') && sel(spec.measureField, (v) => upd({ measureField: v }), fields.filter((f) => f.type === 'number').map((x) => ({ key: x.key, label: x.label })), 'Number field…')}</div></div>}
        </div>
      </>)}
    </div>
  );
}

function Editor({ record, onClose }) {
  const { roles } = useApp();
  const { save } = useCollection(C.REPORT_SCHEDULES, 'Scheduled reports');
  const { records: properties } = useCollection(C.PROPERTIES, 'Properties');
  const { records: users } = useCollection(C.USERS, 'Users');
  const [f, setF] = useState(() => ({ name: '', reportType: 'bookings', period: '', format: 'Detailed', frequency: 'Daily', time: '08:00', weekday: 'Monday', monthDay: 1, channels: ['In-app'], audience: 'Roles', roleIds: [], units: [], people: [], extra: '', skipEmpty: false, active: true, showCols: [], showTax: true, showTotals: false, showSummary: true, intro: '', footer: '', ...(record || {}), custom: parseJ(record?.custom) }));
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const def = defOf(f);
  const isCustom = f.reportType === 'custom';
  const setSpec = (fn) => setF((x) => ({ ...x, custom: typeof fn === 'function' ? fn(x.custom || {}) : fn }));
  const period = f.period && def.periods.includes(f.period) ? f.period : def.defaultPeriod;
  const cinfo = useMemo(() => columnsOf(def), [def]);
  const shownCols = f.showCols.length ? f.showCols : cinfo.columns;
  const toggleCol = (c) => set('showCols', shownCols.includes(c) ? shownCols.filter((x) => x !== c) : cinfo.columns.filter((x) => x === c || shownCols.includes(x)));
  const toggle = (k, v) => set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v]);
  const staffRoles = roles.filter((r) => r.category !== 'Resident');
  async function submit() {
    setErr('');
    if (!f.name.trim()) return setErr('Give the report a name');
    if (!f.channels.length) return setErr('Choose at least one way to deliver it');
    const nobody = (f.audience === 'Roles' && !f.roleIds.length) || (f.audience === 'People' && !f.people.length) || (f.audience === 'Selected villas' && !f.units.length);
    if (nobody && !String(f.extra).trim()) return setErr('Choose who should receive it');
    const now = new Date().toISOString();
    if (isCustom && !f.custom?.source) return setErr('Choose which list the report is built from');
    await save({ ...(record || { id: uuid(), recordCreatedAt: now }), ...f, custom: isCustom ? JSON.stringify(f.custom) : '', period, lastRunKey: record?.lastRunKey || '', lastUpdatedAt: now });
    onClose();
  }
  return (
    <Modal title={record ? 'Edit scheduled report' : 'New scheduled report'} onClose={onClose} wide>
      <div className="form-grid" data-testid="report-editor">
        <div className="field"><label>Name</label><input aria-label="Report name" data-testid="rep-name" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Daily bookings" /></div>
        <div className="field"><label>Report</label>
          <select aria-label="Report" data-testid="rep-type" value={f.reportType} onChange={(e) => setF((x) => ({ ...x, reportType: e.target.value, period: '', showCols: [] }))}>{REPORTS.map((r) => <option key={r.id} value={r.id}>{r.group} · {r.label}</option>)}<option value="custom">Custom · build your own</option></select>
          <small className="muted">{def.blurb}</small></div>
        {def.periods.length > 1 && <div className="field"><label>Covers</label><select aria-label="Covers" value={period} onChange={(e) => set('period', e.target.value)}>{def.periods.map((p) => <option key={p} value={p}>{isCustom && p === 'asof' ? 'All dates (no date filter)' : PERIODS[p].label}</option>)}</select></div>}
        <div className="field"><label>Format</label><select aria-label="Format" data-testid="rep-format" value={f.format} onChange={(e) => set('format', e.target.value)}>{FORMATS.map((x) => <option key={x.id} value={x.id}>{x.id} — {x.help}</option>)}</select></div>
        <div className="field"><label>How often</label><select aria-label="How often" data-testid="rep-freq" value={f.frequency} onChange={(e) => set('frequency', e.target.value)}>{FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select></div>
        {f.frequency === 'Weekly' && <div className="field"><label>Day</label><select aria-label="Day of the week" value={f.weekday} onChange={(e) => set('weekday', e.target.value)}>{WEEKDAYS.map((x) => <option key={x}>{x}</option>)}</select></div>}
        {f.frequency === 'Monthly' && <div className="field"><label>Day of the month</label><input type="number" min="1" max="31" aria-label="Day of the month" value={f.monthDay} onChange={(e) => set('monthDay', Number(e.target.value))} /></div>}
        <div className="field"><label>Time</label><input type="time" aria-label="Time" data-testid="rep-time" value={f.time} onChange={(e) => set('time', e.target.value)} /></div>
      </div>
      {isCustom && <CustomBuilder spec={f.custom || {}} setSpec={setSpec} />}
      <div className="field" style={{ marginTop: 10 }} data-testid="rep-content"><label>{isCustom ? 'Extras' : 'What to show'}</label>
        {!isCustom && <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{cinfo.columns.map((c) => <label key={c} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" data-testid={`rep-col-${c}`} checked={shownCols.includes(c)} onChange={() => toggleCol(c)} />{c}</label>)}</div>}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
          {def.taxAware && <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" data-testid="rep-tax" checked={f.showTax !== false} onChange={(e) => set('showTax', e.target.checked)} />Show tax (GST) where applicable</label>}
          {cinfo.money && <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" data-testid="rep-totals" checked={!!f.showTotals} onChange={(e) => set('showTotals', e.target.checked)} />Add a totals row</label>}
          <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" checked={f.showSummary !== false} onChange={(e) => set('showSummary', e.target.checked)} />Show key numbers</label></div>
        <input aria-label="Opening text" data-testid="rep-intro" style={{ marginTop: 6 }} placeholder="Opening line (optional), e.g. Dear committee," value={f.intro} onChange={(e) => set('intro', e.target.value)} />
        <input aria-label="Closing text" style={{ marginTop: 6 }} placeholder="Closing line (optional), e.g. Regards, Facility Office" value={f.footer} onChange={(e) => set('footer', e.target.value)} /></div>
      <div className="field" style={{ marginTop: 10 }}><label>Deliver by</label>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>{CHANNEL_CHOICES.map((c) => <label key={c} style={{ display: 'flex', gap: 5, alignItems: 'center' }}><input type="checkbox" data-testid={`rep-ch-${c}`} checked={f.channels.includes(c)} onChange={() => toggle('channels', c)} />{c}</label>)}</div>
        <small className="muted">E-mail, WhatsApp and SMS are queued in the outbox until a gateway is connected.</small></div>
      <div className="field" style={{ marginTop: 10 }}><label>To</label>
        <select aria-label="Audience" data-testid="rep-audience" value={f.audience} onChange={(e) => set('audience', e.target.value)}>{AUDIENCES.map((a) => <option key={a}>{a}</option>)}</select></div>
      {f.audience === 'Roles' && <div className="card" style={{ padding: 10, marginTop: 8, maxHeight: 220, overflow: 'auto' }} data-testid="rep-roles">{staffRoles.map((r) => <label key={r.id} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' }}><input type="checkbox" checked={f.roleIds.includes(r.id)} onChange={() => toggle('roleIds', r.id)} />{r.name}</label>)}</div>}
      {f.audience === 'People' && <div className="card" style={{ padding: 10, marginTop: 8, maxHeight: 220, overflow: 'auto' }}>{[...new Set(users.filter((u) => u.status !== 'Inactive').map((u) => u.name))].sort().map((n) => <label key={n} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '3px 0' }}><input type="checkbox" checked={f.people.includes(n)} onChange={() => toggle('people', n)} />{n}</label>)}</div>}
      {f.audience === 'Selected villas' && <AudiencePicker kind="Villa" properties={properties} value={f.units} onChange={(v) => set('units', v)} />}
      {f.audience === 'All villas' && <small className="muted" style={{ display: 'block', marginTop: 6 }}>{def.perUnit ? 'Each villa receives only its own lines (villas with nothing to show are skipped).' : 'Every villa receives the same report.'}</small>}
      <div className="field" style={{ marginTop: 10 }}><label>Other e-mails or phone numbers (optional)</label><input aria-label="Other recipients" value={f.extra} onChange={(e) => set('extra', e.target.value)} placeholder="a@x.com, +91 98xxxxxx" /></div>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 10 }}><input type="checkbox" checked={!!f.skipEmpty} onChange={(e) => set('skipEmpty', e.target.checked)} />Do not send when there is nothing to report</label>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}><input type="checkbox" checked={!!f.active} onChange={(e) => set('active', e.target.checked)} />Switched on</label>
      {err && <div className="form-error" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}><button className="btn" data-testid="rep-save" onClick={submit}>Save</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

export default function ReportsModule() {
  const { tabAllowed } = useApp();
  useEffect(() => { try { const a = sessionStorage.getItem('communityos:openTab'); if (a === 'reports.health') { setTab('health'); sessionStorage.removeItem('communityos:openTab'); } } catch { /* ignore */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { records: schedules } = useCollection(C.REPORT_SCHEDULES, 'Scheduled reports');
  const { records: runsRaw } = useCollection(C.REPORT_RUNS, 'Sent reports');
  const canWrite = canWriteCollection(C.REPORT_SCHEDULES, getPrincipal());
  const [tab, setTab] = useState('scheduled');
  const [edit, setEdit] = useState(null);
  const [view, setView] = useState(null);
  const [prev, setPrev] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const { save, remove } = useCollection(C.REPORT_SCHEDULES, 'Scheduled reports');
  const runs = useMemo(() => [...runsRaw].sort((a, b) => String(b.runAt).localeCompare(String(a.runAt))), [runsRaw]);
  async function runNow(s) { setBusy(s.id); setMsg(''); try { const r = await runSchedule(s, { manual: true, by: getPrincipal()?.name || 'Report' }); setMsg(`${s.name}: sent to ${r.sentTo}.`); } finally { setBusy(''); } }
  async function preview(s) { const { rep } = await previewSchedule(s); setPrev({ name: s.name, rep }); }
  return (
    <div data-testid="reports-page">
      <div className="page-head"><div><h1>Reports</h1><p>Pick a report, how it looks, how often it goes out, how it is delivered and to whom — a committee, a few people or every villa.</p></div>
        {canWrite && <button className="btn" data-testid="new-report" onClick={() => setEdit({ record: null })}>+ New report</button>}</div>
      <SegTabs label="Report views" value={tab} onChange={setTab} tabs={[{ key: 'scheduled', label: 'Scheduled', count: schedules.length }, { key: 'sent', label: 'Sent' }, { key: 'gst', label: 'GST report', hidden: !tabAllowed('reports.gst') }, { key: 'health', label: 'Data health', hidden: !tabAllowed('reports.health') }]} />
      {msg && <div className="card" style={{ marginTop: 8 }} data-testid="rep-msg">{msg}</div>}
      {tab === 'scheduled' && (schedules.length === 0 ? <div className="empty">No scheduled reports yet.</div> : (
        <ul className="list" style={{ marginTop: 10 }}>
          {schedules.map((s) => (
            <li key={s.id} data-testid="sched-row" style={{ display: 'block' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <b>{s.name}</b><span className={`tag ${s.active ? 'green' : ''}`}>{s.active ? 'On' : 'Off'}</span><span className="tag">{s.format}</span>
              </div>
              <small className="muted" style={{ display: 'block', margin: '4px 0' }}>{s.reportType === 'custom' ? 'Custom report' : reportOf(s.reportType)?.label} · {when(s)} · {(s.channels || []).join(', ')} · to {s.audience === 'Roles' ? `${(s.roleIds || []).length} roles` : audienceText(s)}{s.lastRunKey ? ` · last ${s.lastRunKey}` : ''}</small>
              <PageActions keep={1} inline>
                <button className="btn secondary sm" onClick={() => preview(s)}>Preview</button>
                {canWrite && <><button className="btn secondary sm" data-testid="run-now" disabled={busy === s.id} onClick={() => runNow(s)}>{busy === s.id ? 'Sending…' : 'Send now'}</button>
                  <button className="btn secondary sm" onClick={() => save({ ...s, active: !s.active })}>{s.active ? 'Switch off' : 'Switch on'}</button>
                  <button className="btn secondary sm" onClick={() => setEdit({ record: s })}>Edit</button>
                  <button className="btn secondary sm" onClick={() => { if (window.confirm(`Delete "${s.name}"?`)) remove(s.id); }}>Delete</button></>}
              </PageActions>
            </li>
          ))}
        </ul>
      ))}
      {tab === 'gst' && <GstReport />}
      {tab === 'health' && <DataHealth />}
      {tab === 'sent' && (runs.length === 0 ? <div className="empty">Nothing has been sent yet.</div> : (
        <ul className="list" style={{ marginTop: 10 }}>
          {runs.slice(0, 100).map((r) => (
            <li key={r.id} data-testid="run-row" style={{ display: 'block', cursor: 'pointer' }} onClick={() => setView(r)}>
              <b>{r.name}</b> <small className="muted">· {stamp(r.runAt)}</small>
              <div className="muted" style={{ fontSize: 13 }}>{String(r.summary || '').split('\n')[0]}</div>
              <small className="muted">{r.sentTo}</small>
            </li>
          ))}
        </ul>
      ))}
      {edit && <Editor record={edit.record} onClose={() => setEdit(null)} />}
      {view && <Viewer run={view} onClose={() => setView(null)} />}
      {prev && <Modal title={prev.rep.title} subtitle={`Preview · ${prev.name}`} onClose={() => setPrev(null)} wide><ul style={{ paddingLeft: 18 }}>{prev.rep.lines.map((l, i) => <li key={i}>{l}</li>)}</ul><ReportTable columns={prev.rep.columns} rows={prev.rep.rows} /></Modal>}
    </div>
  );
}
