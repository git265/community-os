// Reads a bank-statement Excel file using an admin-defined import rule (IMPORT_PROFILES) and returns portal rows.
import { categorize } from './analysis.js';
import { readWorkbook } from '../files/xlsxRead.js';

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
const num = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const pad = (n) => String(n).padStart(2, '0');

/** One date cell -> ISO yyyy-mm-dd, or '' if it is not a date. `swap` undoes Excel reading dd/mm as mm/dd. */
export function parseDate(v, swap, monthFirst = false) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const d = new Date(v.getTime() + 12 * 3600e3); // SheetJS yields local-midnight-ish dates: round to the day
    let y = d.getUTCFullYear(); let m = d.getUTCMonth() + 1; let day = d.getUTCDate();
    if (swap && day <= 12) [m, day] = [day, m];
    return `${y}-${pad(m)}-${pad(day)}`;
  }
  const t = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/.exec(t); // text dates are day-first unless the rule says month-first (US / Canada banks)
  if (m) { const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]); return monthFirst ? `${y}-${pad(m[1])}-${pad(m[2])}` : `${y}-${pad(m[2])}-${pad(m[1])}`; }
  return '';
}

/** Key used to spot lines that are already in the portal. */
export const txnKey = (t) => [t.account, t.date, Math.round(Number(t.debit || 0) * 100), Math.round(Number(t.credit || 0) * 100), Math.round(Number(t.balance || 0) * 100), String(t.narration || '').slice(0, 40).toUpperCase()].join('|');

const SWEEP = /SWEEP|AUTO ?SWEEP|SWEEP ?(IN|OUT)|SWP/i;

export async function readStatement(file, profile, account) {
  const XLSX = await import('xlsx'); // loaded only when someone imports a file
  const wb = await readWorkbook(await file.arrayBuffer(), { type: 'array', cellDates: true });
  const sheetName = profile.sheet && wb.SheetNames.includes(profile.sheet) ? profile.sheet : wb.SheetNames[0];
  if (profile.sheet && !wb.SheetNames.includes(profile.sheet)) throw new Error(`Sheet “${profile.sheet}” is not in this file (found: ${wb.SheetNames.join(', ')}).`);
  const grid = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
  const hr = Math.max(1, Number(profile.headerRow) || 1) - 1;
  const header = (grid[hr] || []).map(norm);
  const find = (name) => (name ? header.indexOf(norm(name)) : -1);
  const cols = {
    date: find(profile.dateCol), narration: find(profile.narrationCol), debit: find(profile.debitCol), credit: find(profile.creditCol),
    balance: find(profile.balanceCol), party: find(profile.partyCol), remarks: find(profile.remarksCol),
  };
  const labels = { date: profile.dateCol, narration: profile.narrationCol, debit: profile.debitCol, credit: profile.creditCol, balance: profile.balanceCol, party: profile.partyCol, remarks: profile.remarksCol };
  const missing = Object.entries(cols).filter(([k, i]) => i < 0 && labels[k]).map(([k]) => `${labels[k]} (${k})`);
  if (cols.date < 0 || cols.narration < 0) throw new Error(`Could not find the Date / Narration columns in row ${hr + 1} of “${sheetName}”. Headers found: ${(grid[hr] || []).filter(Boolean).join(', ') || 'none'}.`);
  const swap = profile.dateMode === 'Day and month swapped by Excel';
  const rows = []; let skipped = 0;
  for (const r of grid.slice(hr + 1)) {
    const date = parseDate(r[cols.date], swap, profile.dateMode === 'Month first in text (MM/DD/YYYY)');
    if (!date) { skipped++; continue; }
    const narration = String(r[cols.narration] ?? '').trim();
    if (profile.skipSweep && SWEEP.test(narration)) { skipped++; continue; }
    const t = {
      date, account, narration,
      debit: cols.debit >= 0 ? num(r[cols.debit]) : 0, credit: cols.credit >= 0 ? num(r[cols.credit]) : 0,
      balance: cols.balance >= 0 ? num(r[cols.balance]) : 0,
      party: cols.party >= 0 ? String(r[cols.party] ?? '').trim() : '', remarks: cols.remarks >= 0 ? String(r[cols.remarks] ?? '').trim() : '',
    };
    if (!t.debit && !t.credit) { skipped++; continue; }
    t.head = categorize(t);
    rows.push(t);
  }
  return { rows, skipped, missing, sheetName };
}
