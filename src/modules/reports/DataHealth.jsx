import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { analyze, summarize, KINDS, COLLECTION_KEYS } from '../../lib/dataHealth.js';
import { Chips } from '../gate/gateUi.jsx';
import RecordModal from '../billing/RecordModal.jsx';

const TONE = { 'Broken link': 'gg-tag-coral', Missing: 'orange', Mismatch: 'orange', Stale: 'blue' };
export async function loadHealth() {
  const D = {};
  await Promise.all(Object.entries(COLLECTION_KEYS).map(async ([k, c]) => { try { D[k] = await secureStorage.list(c); } catch { D[k] = []; } }));
  return analyze(D);
}

/** Where the data disagrees with itself: dangling links, missing essentials, records nobody has touched. Run on demand and on opening. */
export default function DataHealth() {
  const [review, setReview] = useState(null); const [gone, setGone] = useState('');
  const [issues, setIssues] = useState(null); const [kind, setKind] = useState([]); const [area, setArea] = useState('');
  const run = useCallback(async () => { setIssues(null); setIssues(await loadHealth()); }, []);
  useEffect(() => { run(); }, [run]);
  const open = async (i) => {
    setGone(''); const t = i.target; if (!t) return;
    const col = COLLECTION_KEYS[t.collection] || t.collection;
    if (col === 'tickets') { window.dispatchEvent(new CustomEvent('communityos:openlink', { detail: { link: `#/ticket/${t.id}` } })); return; }
    const rec = (await secureStorage.list(col).catch(() => [])).find((r) => r.id === t.id);
    if (!rec) { setGone('That record no longer exists. Check again to refresh the list.'); return; }
    setReview({ col, rec });
  };
  const areas = useMemo(() => [...new Set((issues || []).map((i) => i.area))].sort(), [issues]);
  if (!issues) return <div className="empty">Checking…</div>;
  const shown = issues.filter((i) => (!kind.length || kind.includes(i.kind)) && (!area || i.area === area));
  const csv = () => { const rows = [['Area', 'Kind', 'Finding', 'Detail'], ...shown.map((i) => [i.area, i.kind, i.title, i.detail])]; const t = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'data-health.csv'; a.click(); };
  return (
    <div data-testid="data-health">
      <p className="muted">Checks that the records agree with each other: a task that points at an asset that is gone, an asset with no kind of repair, a person still Active with an expired certificate, work nobody has touched for a month.</p>
      <div className="gg-kpis">{summarize(issues).map((s) => <div key={s.kind} className={`gg-kpi${s.count && s.kind !== 'Stale' ? ' warn' : ''}`}><span className="muted">{s.kind}</span><b data-testid={`health-${s.kind}`}>{s.count}</b></div>)}</div>
      <div className="gg-row" style={{ margin: '10px 0' }}>
        <Chips multi options={KINDS} value={kind} onChange={setKind} label="Kind" />
        <select aria-label="Area" value={area} onChange={(e) => setArea(e.target.value)} style={{ width: 'auto' }}><option value="">All areas</option>{areas.map((a) => <option key={a}>{a}</option>)}</select>
        <button type="button" className="btn secondary" onClick={run}>Check again</button>
        <button type="button" className="btn secondary" onClick={csv} disabled={!shown.length}>Download</button>
      </div>
      {shown.length === 0 ? <div className="empty" data-testid="health-clean">{issues.length ? 'Nothing matches this filter.' : 'Everything lines up. Nothing to fix.'}</div> : (
        <ul className="list" style={{ display: 'block' }}>{shown.slice(0, 300).map((i) => (
          <li key={i.id} data-testid="health-row" style={{ display: 'block', padding: '10px 0' }}>
            <span className={`tag ${TONE[i.kind]}`}>{i.kind}</span> <small className="muted">{i.area}</small>
            <div><b>{i.title}</b></div>{i.detail && <small className="muted">{i.detail}</small>}
            {i.target && <div style={{ marginTop: 4 }}><button type="button" className="btn secondary sm" data-testid="health-open" onClick={() => open(i)}>{COLLECTION_KEYS[i.target.collection] === 'tickets' ? 'Open task' : 'Review record'}</button></div>}
          </li>))}</ul>
      )}
      {gone && <div className="notice error" role="alert">{gone}</div>}
      {review && <RecordModal collection={review.col} label={review.col} record={review.rec} title="Review record" subtitle="Fix it here, then Check again." onClose={() => setReview(null)} onSaved={() => run()} />}
      {shown.length > 300 && <small className="muted">Showing the first 300 of {shown.length}. Narrow the filter or download the list.</small>}
    </div>
  );
}
