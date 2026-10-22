import React, { useState } from 'react';
import SectionPage from '../../components/SectionPage.jsx';
import RichText from '../../components/RichText.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canReadCollection, canWriteCollection } from '../../lib/security/authz.js';
import { isSameName } from '../../lib/fuzzy.js';
import { validateGstin } from '../../lib/finance/itc.js';
import VendorWorkers from './VendorWorkers.jsx';
import { getPrincipal } from '../../lib/security/principal.js';
import { money } from '../../lib/locale.js';

const inr = (n) => money(n, { round: false });

function vendorStatCards(records) {
  const now = new Date();
  const withPaper = records.filter((v) => v.contractType === 'Contract' || v.contractType === 'AMC').length;
  const local = records.filter((v) => v.contractType === 'Local / no contract').length;
  const soon = records.filter((v) => {
    if (!v.contractEnds) return false;
    const days = (new Date(v.contractEnds) - now) / 86400000;
    return days >= 0 && days <= 60;
  }).length;
  return [
    { label: 'Vendors', value: records.length },
    { label: 'Contract / AMC', value: withPaper, sub: 'Paperwork attached to each' },
    { label: 'Local (no contract)', value: local, sub: 'Paid per job' },
    { label: 'Renewals due', value: soon, sub: 'Next 60 days' },
  ];
}

/** Everything paid to one vendor lives in the Payments Cross-check; this is a read-only window onto it. */
function VendorPayments({ vendor, onNavigate }) {
  const p = getPrincipal();
  const canSee = canReadCollection(COLLECTIONS.LEDGER, p);
  const { records: ledger } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check');
  const mine = ledger.filter((l) => l.vendor === vendor.name).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const total = mine.filter((l) => l.type === 'Debit').reduce((s, l) => s + (Number(l.amount) || 0), 0);

  return (
    <div className="ro-block">
      <h3>💰 Money paid to this vendor</h3>
      {!canSee ? (
        <p className="muted" style={{ margin: 0 }}>Payments are recorded by the Treasurer / Facility Manager in Billing &amp; Finance → Payments cross-check.</p>
      ) : mine.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No payments recorded yet. Add an entry in Payments cross-check and pick this vendor.</p>
      ) : (
        <>
          <ul className="list">
            {mine.slice(0, 6).map((l) => (
              <li key={l.id}>
                <span><b className="mono">{l.shortId}</b> · {l.description}<br /><small className="muted">{l.date} · {l.account}{l.taskRef ? ` · task ${l.taskRef}` : ''}</small></span>
                <b>{l.type === 'Credit' ? '+' : ''}{inr(l.amount)}</b>
              </li>
            ))}
          </ul>
          <div className="kv" style={{ marginTop: 8 }}><span>Total paid ({mine.length} entr{mine.length === 1 ? 'y' : 'ies'})</span><b>{inr(total)}</b></div>
        </>
      )}
      {canSee && onNavigate && <button type="button" className="link-btn" style={{ marginTop: 8 }} onClick={() => { try { sessionStorage.setItem('communityos:billingTab', 'vendors'); } catch { /* ignore */ } onNavigate('billing'); }}>Open the vendor ledger →</button>}
    </div>
  );
}

/** Internal chat about one vendor (visible to EC / Facility Manager / MEP / vendor managers). Not part of the audit trail. */
function VendorDiscussion({ vendor }) {
  const { currentUser, roleId } = useApp();
  const { records, save } = useCollection(COLLECTIONS.VENDOR_COMMENTS, 'Vendor Discussion');
  const [body, setBody] = useState('');
  const canPost = canWriteCollection(COLLECTIONS.VENDOR_COMMENTS, getPrincipal());
  const thread = records.filter((c) => c.vendorId === vendor.id).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  async function post() {
    if (isEmptyHtml(body)) return;
    const saved = await save({ vendorId: vendor.id, author: currentUser?.name, authorRoleId: roleId, body, createdAt: new Date().toISOString() });
    if (saved) setBody('');
  }

  return (
    <div className="ro-block">
      <h3>💬 Discussion about {vendor.name}</h3>
      {thread.length === 0 ? <p className="muted" style={{ margin: 0 }}>No discussion yet.</p> : (
        <div className="timeline">
          {thread.map((c) => (
            <div key={c.id}>
              <b>{c.author}</b>
              <RichText html={c.body} />
              <small>{new Date(c.createdAt).toLocaleString()}</small>
            </div>
          ))}
        </div>
      )}
      {canPost && (
        <div style={{ marginTop: 10 }}>
          <RichTextEditor value={body} onChange={setBody} placeholder="Add a note for the team — service issues, rate talks, renewal…" />
          <div style={{ textAlign: 'right', marginTop: 8 }}><button type="button" className="btn secondary" onClick={post}>Post</button></div>
        </div>
      )}
    </div>
  );
}

export default function VendorsModule({ onNavigate }) {
  return (
    <div>
      <SectionPage
        sectionId={COLLECTIONS.VENDORS}
        title="Vendors"
        description="Contracted, AMC and local vendors — contact details, documents and discussion. Money paid is tracked in Billing & Finance."
        recordName="vendor"
        formHelp="Add a supplier. A contract is optional — local vendors paid per job just need a name and phone. Attach contract or AMC papers below."
        statCards={vendorStatCards}
        onBeforeSave={(d, records) => {
          const dup = records.find((r) => r.id !== d.id && isSameName(r.name, d.name));
          if (dup) return `“${dup.name}” (${dup.shortId}) is already in the vendor list — open it instead of adding it again.`;
          const g = validateGstin(d.gstin);   // blank is fine: a vendor not registered for GST (no input credit is claimed on their bills)
          return !g.ok && !g.blank ? g.reason : '';
        }}
        search
        filters={[{ key: 'category', label: 'All categories' }, { key: 'contractType', label: 'All engagements' }]}
        dateFields={[{ key: 'contractEnds', label: 'Contract / AMC ends' }]}
        formExtra={(v) => (v?.id ? (
          <div style={{ display: 'grid', gap: 12 }}>
            <VendorWorkers vendor={v} />
            <VendorPayments vendor={v} onNavigate={onNavigate} />
            <VendorDiscussion vendor={v} />
          </div>
        ) : <p className="muted">Save the vendor first — then you can see payments and start a discussion here.</p>)}
      />
      <div style={{ marginTop: 24 }}>
        <SectionPage
          sectionId={COLLECTIONS.CATEGORY_MAP}
          title="Category coverage"
          description="Which vendor handles each ticket category, who coordinates it (Facility Manager / MEP / Executive Committee). New tasks use this to populate “Assign to”."
          recordName="category coverage rule"
          formHelp="Choose a task category and who looks after it. Tasks in that category offer these people in “Assign to”."
          filters={[{ key: 'vendor', label: 'All vendors' }]}
          baseSort={{ key: 'category', dir: 'asc' }}
        />
      </div>
    </div>
  );
}
