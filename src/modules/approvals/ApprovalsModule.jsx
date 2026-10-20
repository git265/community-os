import React from 'react';
import ApprovalsPanel from './ApprovalsPanel.jsx';

/** One place for every money approval: task quotations, vendor invoices and cultural-event expenses. */
export default function ApprovalsModule({ onNavigate }) {
  return (
    <div>
      <div className="page-head"><div><h1>Approvals</h1><p>Task quotations, vendor invoices and cultural-event expenses go through the same people: EC members first (where a task needs it), then the final approvers set under Maintenance → Final approvers.</p></div></div>
      <div className="card"><ApprovalsPanel onNavigate={onNavigate} /></div>
    </div>
  );
}
