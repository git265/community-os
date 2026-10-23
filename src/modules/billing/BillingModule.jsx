import TaxSplit from './TaxSplit.jsx';
import InputCredit from './InputCredit.jsx';
import BankBudget from './BankBudget.jsx';
import PaymentsHub from './PaymentsHub.jsx';
import TreasurerDashboard from './TreasurerDashboard.jsx';
import { takeHint } from '../../lib/openHint.js';
import DuesTools from './DuesTools.jsx';
import Defaulters from './Defaulters.jsx';
import Reports from './Reports.jsx';
import React, { useState } from 'react';
import SectionPage from '../../components/SectionPage.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import TicketsModule from '../tickets/TicketsModule.jsx';
import { canEdit } from '../../lib/access/permissions.js';
import { DueExtras } from '../../components/PayDue.jsx';
import { monthLabel } from '../../lib/notice.js';
import { money } from '../../lib/locale.js';
import Tabs from '../../components/Tabs.jsx';

const inr = (n) => money(n, { round: false });

/** Jump to a task's details in Maintenance (used by the Payments Cross-check and the financial task list). */
export function openTask(ticketRef, onNavigate) {
  try { sessionStorage.setItem('communityos:openTicket', ticketRef); sessionStorage.setItem('communityos:openTicketTab', 'money'); } catch { /* ignore */ }
  onNavigate?.('tickets');
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function currentMonthLabel() {
  const d = new Date();
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function duesStatCards(records) {
  const billed = records.reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const collected = records.filter((d) => d.status === 'Paid').reduce((s, d) => s + (Number(d.amount) || 0), 0);
  const overdue = records.filter((d) => d.status === 'Overdue').length;
  const pct = billed ? Math.round((collected / billed) * 100) : 0;
  return [
    { label: 'Total billed', value: `₹${billed.toLocaleString('en-IN')}` },
    { label: 'Collected', value: `₹${collected.toLocaleString('en-IN')}`, sub: `${pct}% of billed` },
    { label: 'Overdue accounts', value: overdue },
  ];
}

export default function BillingModule({ onNavigate }) {
  const { hasPermission, roleId, tabAllowed } = useApp();
  // Payments cross-check is open to the accounting roles, EC and the Facility Manager (read-only for the latter).
  const canSeeAccounting = hasPermission('MANAGE_LEDGER') || hasPermission('MANAGE_UTILITY_BILLING') || roleId === 'facility_manager';
  // The Treasurer's dashboard: the Treasurer, the President, Super Admin and anyone who manages the ledger.
  const isTreasury = roleId === 'treasurer' || roleId === 'president' || roleId === 'super_admin' || hasPermission('MANAGE_LEDGER');
  const [taskRef, setTaskRef] = useState(null); // a task opened from here is shown on top of Billing, so you stay on this page
  const [tabState, setTab] = useState(() => {
    const h = takeHint(['dashboard', 'dues', 'defaulters', 'reports', 'bank', 'pay', 'pay:cultural', 'pay:maintenance', 'pay:assoc', 'pay:collections', 'pay:all']);
    if (h) { if (h.startsWith('pay:')) { try { sessionStorage.setItem('communityos:paySection', h.slice(4)); setTimeout(() => { try { sessionStorage.removeItem('communityos:paySection'); } catch { /* ignore */ } }, 900); } catch { /* ignore */ } return 'pay'; } return h; }
    try { const t = sessionStorage.getItem('communityos:billingTab'); if (t) { setTimeout(() => { try { sessionStorage.removeItem('communityos:billingTab'); } catch { /* ignore */ } }, 400); return t; } } catch { /* ignore */ }
    return isTreasury ? 'dashboard' : 'dues';
  });
  // tabs this role can open (permissions first, then the Super Admin's per-role tab switches)
  const canDefaulters = canSeeAccounting || hasPermission('MANAGE_DUES');
  const ALL_TABS = [['dashboard', 'Dashboard', isTreasury], ['taxsplit', 'Tax split', canSeeAccounting], ['itc', 'Input credit', canSeeAccounting], ['dues', 'Dues', true], ['defaulters', 'Defaulters', canDefaulters], ['reports', 'Reports', canSeeAccounting], ['bank', 'Accounts & budget', canSeeAccounting], ['pay', 'Payments', canSeeAccounting]];
  const tabs = ALL_TABS.filter(([id, , ok]) => ok && tabAllowed(`billing.${id}`));
  const tab = tabs.some(([id]) => id === tabState) ? tabState : tabs[0]?.[0];

  return (
    <div>
      {taskRef && <TicketsModule embeddedRef={taskRef} onEmbeddedClose={() => setTaskRef(null)} />}
      <Tabs style={{ margin: '0 0 4px' }}>
        {tabs.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </Tabs>

      {isTreasury && tab === 'dashboard' && <TreasurerDashboard />}

      {tab === 'taxsplit' && <TaxSplit />}
      {tab === 'itc' && <InputCredit />}

      {tab === 'dues' && <DuesTools />}
      {tab === 'dues' && (
        <SectionPage
          sectionId={COLLECTIONS.DUES}
          title="Billing & finance"
          description="Dues, utility charges and payment status. Click a bill to see its details."
          recordName="bill"
          formHelp="Add a charge for a unit. Water and DG bills are created from meter readings in Operations → Utilities."
          formExtra={(d) => (d?.id ? <DueExtras due={d} /> : null)}
          statCards={duesStatCards}
          search
          filters={[{ key: 'status', label: 'All status' }, { key: 'category', label: 'All categories' }]}
          dateFields={[{ key: 'dueDate', label: 'Due date' }]}
          baseSort={{ key: 'dueDate', dir: 'desc' }}
        />
      )}

      {canDefaulters && tab === 'defaulters' && <Defaulters />}
      {canSeeAccounting && tab === 'reports' && <Reports />}
      {canSeeAccounting && tab === 'bank' && <BankBudget />}
      {canSeeAccounting && tab === 'pay' && <PaymentsHub onOpenTask={(ref) => { try { sessionStorage.setItem('communityos:openTicketTab', 'money'); } catch { /* ignore */ } setTaskRef(ref); }} onNavigate={onNavigate} />}
    </div>
  );
}
