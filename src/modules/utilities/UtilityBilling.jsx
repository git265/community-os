import React, { useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canEdit } from '../../lib/access/permissions.js';
import { runDueReminders } from '../../lib/dueReminders.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { DEFAULT_UTILITY_TYPES } from '../../lib/utilityTypes.js';
import Tabs from '../../components/Tabs.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function currentMonthLabel() {
  const d = new Date();
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export default function UtilityBilling({ onNavigate }) {
  const { roleId, schemaFor } = useApp();
  const { records: templates, save: saveTemplate } = useCollection(COLLECTIONS.BILLING_TEMPLATES, 'Utility Billing Templates');
  const { records: dues, save: saveDue } = useCollection(COLLECTIONS.DUES, 'Billing & Finance');

  const { records: typeRows } = useCollection(COLLECTIONS.UTILITY_TYPES, 'Utility Types');
  const utilTypes = (typeRows.length ? typeRows : DEFAULT_UTILITY_TYPES).filter((u) => u.active !== false);
  const [type, setType] = useState('DG');
  const [status, setStatus] = useState('');

  const templateSchema = schemaFor(COLLECTIONS.BILLING_TEMPLATES);
  const canEditTemplate = templateSchema?.fields.some((f) => canEdit(f, roleId));
  const savedTemplate = templates.find((t) => t.type === type) ?? { type, ratePerUnit: 0, fixedCharge: 0, tax: 0 };
  const [tplDraft, setTplDraft] = useState(savedTemplate);

  // Re-seed the draft when the selected utility type changes, or once the
  // templates collection finishes its initial async load.
  React.useEffect(() => { setTplDraft(savedTemplate); }, [type, templates.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const month = currentMonthLabel();
  const thisMonthDues = dues.filter((d) => d.category === type && d.billedMonth === month);
  const generated = thisMonthDues.length;
  const paid = thisMonthDues.filter((d) => d.status === 'Paid').length;
  const pending = dues.filter((d) => d.category === type && !['Paid', 'Cancelled'].includes(d.status));

  async function saveTemplateForm() {
    await saveTemplate({ ...tplDraft, id: savedTemplate.id, type });
    setStatus('Rate card saved; the change is versioned in the audit trail.');
  }

  async function sendReminders() {
    // same engine and wording as Billing & Finance → Dues → Payment reminders
    const n = await runDueReminders({ force: true, only: (d) => d.category === type, actor: getPrincipal().name });
    setStatus(`Reminder sent to ${n} pending home${n === 1 ? '' : 's'} (${type}).`);
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 style={{ margin: 0 }}>Utility billing</h2>
          <p>Rate cards for each metered utility (water, DG and any you add), and collection progress. Meter readings are entered in the Meter readings tab and published as bills.</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <Tabs>
            {utilTypes.map((u) => <button key={u.name} className={type === u.name ? 'active' : ''} onClick={() => setType(u.name)}>{u.icon} {u.name} rate card</button>)}
          </Tabs>
          <h2>{type} rate card</h2>
          <p className="muted" style={{ marginTop: -6 }}>Bill = units consumed × rate + fixed charge + tax. Applied when a reading is published.</p>
          <div className="form-grid">
            <div className="field"><label>Rate / unit (₹)</label>
              {canEditTemplate ? (
                <input type="number" value={tplDraft.ratePerUnit} onChange={(e) => setTplDraft((d) => ({ ...d, ratePerUnit: Number(e.target.value) }))} />
              ) : <div className="ro-value">₹{tplDraft.ratePerUnit}</div>}
            </div>
            <div className="field"><label>Fixed charge (₹)</label>
              {canEditTemplate ? (
                <input type="number" value={tplDraft.fixedCharge} onChange={(e) => setTplDraft((d) => ({ ...d, fixedCharge: Number(e.target.value) }))} />
              ) : <div className="ro-value">₹{tplDraft.fixedCharge}</div>}
            </div>
            <div className="field"><label>Tax (₹)</label>
              {canEditTemplate ? (
                <input type="number" value={tplDraft.tax} onChange={(e) => setTplDraft((d) => ({ ...d, tax: Number(e.target.value) }))} />
              ) : <div className="ro-value">₹{tplDraft.tax}</div>}
            </div>
          </div>
          {canEditTemplate && (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="btn secondary" onClick={saveTemplateForm}>Save rate card</button>
            </div>
          )}
          {status && <p className="muted" style={{ marginTop: 10 }}>{status}</p>}
        </div>

        <div className="card">
          <h2>Collection progress · {type} {month}</h2>
          <ul className="list">
            <li><span>Bills published this month</span><b>{generated}</b></li>
            <li><span>Paid</span><b>{paid}</b></li>
            <li><span>Unpaid (all months)</span><b style={{ color: 'var(--amber)' }}>{pending.length}</b></li>
          </ul>
          {canEditTemplate && (
            <button className="btn secondary" style={{ width: '100%', marginTop: 12 }} onClick={sendReminders} disabled={pending.length === 0}>
              Send payment reminder{pending.length > 0 ? ` (${pending.length})` : ''}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

