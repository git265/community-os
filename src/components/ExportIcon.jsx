import { todayLocal } from '../lib/locale.js';
import React, { useState } from 'react';

const stamp = () => todayLocal();

/** Save rows as an .xlsx file. SheetJS is loaded only when someone exports. */
export async function saveXlsx(head, rows, name = 'export') {
  const XLSX = await import('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([head, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' ') || 'Export');
  XLSX.writeFile(wb, `${name.replace(/[^\w.-]+/g, '_')}_${stamp()}.xlsx`);
}

const Icon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v12" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" />
  </svg>
);

/** Small export icon. `getData` returns { head: string[], rows: any[][] } (may be async). */
export function ExportIcon({ getData, name, title = 'Export to Excel' }) {
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="icon-btn export-btn" title={title} aria-label={title} disabled={busy}
      onClick={async () => { setBusy(true); try { const d = await getData(); await saveXlsx(d.head, d.rows, name); } finally { setBusy(false); } }}>
      <Icon />
    </button>
  );
}

/** Export icon for a hand-built table: reads the first <table> inside the referenced element; cells marked .noexport are left out. */
export function TableExportIcon({ scope, name }) {
  return (
    <ExportIcon name={name} getData={() => {
      const t = scope.current?.querySelector('table');
      if (!t) return { head: [], rows: [] };
      const keep = (cells) => cells.filter((c) => !c.classList.contains('noexport')).map((c) => c.innerText.replace(/\s+/g, ' ').trim());
      const head = keep([...t.querySelectorAll('thead th')]);
      const rows = [...t.querySelectorAll('tbody tr')].map((tr) => keep([...tr.children]));
      return { head, rows };
    }} />
  );
}
