import { useEffect } from 'react';

// Adds a "Print" button above every data grid (table.table) in the portal, and prints just that grid with a title and date.
// The grids are rendered by many modules; this keeps printing consistent without touching each one.
import { escapeHtml as esc } from '../lib/escapeHtml.js';

export function printTable(table, title, community) {
  const clone = table.cloneNode(true);
  clone.querySelectorAll('button, input, select, textarea, .btn, .tbl-print-bar, svg').forEach((n) => n.remove());
  clone.querySelectorAll('a').forEach((a) => a.replaceWith(document.createTextNode(a.textContent)));
  // drop columns that are empty after removing the buttons (the "Edit / Approve" column)
  const rows = [...clone.querySelectorAll('tr')];
  const cols = Math.max(0, ...rows.map((r) => r.children.length));
  for (let c = cols - 1; c >= 0; c--) {
    if (rows.every((r) => !r.children[c] || !r.children[c].textContent.trim())) rows.forEach((r) => r.children[c]?.remove());
  }
  clone.querySelectorAll('[data-label]').forEach((n) => n.removeAttribute('data-label'));
  const w = window.open('', '_blank');
  if (!w) { window.alert('Allow pop-ups to print this list.'); return; }
  w.document.write(`<html><head><title>${esc(title)}</title><style>body{font:13px Arial,sans-serif;padding:22px;color:#111}h2{margin:0 0 2px}small{color:#555}table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f1f3f5}.tag{border:1px solid #ccc;border-radius:8px;padding:0 5px;font-size:11px}@media print{body{padding:0}}</style></head><body><h2>${esc(title)}</h2><small>${esc(community || '')} · printed ${new Date().toLocaleString('en-GB')}</small>${clone.outerHTML}</body></html>`);
  w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
}

export function useTablePrint(community) {
  useEffect(() => {
    let raf = 0;
    const enhance = () => {
      raf = 0;
      document.querySelectorAll('table.table').forEach((t) => {
        if (!t.querySelector('tbody tr')) return;
        const prev = t.previousElementSibling;
        if (prev && prev.classList.contains('tbl-print-bar')) return;
        const bar = document.createElement('div');
        bar.className = 'tbl-print-bar';
        bar.innerHTML = '<button type="button" class="btn secondary sm" data-testid="print-table" title="Print this list">🖨 Print</button>';
        t.parentNode.insertBefore(bar, t);
      });
      document.querySelectorAll('.tbl-print-bar').forEach((b) => { if (!(b.nextElementSibling && b.nextElementSibling.matches('table.table'))) b.remove(); });
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(enhance); };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    schedule();
    const click = (e) => {
      const btn = e.target.closest?.('.tbl-print-bar button');
      if (!btn) return;
      const table = btn.parentElement.nextElementSibling;
      const crumb = document.querySelector('.top .crumb')?.textContent || 'List';
      const head = table.closest('.card, .modal-card')?.querySelector('h2, h3');
      printTable(table, head && head.textContent.trim() && head.textContent.trim() !== crumb ? `${crumb} — ${head.textContent.trim()}` : crumb, community);
    };
    document.addEventListener('click', click);
    return () => { mo.disconnect(); document.removeEventListener('click', click); if (raf) cancelAnimationFrame(raf); };
  }, [community]);
}
