import { localDay } from '../../lib/locale.js';
import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { useApp } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { StatusTag } from '../../components/StatusTag.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import { useAssocBills, inr, dmy, UTIL_ICON as ICON } from '../billing/useAssocBills.js';
import PageActions from '../../components/PageActions.jsx';
import { PhoneSearch, PhoneFilters } from '../../components/ToolIcons.jsx';

/**
 * Utilities → Association bills: every bill the association pays itself (electricity for the common area / STP / WTP / clubhouse,
 * water, DG diesel, gas, internet …). Add and edit them here, filter by utility, location, year, month and status.
 * Paying them is done in Payments → Utilities (Association); this list shows each bill's payment status and the ledger entry.
 */
export default function AssocBills({ onNavigate }) {
  const { hasPermission, roleId } = useApp();
  const { records: elecRecs, refresh: refreshElec } = useCollection(C.ELECTRICITY_BILLS, 'Electricity Bills');
  const { bills, paidBy, isPaid, overdue, refresh } = useAssocBills();
  const canAdd = canWriteCollection(C.ASSOC_BILLS, getPrincipal());
  const canAddElec = canWriteCollection(C.ELECTRICITY_BILLS, getPrincipal());
  const canSeePay = roleId === 'super_admin' || hasPermission('MANAGE_LEDGER') || roleId === 'treasurer';
  const [adding, setAdding] = useState(null);
  const [addingElec, setAddingElec] = useState(null);
  const [f, setF] = useState({ util: '', loc: '', year: 'last12', month: '', status: '', q: '' });
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const stateOf = (b) => (isPaid(b) ? 'Paid' : overdue(b) ? 'Overdue' : 'Unpaid');
  const years = useMemo(() => [...new Set(bills.map((b) => String(b.date).slice(0, 4)).filter((y) => /^\d{4}$/.test(y)))].sort().reverse(), [bills]);
  const cutoff = (() => { const d = new Date(); d.setFullYear(d.getFullYear() - 1); return localDay(d); })();
  const shown = bills.filter((b) => (!f.util || b.utility === f.util) && (!f.loc || b.location === f.loc) && (f.year === 'last12' ? String(b.date).slice(0, 10) >= cutoff : !f.year || String(b.date).startsWith(f.year)) && (!f.month || String(b.date).slice(5, 7) === f.month) && (!f.status || stateOf(b) === f.status)
    && (!f.q || `${b.title} ${b.shortId} ${b.vendor} ${b.sub}`.toLowerCase().includes(f.q.toLowerCase())));
  const total = shown.reduce((s, b) => s + b.amount, 0);
  const due = shown.filter((b) => !isPaid(b)).reduce((s, b) => s + b.amount, 0);
  const utilities = [...new Set(bills.map((b) => b.utility))]; const locations = [...new Set(bills.map((b) => b.location))];
  return (
    <div data-testid="assoc-bills">
      <div className="page-head">
        <div><h2 style={{ margin: 0 }}>Association utility bills</h2>
          <p>Electricity for the common area, STP, WTP and clubhouse, water, diesel, gas, internet… the bills the association pays. They are paid in Payments → Utilities (Association).</p></div>
        <PageActions>
          {canAddElec && <button type="button" className="btn" data-testid="assoc-add-elec" onClick={() => setAddingElec({})}>⚡ Add electricity bill</button>}
          {canAdd && <button type="button" className="btn" data-testid="assoc-add" onClick={() => setAdding({})}>+ Add other bill</button>}
        </PageActions>
      </div>
      <div className="exp-tools" data-testid="assoc-filters">
        <PhoneSearch type="search" ariaLabel="Search bills" testid="assoc-q" placeholder="Search bill, supplier, bill no…" value={f.q} onChange={(v) => set('q', v)} className="" />
        <PhoneFilters testid="assoc-more" count={[f.util, f.loc, f.month, f.status, f.year !== 'last12'].filter(Boolean).length}>
        <select aria-label="Utility" data-testid="assoc-util" value={f.util} onChange={(e) => set('util', e.target.value)}><option value="">All utilities</option>{utilities.map((u) => <option key={u}>{u}</option>)}</select>
        <select aria-label="Location" data-testid="assoc-loc" value={f.loc} onChange={(e) => set('loc', e.target.value)}><option value="">All locations</option>{locations.map((u) => <option key={u}>{u}</option>)}</select>
        <select aria-label="Year" data-testid="assoc-year" value={f.year} onChange={(e) => set('year', e.target.value)}><option value="last12">Last 12 months</option><option value="">All years</option>{years.map((y) => <option key={y}>{y}</option>)}</select>
        <select aria-label="Month" data-testid="assoc-month" value={f.month} onChange={(e) => set('month', e.target.value)}><option value="">All months</option>{['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((m, i) => <option key={m} value={String(i + 1).padStart(2, '0')}>{m}</option>)}</select>
        <select aria-label="Status" data-testid="assoc-status" value={f.status} onChange={(e) => set('status', e.target.value)}><option value="">Any status</option><option>Unpaid</option><option>Overdue</option><option>Paid</option></select>
        {(f.util || f.loc || f.month || f.status || f.q || f.year !== 'last12') && <button type="button" className="btn secondary sm" data-testid="assoc-clear" onClick={() => setF({ util: '', loc: '', year: 'last12', month: '', status: '', q: '' })}>Clear</button>}
        </PhoneFilters>
      </div>
      <p className="muted" data-testid="assoc-total" style={{ margin: '0 0 8px' }}>{shown.length} of {bills.length} bills{f.year === 'last12' ? ' (last 12 months)' : ''} · {inr(total)} in all · <b style={{ color: due ? 'var(--viz-bad, #c7364a)' : undefined }}>{inr(due)} not yet paid</b></p>
      {shown.length === 0 ? <div className="empty">No bill matches these filters.</div> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table className="resp-table" data-testid="assoc-table">
            <thead><tr><th>Bill</th><th>Utility</th><th>For</th><th>Due</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.key} data-testid="assoc-row" onClick={() => (b.src === 'assoc' && canAdd ? setAdding(b.rec) : b.src === 'elec' && canAddElec ? setAddingElec(elecRecs.find((e) => e.id === b.id)) : null)} style={{ cursor: (b.src === 'assoc' && canAdd) || (b.src === 'elec' && canAddElec) ? 'pointer' : 'default' }}>
                  <td data-label="Bill"><b>{b.title}</b><br /><small className="muted mono">{b.shortId}</small></td>
                  <td data-label="Utility">{ICON[b.utility] || '🧾'} {b.utility}</td>
                  <td data-label="For">{b.location}</td>
                  <td data-label="Due">{b.due ? dmy(b.due) : '—'}</td>
                  <td data-label="Amount">{inr(b.amount)}</td>
                  <td data-label="Status"><StatusTag v={stateOf(b)} />{paidBy(b.key)[0] && <><br /><small className="muted mono">{paidBy(b.key)[0].shortId}</small></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canSeePay && onNavigate && <p className="muted" style={{ marginTop: 8 }}><button type="button" className="btn secondary sm" data-testid="assoc-to-pay" onClick={() => { try { sessionStorage.setItem('communityos:openTab', 'pay:assoc'); } catch { /* ignore */ } onNavigate('billing'); }}>Pay these in Payments →</button></p>}
      {adding && <RecordModal collection={C.ASSOC_BILLS} label="Association Utility Bills" record={adding} title={adding.id ? 'Edit association bill' : 'Add an association utility bill'} subtitle="Water, gas, internet, waste… (Electricity has its own button)." allowDelete={!!adding.id} onSaved={refresh} onClose={() => setAdding(null)} />}
      {addingElec && <RecordModal collection={C.ELECTRICITY_BILLS} label="Electricity Bills" record={addingElec} title={addingElec.id ? 'Edit electricity bill' : 'Add an electricity bill'} subtitle="Clubhouse, common area, STP, WTP, street lights." allowDelete={!!addingElec.id} onSaved={() => { refreshElec(); refresh(); }} onClose={() => setAddingElec(null)} />}
    </div>
  );
}
