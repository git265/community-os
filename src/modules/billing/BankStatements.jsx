import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import ServerTable from '../../components/ServerTable.jsx';
import Modal from '../../components/Modal.jsx';
import RecordModal from './RecordModal.jsx';
import { BUDGET_HEADS, MONTH_NAMES, monthEnd } from '../../lib/bank/analysis.js';
import { readStatement, txnKey } from '../../lib/bank/importExcel.js';

const rupees = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const dmy = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

export default function Statements({ accounts, txns }) {
  const [account, setAccount] = useState('');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [resetToken, setResetToken] = useState(0);
  const [importing, setImporting] = useState(false);
  const [rules, setRules] = useState(false);
  const [notice, setNotice] = useState('');
  const canWrite = canWriteCollection(COLLECTIONS.BANK_TXNS, getPrincipal());

  const years = useMemo(() => [...new Set(txns.map((t) => t.date.slice(0, 4)))].sort().reverse(), [txns]);
  const range = useMemo(() => {
    if (!year) return null;
    if (!month) return { key: 'date', from: `${year}-01-01`, to: `${year}-12-31` };
    const ym = `${year}-${month}`;
    return { key: 'date', from: `${ym}-01`, to: monthEnd(ym) };
  }, [year, month]);

  const inPeriod = useMemo(() => txns.filter((t) => (!account || t.account === account) && (!range || (t.date >= range.from && t.date <= range.to))), [txns, account, range]);
  const totalIn = inPeriod.reduce((s, t) => s + Number(t.credit || 0), 0);
  const totalOut = inPeriod.reduce((s, t) => s + Number(t.debit || 0), 0);

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Bank statements</h2>
      <p className="muted" style={{ marginTop: -6 }}>Each line is sorted into a budget head automatically. Use Import to add a new statement from Excel; bank sweep-in/out lines are left out because they net to zero.</p>
      {notice && <div className="notice" data-testid="import-notice">{notice}</div>}
      <div className="stmt-bar">
        <select aria-label="Account" value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
        </select>
        <select aria-label="Year" value={year} onChange={(e) => { setYear(e.target.value); if (!e.target.value) setMonth(''); }}>
          <option value="">All years</option>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <select aria-label="Month" value={month} disabled={!year} onChange={(e) => setMonth(e.target.value)}>
          <option value="">All months</option>
          {MONTH_NAMES.map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}
        </select>
        <button type="button" className="icon-btn reset-filters" title="Reset filters" aria-label="Reset filters" onClick={() => { setAccount(''); setYear(''); setMonth(''); setResetToken((x) => x + 1); }}>↺</button>
        <span style={{ flex: 1 }} />
        {canWrite && <button type="button" className="btn" onClick={() => setImporting(true)}>Import Excel</button>}
        {canWrite && <button type="button" className="btn secondary" onClick={() => setRules(true)}>Import rules</button>}
      </div>
      <div className="muted" style={{ margin: '4px 0 8px' }} data-testid="stmt-summary">
        {inPeriod.length.toLocaleString('en-IN')} lines{year ? ` in ${month ? `${MONTH_NAMES[Number(month) - 1]} ` : ''}${year}` : ''} · money in {rupees(totalIn)} · money out {rupees(totalOut)}
      </div>
      <ServerTable
        collection={COLLECTIONS.BANK_TXNS}
        columns={[
          { key: 'date', label: 'Date', render: (t) => dmy(t.date) },
          { key: 'account', label: 'Account' },
          { key: 'narration', label: 'Narration', render: (t) => <span>{t.narration}{t.remarks ? <small className="muted"> · {t.remarks}</small> : null}</span> },
          { key: 'head', label: 'Head', render: (t) => <span className={`tag ${t.head === 'Other income' || t.head === 'Other expense' ? 'orange' : ''}`}>{t.head}</span> },
          { key: 'debit', label: 'Withdrawal', render: (t) => (t.debit ? rupees(t.debit) : '') },
          { key: 'credit', label: 'Deposit', render: (t) => (t.credit ? rupees(t.credit) : '') },
        ]}
        baseFilters={account ? { account } : {}}
        externalDateRange={range}
        resetToken={resetToken}
        baseSort={{ key: 'date', dir: 'desc' }}
        filters={[{ key: 'head', label: 'All heads', options: BUDGET_HEADS }]}
        searchKeys={['narration', 'remarks', 'party']}
        emptyText="No statement lines for this selection."
      />
      {importing && <ImportModal accounts={accounts} txns={txns} onClose={(msg) => { setImporting(false); if (msg) setNotice(msg); }} />}
      {rules && <RulesModal accounts={accounts} onClose={() => setRules(false)} />}
    </div>
  );
}

function ImportModal({ accounts, txns, onClose }) {
  const { records: profiles } = useCollection(COLLECTIONS.IMPORT_PROFILES, 'Statement Import Rules');
  const [profileId, setProfileId] = useState('');
  const profile = profiles.find((p) => p.id === profileId) || profiles[0];
  const [account, setAccount] = useState('');
  const acct = account || profile?.account || accounts[0]?.name || '';
  const [file, setFile] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function parse(f, p, a) {
    setError(''); setResult(null);
    if (!f || !p || !a) return;
    setBusy(true);
    try {
      const r = await readStatement(f, p, a);
      const have = new Set(txns.filter((t) => t.account === a).map(txnKey));
      const seen = new Set();
      const fresh = []; let dupes = 0;
      for (const t of r.rows) { const k = txnKey(t); if (have.has(k) || seen.has(k)) { dupes++; continue; } seen.add(k); fresh.push(t); }
      setResult({ ...r, fresh, dupes });
    } catch (e) { setError(e.message || 'Could not read this file.'); }
    setBusy(false);
  }

  async function run() {
    setBusy(true);
    try {
      const n = await secureStorage.importMany(COLLECTIONS.BANK_TXNS, result.fresh, { label: 'Bank Statement', summary: `Imported ${result.fresh.length} lines into ${acct} from ${file.name}` });
      onClose(`Imported ${n} new lines into ${acct}${result.dupes ? ` (${result.dupes} already present were skipped)` : ''}.`);
    } catch (e) { setError(e.message || 'Import failed.'); setBusy(false); }
  }

  const f = result?.fresh || [];
  const dates = f.map((t) => t.date).sort();
  const other = f.filter((t) => t.head === 'Other income' || t.head === 'Other expense').length;
  return (
    <Modal title="Import bank statement" subtitle="Pick the import rule (which Excel column feeds which field), the account and the file. Nothing is saved until you confirm the preview." onClose={() => onClose('')}>
      {error && <div className="notice error" data-testid="import-error">{error}</div>}
      {!profiles.length && <div className="notice">No import rules yet — add one under “Import rules” first.</div>}
      <div className="form-grid">
        <div className="field"><label>Import rule</label>
          <select aria-label="Import rule" value={profile?.id || ''} onChange={(e) => { setProfileId(e.target.value); parse(file, profiles.find((p) => p.id === e.target.value), acct); }}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></div>
        <div className="field"><label>Account</label>
          <select aria-label="Import account" value={acct} onChange={(e) => { setAccount(e.target.value); parse(file, profile, e.target.value); }}>
            {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Excel file (.xlsx / .xls)</label>
          <input type="file" aria-label="Statement file" accept=".xlsx,.xls,.csv" onChange={(e) => { const x = e.target.files?.[0] || null; setFile(x); parse(x, profile, acct); }} /></div>
      </div>
      {busy && <p className="muted">Reading…</p>}
      {result && (
        <div data-testid="import-preview">
          {result.missing.length > 0 && <div className="notice error">These columns from the rule were not found in the file: {result.missing.join(', ')}. They will be left blank.</div>}
          <p><b>{f.length}</b> new lines{dates.length ? ` from ${dmy(dates[0])} to ${dmy(dates[dates.length - 1])}` : ''} · money in {rupees(f.reduce((s, t) => s + t.credit, 0))} · money out {rupees(f.reduce((s, t) => s + t.debit, 0))}<br />
            <small className="muted">{result.dupes} already in the portal (skipped) · {result.skipped} blank/sweep rows ignored · {other} lines left under “Other” for review · sheet “{result.sheetName}”</small></p>
          <div className="table-wrap"><table className="resp-table">
            <thead><tr><th>Date</th><th>Narration</th><th>Head</th><th>Out</th><th>In</th></tr></thead>
            <tbody>{f.slice(0, 8).map((t, i) => <tr key={i}><td>{dmy(t.date)}</td><td>{t.narration}</td><td>{t.head}</td><td>{t.debit ? rupees(t.debit) : ''}</td><td>{t.credit ? rupees(t.credit) : ''}</td></tr>)}</tbody>
          </table></div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" className="btn" disabled={!f.length || busy} onClick={run}>Import {f.length || ''} lines</button>
        <button type="button" className="btn secondary" onClick={() => onClose('')}>Cancel</button>
      </div>
    </Modal>
  );
}

function RulesModal({ accounts, onClose }) {
  const { records: profiles } = useCollection(COLLECTIONS.IMPORT_PROFILES, 'Statement Import Rules');
  const [editing, setEditing] = useState(null);
  return (
    <Modal title="Import rules" subtitle="Map the columns of the bank’s Excel file to portal fields. Use the exact header text from the file." onClose={onClose}>
      <div className="table-wrap"><table className="resp-table">
        <thead><tr><th>Rule</th><th>Account</th><th>Header row</th><th>Date ← / Narration ← / Out ← / In ←</th><th /></tr></thead>
        <tbody>
          {profiles.map((p) => (
            <tr key={p.id}>
              <td data-label="Rule"><b>{p.name}</b></td>
              <td data-label="Account">{p.account || 'Chosen at import'}</td>
              <td data-label="Header row">{p.headerRow}</td>
              <td data-label="Columns"><small>{[p.dateCol, p.narrationCol, p.debitCol, p.creditCol].filter(Boolean).join(' / ')}</small></td>
              <td><button type="button" className="btn secondary" onClick={() => setEditing(p)}>Edit</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>
      <div style={{ marginTop: 10 }}><button type="button" className="btn" onClick={() => setEditing({ headerRow: 1, dateMode: 'As in the file', skipSweep: true })}>+ Add rule</button></div>
      {editing && <RecordModal collection={COLLECTIONS.IMPORT_PROFILES} label="Statement Import Rules" record={editing} allowDelete onClose={() => setEditing(null)} />}
    </Modal>
  );
}
