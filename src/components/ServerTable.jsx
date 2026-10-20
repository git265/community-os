import { statusify } from './StatusTag.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../context/AppContext.jsx';
import { secureStorage } from '../lib/storage/secureStorage.js';
import { canView } from '../lib/access/permissions.js';
import { DEFAULT_PAGE_SIZE } from '../lib/storage/queryEngine.js';
import { htmlToText } from '../lib/richtext/sanitize.js';
import { ExportIcon } from './ExportIcon.jsx';

/**
 * THE generic list/table used across the portal.
 *
 * "Server-side" by contract: it never loads a collection - it asks
 * secureStorage.query() for ONE page (default 50 rows) with the current
 * sort / filters / search / date range, so it works unchanged against the
 * Spring Boot `/query` endpoint (see ApiStorageAdapter.query). Authorization
 * (row scope + field masking) is applied inside that call.
 *
 * Props
 *  collection      storage collection id
 *  schema          section schema (columns default to fields with showInTable that the role can view)
 *  columns         optional [{ key, label, render(row), sortable=true, className }]
 *  filters         [{ key, label, options? }]   dropdown per field (options default to schema select options)
 *  dateFields      [{ key, label }]             enables the date-range filter (first one is default)
 *  baseFilters     fixed filters always applied (e.g. { unit })
 *  baseSort        { key, dir } initial sort
 *  search          show search box (default true) / searchKeys limit it
 *  showId          add an ID column
 *  onRowClick      (row) => void
 *  transformRows   (rows) => rows   post-process the fetched page (e.g. hide task types)
 *  rowClassName    (row) => string
 */
export default function ServerTable({
  collection, schema, columns, filters = [], dateFields = [], baseFilters, baseSort = null,
  search = true, searchKeys, showId = false, onRowClick, transformRows, rowClassName,
  pageSizeDefault = DEFAULT_PAGE_SIZE, emptyText = 'No records found.', toolbarExtra, consumeNavSearch = false, compact = false, resetToken = 0, externalDateRange = null, periodFilter = null, cardRender: cardRenderProp = null, cardSorts = null, autoCards = true, cardsAlways = false,
}) {
  // on a phone a list of CARDS reads better than a wide table (cardRender(row) draws one card)
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 900px)');
    const h = (e) => setNarrow(e.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  const asCards = (cardsAlways || narrow) && (!!cardRenderProp || autoCards);
  const { roleId, currentUser, roles = [], schemaFor } = useApp();
  // infinite scroll: rows are fetched a page at a time (pageSize) as the reader nears the end; there is no pager.
  const pageSize = pageSizeDefault;
  const pageRef = useRef(1);
  const sentinel = useRef(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sort, setSort] = useState(baseSort);
  const [fvals, setFvals] = useState({});
  // A page we navigated from (e.g. Properties -> Tickets for one villa) can leave a one-shot search term.
  const navSearch = useRef(null);
  if (navSearch.current === null) {
    navSearch.current = '';
    if (consumeNavSearch) {
      try {
        const raw = JSON.parse(sessionStorage.getItem('communityos:navSearch') || 'null');
        sessionStorage.removeItem('communityos:navSearch');
        if (raw && Date.now() - raw.at < 8000) navSearch.current = raw.q;
      } catch { /* ignore */ }
    }
  }
  const [text, setText] = useState(navSearch.current);
  const [q, setQ] = useState(navSearch.current);
  const [showFilters, setShowFilters] = useState(false);
  const [dateKey, setDateKey] = useState(dateFields[0]?.key ?? '');
  const [pYear, setPYear] = useState('');
  const [pMonth, setPMonth] = useState('');
  const [years, setYears] = useState([]);
  // Date range: when the data spans several years the range is picked from Year / Month dropdowns (custom dates stay available)
  const [dY, setDY] = useState('');
  const [dM, setDM] = useState('');
  const [dateYears, setDateYears] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState({ rows: [], total: 0, approx: false });
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);
  const lastParams = useRef(null);

  const cols = useMemo(() => {
    const base = columns ?? (schema?.fields ?? []).filter((f) => f.showInTable && canView(f, roleId)).map((f) => ({ key: f.key, label: f.label }));
    return showId ? [{ key: 'shortId', label: 'ID', className: 'mono' }, ...base] : base;
  }, [columns, schema, roleId, showId]);

  // debounce free-text search
  useEffect(() => {
    const t = setTimeout(() => { setQ(text); }, 250);
    return () => clearTimeout(t);
  }, [text]);

  const baseKey = JSON.stringify(baseFilters ?? {});
  const buildParams = () => {
    const merged = { ...(baseFilters ?? {}) };
    Object.entries(fvals).forEach(([k, v]) => { if (v) merged[k] = v; });
    return {
      sort: sort ?? undefined, filters: merged, search: q, searchKeys,
      period: periodFilter && (pYear || pMonth) ? { key: periodFilter.key, year: pYear, month: pMonth } : undefined,
      dateRange: dateKey && (from || to) ? { key: dateKey, from, to } : (externalDateRange && (externalDateRange.from || externalDateRange.to) ? externalDateRange : undefined),
    };
  };
  /** (Re)load from the top: a new search / filter / sort starts over at page 1; a data change refreshes what is already on screen. */
  const load = useCallback(async (keep = false) => {
    const id = ++reqId.current;
    setLoading(true);
    const params = buildParams();
    lastParams.current = params;
    if (!keep) pageRef.current = 1;
    const res = await secureStorage.query(collection, { ...params, page: 1, pageSize: pageSize * pageRef.current });
    if (id !== reqId.current) return; // stale response
    setResult({ rows: res.rows, total: res.total, approx: !!res.approx });
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, pageSize, sort, fvals, q, dateKey, from, to, pYear, pMonth, baseKey, externalDateRange?.from, externalDateRange?.to, roleId, currentUser?.unit]);

  /** Next page, appended below what is already shown. */
  const loadMore = useCallback(async () => {
    if (loading || loadingMore || result.rows.length >= result.total) return;
    const id = reqId.current;
    setLoadingMore(true);
    const next = pageRef.current + 1;
    const res = await secureStorage.query(collection, { ...(lastParams.current || buildParams()), page: next, pageSize });
    setLoadingMore(false);
    if (id !== reqId.current) return;
    pageRef.current = next;
    setResult((r) => ({ rows: [...r.rows, ...res.rows.filter((x) => !r.rows.some((y) => y.id === x.id))], total: res.total, approx: !!res.approx }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, pageSize, loading, loadingMore, result.rows.length, result.total]);

  useEffect(() => { load(); }, [load]);
  // reaching the end of the list asks for the next page
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) loadMore(); }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, result.rows.length]);
  // Dropdowns whose field has no fixed option list (free text like generator, month) offer the values of the rows already loaded in this table,
  // and the year dropdowns offer the last years. Nothing extra is downloaded for them: until round 76 each of these read the WHOLE collection,
  // which on the audit trail or a big ledger is exactly the download paging exists to avoid.
  const needDerive = filters.filter((f) => !f.options && !schema?.fields.find((sf) => sf.key === f.key)?.options).map((f) => f.key).join('|');
  const seenValues = useRef({});
  const derived = useMemo(() => {
    if (!needDerive) return {};
    const out = {};
    for (const k of needDerive.split('|')) {
      const seen = (seenValues.current[k] ||= new Set());
      result.rows.forEach((r) => { const v = r[k]; if (v !== undefined && v !== null && v !== '') seen.add(String(v)); });
      out[k] = [...seen].sort().reverse();
    }
    return out;
  }, [needDerive, result.rows]);
  useEffect(() => { seenValues.current = {}; }, [collection]);
  useEffect(() => {
    const now = new Date().getFullYear();
    const span = Array.from({ length: 16 }, (_, i) => String(now + 1 - i));   // next year back to 15 years ago
    if (periodFilter) setYears(span);
    if (dateKey) setDateYears(span);
  }, [periodFilter?.key, dateKey]);
  function applyDp(y, m) {
    setDY(y); setDM(m);
    if (y === 'custom') return;
    if (!y) { setFrom(''); setTo(''); return; }
    if (!m) { setFrom(`${y}-01-01`); setTo(`${y}-12-31`); return; }
    const last = new Date(Number(y), Number(m), 0).getDate();
    setFrom(`${y}-${m}-01`); setTo(`${y}-${m}-${String(last).padStart(2, '0')}`);
  }
  useEffect(() => {
    const h = (e) => { if (e.detail?.collection === collection) load(true); };
    window.addEventListener('communityos:changed', h);
    return () => window.removeEventListener('communityos:changed', h);
  }, [collection, load]);

  // Default cell text: role lists show role names, rich text shows plain text, arrays are joined.
  const cellText = (r, key) => {
    const v = r[key];
    if (v === undefined || v === null || v === '') return '—';
    const type = schema?.fields.find((f) => f.key === key)?.type;
    if (type === 'roles') return v.length ? v.map((id) => (id === 'group:EC' ? 'Executive Committee' : roles.find((x) => x.id === id)?.name || id)).join(', ') : '—';
    if (type === 'richtext') { const t = htmlToText(v); return t.length > 90 ? `${t.slice(0, 87)}…` : t || '—'; }
    if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? v.join(', ') : `${v.length} item(s)`;
    return String(v);
  };

  const rows = transformRows ? transformRows(result.rows) : result.rows;

  // Export everything the current search / filters match (not just this page), using the visible column headings.
  const exportData = async () => {
    const res = await secureStorage.query(collection, { ...(lastParams.current || {}), page: 1, pageSize: 1000000 });
    const all = transformRows ? transformRows(res.rows) : res.rows;
    const shown = cols.filter((c) => c.label);
    const val = (r, c) => (c.exportValue ? c.exportValue(r) : (() => { const t = cellText(r, c.key); return t === '—' ? '' : t; })());
    return { head: shown.map((c) => c.label), rows: all.map((r) => shown.map((c) => val(r, c))) };
  };

  function toggleSort(key) {
setSort((s) => (s?.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  }
  function setFilter(key, value) { setFvals((f) => ({ ...f, [key]: value })); }
  function clearAll() { setFvals({}); setText(''); setQ(''); setFrom(''); setTo(''); setPYear(''); setPMonth(''); setDY(''); setDM(''); }
  // the parent's reset icon bumps resetToken: clear search, dropdown filters and the date range together
  useEffect(() => { if (resetToken) clearAll(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [resetToken]);
  // Every list gets the same phone treatment: a card per row (first column = title, next few columns = label/value pairs) unless a screen draws its own.
  const cardRender = cardRenderProp || ((r) => {
    const isId = (c) => c.key === 'shortId' || c.key === 'id' || /^(id|ref|ticket #)$/i.test(c.label || '');
    const idCol = cols.length > 2 ? cols.find(isId) : null;
    const [first, ...rest] = idCol ? cols.filter((c) => c !== idCol) : cols;
    const show = (c) => (c.render ? c.render(r) : statusify(cellText(r, c.key)));
    return (
      <article className="tk-card auto-card">
        {idCol && <div className="tk-card-top"><span className="mono">{show(idCol)}</span></div>}
        <h3 className="tk-title">{first ? show(first) : ''}</h3>
        <dl className="auto-kv">
          {rest.slice(0, 6).map((c) => <div key={c.key}><dt>{c.label}</dt><dd>{show(c)}</dd></div>)}
        </dl>
      </article>
    );
  });
  const sortOptions = cardSorts || cols.filter((c) => c.sortable !== false).slice(0, 4).flatMap((c) => [{ key: c.key, dir: 'asc', label: `${c.label} ↑` }, { key: c.key, dir: 'desc', label: `${c.label} ↓` }]);
  const active = Object.values(fvals).some(Boolean) || text || from || to || pYear || pMonth;

  return (
    <div className="stable">
      {(search || filters.length > 0 || periodFilter || dateFields.length > 0 || toolbarExtra) && (
        <div className="stable-bar">
          {search && <input className="search" placeholder="Search…" value={text} onChange={(e) => setText(e.target.value)} />}
          <ExportIcon getData={exportData} name={schema?.label || schemaFor?.(collection)?.label || collection} />
          {asCards && sortOptions.length > 0 && (
            <select className="filter stable-sort" aria-label="Sort by" value={sort ? `${sort.key}:${sort.dir}` : ''} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setSort({ key, dir }); }}>
              {!sort && <option value="">Sort…</option>}
              {sortOptions.map((o) => <option key={`${o.key}:${o.dir}`} value={`${o.key}:${o.dir}`}>{o.label}</option>)}
            </select>
          )}
          {(filters.length > 0 || periodFilter || dateFields.length > 0) && (
            <button type="button" className="btn secondary stable-filter-toggle" onClick={() => setShowFilters((v) => !v)}>
              ⚙ Filters{Object.values(fvals).filter(Boolean).length + (from || to ? 1 : 0) + (pYear ? 1 : 0) + (pMonth ? 1 : 0) > 0 ? ` (${Object.values(fvals).filter(Boolean).length + (from || to ? 1 : 0) + (pYear ? 1 : 0) + (pMonth ? 1 : 0)})` : ''}
            </button>
          )}
          <div className={`stable-filters${showFilters ? ' open' : ''}`}>
          {filters.map((f) => {
            const options = f.options ?? schema?.fields.find((sf) => sf.key === f.key)?.options ?? derived[f.key] ?? [];
            return (
              <select key={f.key} className="filter" aria-label={f.label} value={fvals[f.key] ?? ''} onChange={(e) => setFilter(f.key, e.target.value)}>
                <option value="">{f.label}</option>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            );
          })}
          {periodFilter && (
            <>
              <select className="filter" aria-label={`${periodFilter.label || 'Bill'} year`} value={pYear} onChange={(e) => { setPYear(e.target.value); }}>
                <option value="">All years</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <select className="filter" aria-label={`${periodFilter.label || 'Bill'} month`} value={pMonth} onChange={(e) => { setPMonth(e.target.value); }}>
                <option value="">All months</option>
                {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
              </select>
            </>
          )}
          {dateFields.length > 0 && (
            <div className="stable-dates">
              {dateFields.length > 1 && (
                <select className="filter" aria-label="Date field" value={dateKey} onChange={(e) => { setDateKey(e.target.value); applyDp('', ''); }}>
                  {dateFields.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
              )}
              {dateFields.length === 1 && <span className="muted">{dateFields[0].label}</span>}
              {dateYears.length >= 1 && (
                <>
                  <select className="filter" aria-label="Year" data-testid="date-year" value={dY} onChange={(e) => applyDp(e.target.value, '')}>
                    <option value="">All years</option>
                    {dateYears.map((y) => <option key={y} value={y}>{y}</option>)}
                    <option value="custom">Custom dates…</option>
                  </select>
                  {((dY && dY !== 'custom') || (!dY && dateYears.length === 1)) && (
                    <select className="filter" aria-label="Month" data-testid="date-month" value={dM} onChange={(e) => applyDp(dY || dateYears[0], e.target.value)}>
                      <option value="">All months</option>
                      {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
                    </select>
                  )}
                </>
              )}
              {(dateYears.length < 1 || dY === 'custom') && (
                <>
                  <input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => { setFrom(e.target.value); }} />
                  <span className="muted">to</span>
                  <input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => { setTo(e.target.value); }} />
                </>
              )}
            </div>
          )}
          {active && <button className="btn secondary" onClick={clearAll}>Clear</button>}
          </div>
          {toolbarExtra}
        </div>
      )}
      <div className="stable-count-line" data-testid="row-count">{result.approx ? `${result.total.toLocaleString()}+ records` : `${result.total} record${result.total === 1 ? '' : 's'}`}</div>
      {result.approx && <div className="muted" data-testid="row-count-approx" role="status" style={{ fontSize: 13, margin: '4px 0 8px' }}>
        More than {result.total.toLocaleString()} records match. Narrow the filters or the date range to see an exact count.
      </div>}

      {asCards && (
        <div className={`tcards${cardsAlways ? " tgrid" : ""}`} aria-busy={loading}>
          {rows.map((r) => (
            <div key={r.id} className={`tcard-wrap ${rowClassName ? rowClassName(r) : ''}`} role={onRowClick ? 'button' : undefined} tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}>
              {cardRender(r)}
            </div>
          ))}
          {!loading && rows.length === 0 && <div className="empty">{emptyText}</div>}
        </div>
      )}
      <div className="table-wrap stable-wrap" aria-busy={loading} style={asCards ? { display: 'none' } : undefined}>
        <table className="resp-table">
          <thead>
            <tr>
              {cols.map((c) => {
                const sortable = c.sortable !== false;
                return (
                  <th key={c.key} className={sortable ? 'sort-th' : ''} onClick={sortable ? () => toggleSort(c.key) : undefined} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    {c.label}
                    {sort?.key === c.key && <span className="arrow">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={`${onRowClick ? 'clickable' : ''} ${rowClassName ? rowClassName(r) : ''}`} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {cols.map((c) => (
                  <td key={c.key} data-label={c.label} className={c.className}>
                    {c.render ? c.render(r) : statusify(cellText(r, c.key))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && rows.length === 0 && <div className="empty">{emptyText}</div>}
      </div>

      <div ref={sentinel} className="stable-sentinel" aria-live="polite">
        {(loadingMore || (loading && rows.length > 0)) ? <span className="muted">Loading…</span> : null}
      </div>
    </div>
  );
}
