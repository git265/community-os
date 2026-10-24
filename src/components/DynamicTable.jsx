import { isMoment, fmtDateTime } from '../lib/locale.js';
import React, { useEffect, useMemo, useState } from 'react';
import { canView } from '../lib/access/permissions.js';

const PAGE_SIZE = 25;

export default function DynamicTable({ schema, roleId, records, onRowClick }) {
  const columns = schema.fields.filter((f) => f.showInTable && canView(f, roleId));
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [page, setPage] = useState(1);

  // Reset to page 1 whenever the underlying record set changes (new search,
  // filter, or section) so a stale page number can't hide rows.
  useEffect(() => { setPage(1); }, [records]);

  const sorted = useMemo(() => {
    if (!sortKey) return records;
    const copy = [...records];
    copy.sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      const an = Number(av), bn = Number(bv);
      const cmp = !isNaN(an) && !isNaN(bn) && av !== '' && bv !== ''
        ? an - bn
        : String(av ?? '').localeCompare(String(bv ?? ''));
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return copy;
  }, [records, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRecords = sorted.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  if (records.length === 0) {
    return <div className="empty">No records yet.</div>;
  }

  return (
    <div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="sort-th" onClick={() => toggleSort(c.key)}>
                  {c.label}
                  {sortKey === c.key && <span className="arrow">{sortDir === 'asc' ? '▲' : '▼'}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRecords.map((r) => (
              <tr key={r.id} onClick={() => onRowClick(r)}>
                {columns.map((c) => (
                  <td key={c.key}>{isMoment(r[c.key]) ? fmtDateTime(r[c.key]) : String(r[c.key] ?? '—')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="pagination">
          <button className="btn secondary" disabled={pageSafe <= 1} onClick={() => setPage(pageSafe - 1)}>Prev</button>
          <span className="muted">Page {pageSafe} of {totalPages} · {sorted.length} rows</span>
          <button className="btn secondary" disabled={pageSafe >= totalPages} onClick={() => setPage(pageSafe + 1)}>Next</button>
        </div>
      )}
    </div>
  );
}
