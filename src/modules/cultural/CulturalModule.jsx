import EventWorkPanel from '../eventwork/EventWorkPanel.jsx';
import PhotoGallery from './PhotoGallery.jsx';
import Brochure from './Brochure.jsx';
import DocumentPreview from '../../components/DocumentPreview.jsx';
import { defaultOnlineMode, DONATION_MODES } from '../../lib/region/paymentModes.js';
import { donationReceipt } from '../../lib/documents/builders.js';
import BudgetDashboard, { CreditDialog } from './BudgetDashboard.jsx';
import { actualOf, savingOf, toCredit, creditedOf } from '../../lib/culturalBudget.js';
import React, { useEffect, useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import DynamicForm from '../../components/DynamicForm.jsx';
import RecordModal from '../billing/RecordModal.jsx';
import RichText from '../../components/RichText.jsx';
import Combobox from '../../components/Combobox.jsx';
import { AttachmentList } from '../../components/Attachments.jsx';
import ActionMenu from '../../components/ActionMenu.jsx';
import { expenseStage } from '../billing/CulturalPayments.jsx';
import { recomputeEventTotals, nextReceiptNo } from '../../lib/culturalServer.js';
import { notify } from '../../lib/notify.js';
import Offerings from './Offerings.jsx';
import { isRepeating, occurrences, repeatLabel } from '../../lib/recurrence.js';
import PayPanel from '../../components/PayPanel.jsx';
import { claimPayment } from '../../lib/payments.js';
import { isSecondApprover } from '../../lib/security/authz.js';
import { useApprovalKit } from '../../lib/approval/usePlans.js';
import ExpenseReleases from '../approval/ExpenseReleases.jsx';
import { planState, decide as planDecide, stepWho } from '../../lib/approval/engine.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { fmtDate, money } from '../../lib/locale.js';
import Tabs from '../../components/Tabs.jsx';

const addYear = (s) => (s ? `${Number(s.slice(0, 4)) + 1}${s.slice(4)}` : s); // same calendar date next year
const weekday = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) : '');
const shown = (ev, k) => ev?.[k] !== 'No'; // section toggles default to visible

const inr = (n) => money(n, { round: false });
const dshort = (s) => fmtDate(s);
const when = (r) => `${dshort(r.date)}${r.startTime ? ` · ${r.startTime}${r.endTime ? `–${r.endTime}` : ''}` : ''}`;
const TAGS = { Rejected: 'red', Planning: 'orange', Open: 'blue', Completed: 'green', Cancelled: '', Pledged: 'orange', Received: 'green', 'Pending approval': 'orange', Approved: 'blue', Paid: 'green' };
const Tag = ({ v }) => <span className={`tag ${TAGS[v] || ''}`}>{v}</span>;

function csv(name, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const keys = Object.keys(rows[0] || {});
  const blob = new Blob([[keys.map(esc).join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join('\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Receipt({ d, ev, onClose }) {
  const [html, setHtml] = useState('');
  useEffect(() => { donationReceipt(d, ev).then(setHtml); }, [d, ev]);
  if (!html) return null;
  return (
    <>
      <div data-testid="receipt" className="sr-only">{html.replace(/<style>[\s\S]*?<\/style>/, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}</div>
      <DocumentPreview title={`Receipt ${d.receiptNo}`} html={html} fileName={d.receiptNo} onClose={onClose} />
    </>
  );
}

/** Donation / pledge form: residents pledge for their own villa; the committee records money received and issues the receipt. */
function DonationForm({ ev, record, manager, onClose, properties }) {
  const { currentUser } = useApp();
  const { save } = useCollection(C.CULTURAL_DONATIONS, 'Donations');
  const [f, setF] = useState(() => ({ kind: 'Donation', towards: 'General', mode: defaultOnlineMode(), status: manager ? 'Received' : 'Pledged', date: new Date().toISOString().slice(0, 10), anonymous: false, donor: manager ? '' : currentUser?.name || '', unit: manager ? '' : currentUser?.unit || '', amount: '', reference: '', note: '', ...record }));
  const [err, setErr] = useState({});
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e) {
    e.preventDefault();
    const er = {};
    if (!String(f.donor).trim()) er.donor = 'Donor name is required';
    if (!(Number(f.amount) > 0)) er.amount = 'Enter an amount above zero';
    if (!manager && !f.unit) er.unit = 'Your villa is not set on your profile - ask the office';
    setErr(er); if (Object.keys(er).length) return;
    let row = { ...f, eventId: ev.id, amount: Number(f.amount), status: manager ? f.status : 'Pledged' };
    if (manager && row.status === 'Received' && !row.receiptNo) row.receiptNo = await nextReceiptNo(ev);
    if (manager && row.status === 'Pledged') row.receiptNo = '';
    const saved = await save(row);
    if (!saved) return;
    await recomputeEventTotals(ev.id);
    if (manager && row.status === 'Received' && !record?.receiptNo && row.unit) notify({ event: 'cultural', title: `Receipt ${row.receiptNo} · ${ev.name}`, body: `Thank you! Your ${row.kind.toLowerCase()} of ${inr(row.amount)} was received. Receipt ${row.receiptNo} is under Cultural → Donations.`, link: `#/cultural/donation/${saved.id}`, toUnit: row.unit, by: currentUser?.name || '' }).catch(() => {});
    onClose(true, manager ? null : saved);
  }
  const unitOptions = (properties || []).map((p) => ({ value: p.unit, label: [p.unit, p.owner].filter(Boolean).join(' · ') }));
  return (
    <Modal title={manager ? (record?.id ? 'Edit donation' : 'Record a donation') : record?.id ? 'Edit your pledge' : 'Donate / pledge'} subtitle={manager ? 'Record money received; a receipt number is issued when it is marked Received.' : `Pledge now, you can pay by UPI QR right after, or hand it to the committee. They confirm receipt and issue your receipt.`} onClose={() => onClose(false)}>
      <form className="form-grid" onSubmit={submit} data-testid="donation-form">
        <div className={`field${err.donor ? ' invalid' : ''}`}><label>Donor name *</label><input aria-label="Donor name" value={f.donor} onChange={(e) => set('donor', e.target.value)} />{err.donor && <div className="field-error">{err.donor}</div>}</div>
        <div className={`field${err.unit ? ' invalid' : ''}`}><label>Villa / unit</label>{manager ? <Combobox value={f.unit} onChange={(v) => set('unit', v)} options={unitOptions} allowCustom placeholder="Search villa…" /> : <div className="ro-value">{f.unit || '—'}</div>}{err.unit && <div className="field-error">{err.unit}</div>}</div>
        <div className="field"><label>Type</label><select aria-label="Type" value={f.kind} onChange={(e) => set('kind', e.target.value)}><option>Donation</option><option>Sponsorship</option><option>In-kind</option></select></div>
        <div className="field"><label>Towards</label><select aria-label="Towards" value={f.towards} onChange={(e) => set('towards', e.target.value)}>{['General', 'Idol & decoration', 'Prasadam & food', 'Pooja & rituals', 'Cultural programmes', 'Sound & lights', 'Charity'].map((o) => <option key={o}>{o}</option>)}</select></div>
        <div className={`field${err.amount ? ' invalid' : ''}`}><label>{f.kind === 'In-kind' ? 'Value (₹) *' : 'Amount (₹) *'}</label><input type="number" min="0" aria-label="Amount" value={f.amount} onChange={(e) => set('amount', e.target.value)} />{err.amount && <div className="field-error">{err.amount}</div>}</div>
        <div className="field"><label>Date</label><input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} /></div>
        <div className="field"><label>Payment mode</label><select aria-label="Payment mode" value={f.mode} onChange={(e) => set('mode', e.target.value)}>{DONATION_MODES.map((o) => <option key={o}>{o}</option>)}</select></div>
        <div className="field"><label>UPI ref / cheque no.</label><input aria-label="Reference" value={f.reference} onChange={(e) => set('reference', e.target.value)} /></div>
        {manager && <div className="field"><label>Status</label><select aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}><option>Received</option><option>Pledged</option></select></div>}
        <div className="field" style={{ gridColumn: '1 / -1' }}><label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={!!f.anonymous} onChange={(e) => set('anonymous', e.target.checked)} /> Keep the donor name off public lists (the committee still sees it)</label></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>Note</label><textarea rows={2} value={f.note} onChange={(e) => set('note', e.target.value)} /></div>
        <div className="form-actions"><button type="submit" className="btn" data-testid="donation-save">{manager ? 'Save' : 'Submit pledge'}</button><button type="button" className="btn secondary" onClick={() => onClose(false)}>Cancel</button></div>
      </form>
    </Modal>
  );
}

/**
 * Sign-up list on a seva slot or a programme item. With `expected` (people per villa) the villa says how many are coming, starting from
 * the expected number; the capacity then counts people. Without it, one entry is one person (seva).
 */
export const headcount = (list) => (Array.isArray(list) ? list : []).reduce((n, x) => n + (Number(x.people) || 1), 0);
function Signup({ row, listKey, limit, canSign, manager, me, save, noun, expected = 0 }) {
  const list = Array.isArray(row[listKey]) ? row[listKey] : [];
  const mine = list.some((x) => x.name === me.name);
  const [people, setPeople] = useState(expected || 1);
  const total = headcount(list);
  const used = expected ? total : list.length;
  const full = limit > 0 && used >= limit;
  const unitOf = (x) => (x.unit ? ` (${x.unit.replace('Villa ', 'V')})` : '');
  return (
    <div style={{ marginTop: 6 }}>
      {limit > 0 && <div className="poll-bar-track" style={{ height: 6 }}><div className="poll-bar-fill" style={{ width: `${Math.min(100, (used / limit) * 100)}%` }} /></div>}
      <small className="muted" data-testid="signup-count">{expected ? `${list.length} villa${list.length === 1 ? '' : 's'} · ${total} ${total === 1 ? 'person' : 'people'}${limit > 0 ? ` of ${limit}` : ''}` : `${list.length}${limit > 0 ? ` of ${limit}` : ''} ${noun}`}{list.length ? ': ' : ''}{list.map((x) => `${x.name}${unitOf(x)}${expected && Number(x.people) > 0 ? ` ×${x.people}` : ''}`).join(', ')}</small>
      <div style={{ marginTop: 4, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {canSign && !mine && expected > 0 && (
          <span className="stepper" data-testid="signup-people"><button type="button" aria-label="Fewer people" onClick={() => setPeople((n) => Math.max(1, n - 1))}>−</button><b>{people}</b><button type="button" aria-label="More people" onClick={() => setPeople((n) => n + 1)}>+</button><small className="muted"> people</small></span>
        )}
        {canSign && !mine && <button type="button" className="btn sm" data-testid="signup" disabled={full} onClick={() => save({ ...row, [listKey]: [...list, { name: me.name, unit: me.unit || '', phone: '', ...(expected ? { people } : {}) }] })}>{full ? 'Full' : `Sign up`}</button>}
        {canSign && mine && <button type="button" className="btn secondary sm" data-testid="withdraw" onClick={() => save({ ...row, [listKey]: list.filter((x) => x.name !== me.name) })}>Withdraw</button>}
        {manager && list.length > 0 && <select aria-label="Remove a person" style={{ width: 'auto', fontSize: 12 }} value="" onChange={(e) => e.target.value && save({ ...row, [listKey]: list.filter((x) => x.name !== e.target.value) })}><option value="">Remove…</option>{list.map((x) => <option key={x.name}>{x.name}</option>)}</select>}
      </div>
    </div>
  );
}

export default function CulturalModule() {
  const { currentUser, role, roleId, roles, hasPermission, tabAllowed } = useApp();
  const manager = roleId === 'super_admin' || hasPermission('MANAGE_CULTURAL');
  const finance = manager || hasPermission('MANAGE_LEDGER');
  const resident = role?.category === 'Resident';
  const { records: events, save: saveEvent } = useCollection(C.CULTURAL_EVENTS, 'Cultural Events');
  const { records: programs, save: saveProgram } = useCollection(C.CULTURAL_PROGRAMS, 'Programme');
  const { records: broPages, save: saveBroPage } = useCollection(C.CULTURAL_BROCHURE, 'Event Brochure');
  const { records: sevas, save: saveSeva } = useCollection(C.CULTURAL_SEVAS, 'Seva');
  const { records: offerings, save: saveOfferingRow } = useCollection(C.CULTURAL_OFFERINGS, 'Seva Offerings');
  const { records: donations } = useCollection(C.CULTURAL_DONATIONS, 'Donations');
  const { save: saveDonation, remove: removeDonation } = useCollection(C.CULTURAL_DONATIONS, 'Donations');
  const { records: expenses, save: saveExpense } = useCollection(C.CULTURAL_EXPENSES, 'Event Expenses');
  const kit = useApprovalKit();
  const { records: relRows } = useCollection(C.RELEASES, 'Fund releases');
  const [relFor, setRelFor] = useState(null);
  // payees and approvers are read only when an expense's releases are opened
  const { records: vendorRows } = useCollection(C.VENDORS, 'Vendors', { enabled: !!relFor });
  const { records: userRows } = useCollection(C.USERS, 'Users', { enabled: !!relFor });
  const [evId, setEvId] = useState('');
  const [tab, setTab] = useState(() => { try { return sessionStorage.getItem('communityos:culturalTab') || 'overview'; } catch { return 'overview'; } });
  useEffect(() => { try { sessionStorage.removeItem('communityos:culturalTab'); } catch { /* ignore */ } }, []);
  // a notification or the Approvals list opened one record (#/cultural/expense|donation|event/<id>): its event, on the tab that shows it
  const [opened, setOpened] = useState(() => { try { return JSON.parse(sessionStorage.getItem('communityos:culturalOpen') || 'null'); } catch { return null; } });
  useEffect(() => {
    try { sessionStorage.removeItem('communityos:culturalOpen'); } catch { /* ignore */ }   // read once (an initialiser may run twice)
    const t = setTimeout(() => setOpened(null), 5000);   // not found (deleted, or not this person's to see): the usual event instead
    return () => clearTimeout(t);
  }, []);
  const [flash, setFlash] = useState('');
  const [modal, setModal] = useState(null); // {kind, record}
  const { records: properties } = useCollection(C.PROPERTIES, 'Properties', { enabled: modal?.kind === 'donation' });   // the unit list of the donation form only
  const [receipt, setReceipt] = useState(null);
  const [payFor, setPayFor] = useState(null); // {donation} | {event:true}
  const [agenda, setAgenda] = useState(false);
  const [q, setQ] = useState('');
  const [st, setSt] = useState('');
  const [year, setYear] = useState('');
  const [expQ, setExpQ] = useState('');
  const [expSort, setExpSort] = useState({ key: 'date', dir: 'desc' });
  const [view, setView] = useState('events');
  const [creditEv, setCreditEv] = useState(null);
  const sorted = useMemo(() => [...events].sort((a, b) => String(b.startDate).localeCompare(String(a.startDate))), [events]);
  useEffect(() => {
    if (!opened) return;
    const rec = opened.kind === 'expense' ? expenses.find((x) => x.id === opened.id) : opened.kind === 'donation' ? donations.find((d) => d.id === opened.id) : events.find((e) => e.id === opened.id);
    if (!rec) return;   // not loaded yet (or not visible to this person): wait for the lists
    setEvId(opened.kind === 'event' ? rec.id : rec.eventId); setView('events');
    setTab(opened.kind === 'expense' ? 'expenses' : opened.kind === 'donation' ? 'donations' : 'overview');
    setFlash(rec.id); setOpened(null);
    setTimeout(() => { document.querySelector(`[data-rec="${rec.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 300);
    setTimeout(() => setFlash(''), 4000);
  }, [opened, expenses, donations, events]);
  useEffect(() => { if (!evId && sorted.length && !opened) setEvId((sorted.find((e) => e.status === 'Open') || sorted[0]).id); }, [sorted, evId, opened]);
  const schemas = useApp().schemaFor;
  const ev = events.find((e) => e.id === evId);
  const yearOf = (e) => String(e?.startDate || '').slice(0, 4) || 'No date';
  const years = useMemo(() => [...new Set(sorted.map(yearOf))], [sorted]); // newest first
  const yearSel = years.includes(year) ? year : (ev ? yearOf(ev) : years[0]);
  const yearEvents = sorted.filter((e) => yearOf(e) === yearSel);
  useEffect(() => { if (ev) setYear(yearOf(ev)); }, [evId, ev?.startDate]); // eslint-disable-line react-hooks/exhaustive-deps -- follow the selected / newly created event's year
  const pickYear = (y) => { setYear(y); const first = sorted.filter((e) => yearOf(e) === y); const e = first.find((x) => x.status === 'Open') || first[0]; if (e) { setEvId(e.id); setTab('overview'); } };
  const me = { name: currentUser?.name || '', unit: currentUser?.unit || '' };
  const evPrograms = programs.filter((p) => p.eventId === evId).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  const evSevas = sevas.filter((s) => s.eventId === evId).sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  const evDon = donations.filter((d) => d.eventId === evId).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const evOfferings = offerings.filter((o) => o.eventId === evId).sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const evExp = expenses.filter((x) => x.eventId === evId).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const canSign = resident || manager;
  const approver = isSecondApprover(getPrincipal()); // Treasurer / President (configurable final approvers) / Super Admin
  const COMMITTEE = ['committee_cultural', 'president', 'general_secretary'];

  const today = () => new Date().toISOString().slice(0, 10);
  const me2 = currentUser?.name || '';
  const isEc = role?.category === 'EC' || roleId === 'super_admin';
  const ecRoleIds = (roles || []).filter((r) => r.category === 'EC').map((r) => r.id);
  const expPlan = (x) => kit.planOf(x, { subject: 'Cultural expense', amount: Number(x.amount) || Number(x.estimate) || 0, category: x.category, taskType: '', flags: needsFinal(x) ? ['eventFinal'] : [] }, 'expense');
  const needsFinal = (x) => !(Number(ev?.finalOver) > 0) || Number(x.amount) > Number(ev.finalOver);
  /** Short status chip text plus the full story (who approved, notes) for the tooltip. */
  const stageOf = (x) => {
    const st = expenseStage(x);
    const bits = [];
    if (x.ecApprovedBy) bits.push(`EC: ${x.ecApprovedBy}${x.ecApprovedAt ? ` · ${x.ecApprovedAt}` : ''}${x.ecNote ? ` — ${x.ecNote}` : ''}`);
    if (x.approvedBy && x.approvedBy !== x.ecApprovedBy) bits.push(`Final: ${x.approvedBy}${x.approvalNote ? ` — ${x.approvalNote}` : ''}`);
    else if (x.status === 'Approved' && x.finalRequired === false) bits.push('The EC made its approval the last step');
    return { ...st, detail: [st.text, ...bits].join('\n') };
  };
  const EXP_KEYS = { date: (x) => String(x.date || ''), item: (x) => String(x.item || '').toLowerCase(), category: (x) => String(x.category || '').toLowerCase(), vendor: (x) => String(x.vendor || '').toLowerCase(), fund: (x) => String(x.fund || '').toLowerCase(), amount: (x) => Number(x.amount) || 0, status: (x) => ({ ec: 0, final: 1, approved: 2, paid: 3, rejected: 4 }[expenseStage(x).step] ?? 9) };
  const shownExp = useMemo(() => {
    const q = expQ.trim().toLowerCase();
    const list = evExp.filter((x) => !q || `${x.item || ''} ${x.category || ''} ${x.vendor || ''}`.toLowerCase().includes(q));
    const get = EXP_KEYS[expSort.key] || EXP_KEYS.date; const dir = expSort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => { const x = get(a); const y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
  }, [evExp, expQ, expSort]); // eslint-disable-line react-hooks/exhaustive-deps
  const sortBy = (key) => setExpSort((o) => (o.key === key ? { key, dir: o.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'amount' || key === 'date' ? 'desc' : 'asc' }));
  const toRaiser = (x) => ({ toName: x.recordCreatedBy || undefined });
  async function ecDecide(x, ecApproval, route) {
    let note = '';
    if (ecApproval === 'Rejected') note = window.prompt('Reason for rejecting (shown to the committee):', '') || '';
    let plan = expPlan(x);
    if (route === 'treasurer' && !plan.steps.slice(1).some((s) => !s.skipped)) plan = { ...plan, steps: [...plan.steps, { id: `s${plan.steps.length + 1}`, name: 'Final approval', approvers: [{ kind: 'group', value: 'Final approvers' }], needed: 1, canFinish: false, deadlineDays: 0, decisions: [] }] };
    const res = planDecide(plan, me2, ecApproval, { finish: route === 'final', comment: note, at: today() });
    if (res.error) return;
    const final = res.plan.steps.slice(1).some((s) => !s.skipped);
    const approvedNow = ecApproval === 'Approved' && !final;
    const out = await saveExpense({ ...x, ...kit.planFields(res.plan, 'expense'), ecNote: note,
      status: ecApproval === 'Rejected' ? 'Rejected' : approvedNow ? 'Approved' : 'Pending approval',
      ...(ecApproval === 'Rejected' || approvedNow ? { approvedBy: me2, approvedAt: today(), approvalNote: note || (approvedNow ? 'EC approval was the last step' : '') } : {}) });
    if (!out) return;
    await recomputeEventTotals(ev.id);
    const link = `#/cultural/expense/${x.id}`;
    if (ecApproval === 'Rejected') notify({ event: 'cultural', title: `EC rejected expense · ${x.item}`, body: `${me2} rejected ${inr(x.amount)} for “${x.item}” (${ev.name})${note ? ` — ${note}` : ''}. You can edit and resubmit it.`, link, ...toRaiser(x), toRoleIds: COMMITTEE, by: me2 }).catch(() => {});
    else if (final) notify({ event: 'approval', title: `Final approval needed · ${x.item}`, body: `EC (${me2}) approved ${inr(x.amount)} for “${x.item}” (${ev.name}, ${x.fund || 'Cultural'} fund). It now needs the Treasurer / President: Cultural → Expenses.`, link, toRoleIds: ['treasurer', 'president'], by: me2 }).catch(() => {});
    else notify({ event: 'cultural', title: `Expense approved · ${x.item}`, body: `${me2} (EC) approved ${inr(x.amount)} for “${x.item}” (${ev.name}). It is under the Treasurer limit, so no further approval is needed.`, link, ...toRaiser(x), toRoleIds: COMMITTEE.concat(['treasurer']), by: me2 }).catch(() => {});
  }
  async function decide(x, status) {
    let note = '';
    if (status === 'Rejected') { note = window.prompt('Reason for rejecting (shown to the committee):', '') || ''; }
    let extra = {};
    if (status === 'Approved' || status === 'Rejected') {
      const res = planDecide(expPlan(x), me2, status, { comment: note, at: today() });
      if (res.error) return;
      const ps = planState(res.plan).key;
      if (ps === 'pending') status = 'Pending approval';
      extra = kit.planFields(res.plan, 'expense');
    }
    const out = await saveExpense({ ...x, ...extra, status, ...(status === 'Pending approval' ? {} : { approvedBy: me2, approvedAt: today(), approvalNote: note }) });
    if (!out) return;
    await recomputeEventTotals(ev.id);
    if (status !== 'Paid') notify({ event: 'cultural', title: `Expense ${status.toLowerCase()} (final) · ${x.item}`, body: `${me2 || 'The Treasurer'} ${status.toLowerCase()} ${inr(x.amount)} for “${x.item}” (${ev.name})${note ? ` — ${note}` : ''}.`, link: `#/cultural/expense/${x.id}`, ...toRaiser(x), toRoleIds: COMMITTEE, by: me2 }).catch(() => {});
  }
  async function resubmit(x) { const out = await saveExpense({ ...x, plan: '', status: 'Pending approval', approvedBy: '', approvedAt: '', approvalNote: '', ecApproval: 'Pending', ecApprovedBy: '', ecApprovedAt: '', ecNote: '', finalRequired: null }); if (out) { await recomputeEventTotals(ev.id); notify({ event: 'approval', title: `Expense resubmitted · ${x.item}`, body: `${me2} resubmitted ${inr(x.amount)} for “${x.item}” (${ev.name}). EC approval needed.`, link: `#/cultural/expense/${x.id}`, toRoleIds: ecRoleIds.length ? ecRoleIds : ['president', 'treasurer'], by: me2 }).catch(() => {}); } }
  /** The actual amount may be left out while an expense is only an estimate; it is needed before anyone approves or pays it. */
  function expenseBefore(draft, old) {
    const hasAmt = Number(draft.amount) > 0;
    if (!hasAmt && !(Number(draft.estimate) > 0)) return 'Enter an estimate, or the actual amount.';
    if (!hasAmt && ['Approved', 'Paid'].includes(old?.status || draft.status)) return 'The actual amount is needed once an expense is approved or paid.';
    return draft;
  }
  async function expenseSaved(saved, old) {
    await recomputeEventTotals(ev.id);
    if (!old && saved.status === 'Pending approval') notify({ event: 'approval', title: `Expense to approve · ${saved.item}`, body: `${currentUser?.name || 'The cultural committee'} raised ${inr(saved.amount)} for “${saved.item}” (${ev.name}, from the ${saved.fund || 'Cultural'} fund). EC approval needed first${needsFinal(saved) ? ', then the Treasurer' : ''}: Cultural → Expenses.`, link: `#/cultural/expense/${saved.id}`, toRoleIds: ecRoleIds.length ? ecRoleIds : ['president', 'treasurer'], by: currentUser?.name || '' }).catch(() => {});
  }

  async function saveEventForm(draft) {
    const old = events.find((e) => e.id === draft.id);
    const out = await saveEvent(draft);
    if (!out) return;
    if (out.visibility === 'Published' && old?.visibility !== 'Published') {
      notify({ event: 'cultural', title: `New event · ${out.name}`, body: `${out.name} (${dshort(out.startDate)}${out.venue ? `, ${out.venue}` : ''}) is open on the Cultural page — see the programme, sign up for seva and contribute.`, link: `#/cultural/event/${out.id}`, toRoleIds: ['owner', 'resident'], by: currentUser?.name || '' }).catch(() => {});
    }
    setEvId(out.id); setModal(null);
  }
  async function markReceived(d) {
    const no = d.receiptNo || await nextReceiptNo(ev);
    const out = await saveDonation({ ...d, status: 'Received', receiptNo: no, date: d.date || new Date().toISOString().slice(0, 10) });
    if (out) { await recomputeEventTotals(ev.id); if (d.unit) notify({ event: 'cultural', title: `Receipt ${no} · ${ev.name}`, body: `Thank you! Your ${(d.kind || 'donation').toLowerCase()} of ${inr(d.amount)} was received. Receipt ${no}.`, link: `#/cultural/donation/${out.id}`, toUnit: d.unit, by: currentUser?.name || '' }).catch(() => {}); }
  }
  async function withdraw(d) { if (!window.confirm('Withdraw this pledge?')) return; await removeDonation(d.id); await recomputeEventTotals(ev.id); }
  const closeRec = async (changed, row) => { setModal(null); if (changed && ev) await recomputeEventTotals(ev.id); if (row?.id && row.status === 'Pledged') setPayFor({ id: row.id }); };

  /** Copy an event as the starting point for the next one (same offerings, programme and seva slots, nobody signed up, dates a year later). */
  async function duplicateEvent() {
    if (!window.confirm(`Create a copy of “${ev.name}” for next time? Offerings, programme, brochure pages and seva slots are copied; donations and sign-ups are not.`)) return;
    const { id, shortId, collected, pledged, donors, families, spent, ...rest } = ev;
    const copy = await saveEvent({ ...rest, name: `${ev.name} (copy)`, status: 'Planning', visibility: 'Internal', brochureStatus: 'Draft', startDate: addYear(ev.startDate), endDate: addYear(ev.endDate), collected: 0, pledged: 0, donors: 0, families: 0, spent: 0 });
    if (!copy) return;
    for (const o of evOfferings) { const { id: a, shortId: b, reservedBy, reservedUnit, reservedAt, donationId, ...r } = o; await saveOfferingRow({ ...r, eventId: copy.id, reservedBy: '', reservedUnit: '', reservedAt: '', donationId: '' }); }
    for (const p of evPrograms) { const { id: a, shortId: b, ...r } = p; await saveProgram({ ...r, eventId: copy.id, date: addYear(p.date), participants: [] }); }
    for (const x of evSevas) { const { id: a, shortId: b, ...r } = x; await saveSeva({ ...r, eventId: copy.id, date: addYear(x.date), volunteers: [] }); }
    for (const x of broPages.filter((b) => b.eventId === ev.id)) { const { id: a2, shortId: b2, ...r } = x; await saveBroPage({ ...r, eventId: copy.id }); } // brochure pages (pictures are shared, not copied)
    setEvId(copy.id); setTab('overview');
  }
  const agendaText = () => {
    const byDay = {};
    evPrograms.forEach((p) => { (byDay[p.date] = byDay[p.date] || []).push(p); });
    return [`*${ev.name}*`, `${dshort(ev.startDate)}${ev.endDate && ev.endDate !== ev.startDate ? ` – ${dshort(ev.endDate)}` : ''}${ev.venue ? ` · ${ev.venue}` : ''}`, '',
      ...Object.keys(byDay).sort().flatMap((day) => [`*${weekday(day)}*`, ...byDay[day].map((p) => `• ${p.startTime || ''}${p.endTime ? `–${p.endTime}` : ''} ${p.title}${p.venue ? ` (${p.venue})` : ''}${p.lead ? ` – ${p.lead}` : ''}`), ''])].join('\n').trim();
  };

  const vis = (k) => manager || shown(ev, k);
  const tabs = [['overview', 'Overview'], ...(vis('showOfferings') ? [['offerings', ev?.offeringsTitle || 'Offerings']] : []), ...(vis('showProgramme') ? [['programme', 'Programme']] : []), ...((manager || (shown(ev, 'showBrochure') && ev?.brochureStatus === 'Published')) ? [['brochure', 'Brochure']] : []), ...(vis('showVolunteers') ? [['seva', 'Volunteer seva']] : []), ...(vis('showDonations') ? [['donations', resident ? 'My contributions' : 'Donations']] : []), ...(vis('showPhotos') ? [['photos', 'Photos']] : []), ...(finance ? [['expenses', 'Expenses']] : []), ...(!resident ? [['work', 'Work']] : [])].filter(([k]) => tabAllowed(`cultural.${k}`));
  const expectedFor = (p) => Number(p.peoplePerUnit) || Number(ev?.defaultPeople) || 0; // people per villa expected at this item (item overrides the event default; 0 = just count sign-ups)
  const payDonation = payFor?.id ? donations.find((d) => d.id === payFor.id) : null;
  const balance = (Number(ev?.collected) || 0) - (Number(ev?.spent) || 0);
  const shownDon = evDon.filter((d) => (!st || d.status === st) && (!q || `${d.donor} ${d.unit} ${d.receiptNo} ${d.towards}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div>
      <div className="page-head">
        <div><h1>Cultural</h1><p>Festivals and community events: programme, volunteer seva, donations with receipts, and expenses — in one place.</p></div>
        {manager && <button className="btn" data-testid="new-event" onClick={() => setModal({ kind: 'event', record: { status: 'Planning', visibility: 'Internal', type: 'Festival' } })}>+ New event</button>}
      </div>

      {finance && sorted.length > 0 && (
        <Tabs data-testid="cultural-view" style={{ margin: '0 0 8px' }}>
          {tabAllowed('cultural.events') && <button type="button" className={view === 'events' ? 'active' : ''} data-testid="view-events" onClick={() => setView('events')}>Events</button>}
          {tabAllowed('cultural.budget') && <button type="button" className={view === 'budget' ? 'active' : ''} data-testid="view-budget" onClick={() => setView('budget')}>Budget vs actual</button>}
        </Tabs>
      )}
      {finance && view === 'budget' && <BudgetDashboard events={sorted} canCredit={approver} onOpenEvent={(e) => { setEvId(e.id); setTab('overview'); setView('events'); }} />}
      {(view === 'budget' && finance) ? null : sorted.length === 0 ? <div className="card empty">No events yet.{manager ? ' Create the first one with “+ New event”.' : ' The cultural committee will publish events here.'}</div> : (
        <>
          <div className="pick-row pick-left" data-testid="year-picker">
            {years.length > 1 && (
              <select className="pick-year" data-testid="year-select" aria-label="Event year" value={yearSel} onChange={(e) => pickYear(e.target.value)}>
                {years.map((y) => <option key={y} value={y}>{y} ({sorted.filter((e) => yearOf(e) === y).length})</option>)}
              </select>
            )}
            <div data-testid="event-picker" className="pick-event">
              <select data-testid="event-select" aria-label="Event" value={evId || ''} onChange={(e) => { setEvId(e.target.value); setTab('overview'); }}>
                {yearEvents.map((e) => <option key={e.id} value={e.id}>{e.visibility === 'Internal' ? '🔒 ' : ''}{e.name}</option>)}
              </select>
            </div>
            {ev && ev.visibility === 'Published' && ev.status !== 'Completed' && ev.status !== 'Cancelled' && shown(ev, 'showDonations') && (
              <button type="button" className="btn sm good pick-upi" data-testid="event-qr" title="Contribute to this event: pay online, or by UPI" onClick={() => setPayFor({ event: true })}>💳 <span className="pick-upi-label">Contribute</span></button>
            )}
          </div>
          {ev && (
            <>
              <Tabs className="sub">{tabs.map(([k, l]) => <button key={k} type="button" data-testid={`ctab-${k}`} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}</Tabs>

              {tab === 'overview' && (
                <div data-testid="cultural-overview">
                  {finance && Number(ev.budget) > 0 && (
                    <div className="card" style={{ marginBottom: 12, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }} data-testid="budget-strip">
                      <span><small className="muted">Estimate</small><br /><b>{inr(ev.budget)}</b></span>
                      <span><small className="muted">Actual</small><br /><b>{actualOf(ev) ? inr(actualOf(ev)) : 'not entered'}</b></span>
                      {actualOf(ev) > 0 && <span><small className="muted">{Number(ev.budget) >= actualOf(ev) ? 'Under estimate' : 'Over estimate'}</small><br /><b style={{ color: Number(ev.budget) >= actualOf(ev) ? '#15803d' : '#c7364a' }}>{inr(Math.abs(Number(ev.budget) - actualOf(ev)))}</b></span>}
                      {creditedOf(ev) > 0 && <span className="tag blue">{inr(creditedOf(ev))} credited back to the fund</span>}
                      {toCredit(ev) > 0 && approver && <button type="button" className="btn good sm" data-testid="credit-event" onClick={() => setCreditEv(ev)}>Credit {inr(toCredit(ev))} unused to the fund</button>}
                      {toCredit(ev) > 0 && !approver && <small className="muted">{inr(toCredit(ev))} unused — the Treasurer can credit it back</small>}
                    </div>
                  )}
                  <div className="card" style={{ marginBottom: 12 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                      <div style={{ flex: 1, minWidth: 220 }}>
                        <h2 style={{ margin: 0 }}>{ev.name} <small className="mono muted" data-testid="event-id" title="Event ID">{ev.shortId}</small> <Tag v={ev.status} /> {ev.visibility === 'Internal' && <span className="tag">Internal · not shown to residents</span>}</h2>
                        <div className="muted">{ev.type} · {dshort(ev.startDate)}{ev.endDate && ev.endDate !== ev.startDate ? ` – ${dshort(ev.endDate)}` : ''}{ev.venue ? ` · ${ev.venue}` : ''}</div>
                        {isRepeating(ev) && (
                          <div data-testid="event-repeat" style={{ marginTop: 4 }}>
                            <span className="tag purple">{repeatLabel(ev)}</span>
                            <div className="muted" style={{ marginTop: 4 }}>Next: {occurrences(ev, { count: 4 }).map((d) => weekday(d)).join(' · ') || 'no more dates'}</div>
                          </div>
                        )}
                        {ev.description && <RichText html={ev.description} />}
                      </div>
                      {manager && <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button type="button" className="btn secondary sm" data-testid="edit-event" onClick={() => setModal({ kind: 'event', record: ev })}>Edit event & sections</button><button type="button" className="btn secondary sm" data-testid="dup-event" onClick={duplicateEvent}>⧉ Duplicate for next time</button></span>}
                    </div>
                  </div>
                  <div className="grid metrics" style={{ marginBottom: 12 }}>
                    <div className="card metric"><div className="label">Collected</div><div className="value" data-testid="m-collected">{inr(ev.collected)}</div><div className="muted">{ev.donors || 0} household{ev.donors === 1 ? '' : 's'}{ev.pledged ? ` · ${inr(ev.pledged)} pledged` : ''}</div></div>
                    <div className="card metric"><div className="label">Target</div><div className="value">{inr(ev.targetCollection)}</div>{ev.targetCollection > 0 && <div className="poll-bar-track" style={{ height: 6 }}><div className="poll-bar-fill" style={{ width: `${Math.min(100, ((ev.collected || 0) / ev.targetCollection) * 100)}%` }} /></div>}</div>
                    <div className="card metric"><div className="label">Spent</div><div className="value" data-testid="m-spent">{inr(ev.spent)}</div><div className="muted">Budget {inr(ev.budget)}</div></div>
                    <div className="card metric"><div className="label">Balance</div><div className="value" data-testid="m-balance" style={{ color: balance < 0 ? 'var(--red, #c0392b)' : undefined }}>{inr(balance)}</div><div className="muted">collected − spent</div></div>
                  </div>
                  <div className="card"><h3 style={{ marginTop: 0 }}>Coming up</h3>
                    {evPrograms.length === 0 ? <div className="muted">{'No programme yet.'}</div> : <ul className="list">{evPrograms.slice(0, 4).map((p) => <li key={p.id}><span style={{ flex: 1 }}><b>{p.title}</b><br /><small className="muted">{when(p)}{p.venue ? ` · ${p.venue}` : ''}</small></span></li>)}</ul>}
                    <div className="muted" style={{ marginTop: 6 }}>🙋 Seva: {evSevas.reduce((n, s) => n + (s.volunteers || []).length, 0)} of {evSevas.reduce((n, s) => n + (Number(s.needed) || 0), 0)} volunteer places filled</div>
                  </div>
                </div>
              )}

              {tab === 'offerings' && (
                <Offerings key={ev.id} ev={ev} offerings={evOfferings} manager={manager} canPledge={resident || finance || !!currentUser?.unit}
                  onEdit={(o) => setModal({ kind: 'offering', record: o })} onAdd={() => setModal({ kind: 'offering', record: { eventId: ev.id, kind: 'Fixed slot', pledgeValue: 30000 } })} />
              )}

              {tab === 'programme' && (
                <div className="card" data-testid="cultural-programme">
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}><h3 style={{ margin: 0 }}>Programme / agenda</h3>
                    <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {evPrograms.length > 0 && <button className="btn secondary sm" data-testid="share-agenda" onClick={() => setAgenda(true)}>Share / print agenda</button>}
                      {manager && <button className="btn secondary sm" data-testid="add-programme" onClick={() => setModal({ kind: 'program', record: { eventId: ev.id, date: ev.startDate, capacity: 0, participants: [] } })}>+ Add item</button>}</span></div>
                  {evPrograms.length === 0 && <div className="empty" data-testid="prog-empty">No programme items yet.</div>}
                  <ul className="list">{evPrograms.map((p) => (
                    <li key={p.id} style={{ alignItems: 'flex-start' }}><span style={{ flex: 1 }}><b>{p.title}</b> <small className="mono muted" data-testid="rec-id">{p.shortId}</small><br /><small className="muted">{when(p)}{p.venue ? ` · ${p.venue}` : ''}{p.lead ? ` · ${p.lead}` : ''}{expectedFor(p) > 0 ? ` · ${expectedFor(p)} per villa expected` : ''}</small>{p.notes && <div style={{ fontSize: 13 }}>{p.notes}</div>}
                      {(Number(p.capacity) > 0 || expectedFor(p) > 0) && <Signup row={p} listKey="participants" limit={Number(p.capacity)} expected={expectedFor(p)} canSign={canSign && ev.status !== 'Completed'} manager={manager} me={me} save={saveProgram} noun="signed up" />}</span>
                      {manager && <button className="btn secondary sm" onClick={() => setModal({ kind: 'program', record: p })}>Edit</button>}</li>
                  ))}</ul>
                </div>
              )}

              {tab === 'brochure' && <Brochure key={ev.id} ev={ev} manager={manager} programs={evPrograms} offerings={evOfferings} saveEvent={saveEvent} />}
              {tab === 'photos' && <PhotoGallery ev={ev} manager={manager} />}
              {tab === 'work' && <div className="card"><EventWorkPanel kind="Cultural event" eventId={ev.id} eventName={ev.name} eventDate={ev.startDate} /></div>}
              {tab === 'seva' && (
                <div className="card" data-testid="cultural-seva">
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><h3 style={{ margin: 0 }}>Seva — volunteer duties</h3>{manager && <button className="btn secondary sm" data-testid="add-seva" onClick={() => setModal({ kind: 'seva', record: { eventId: ev.id, date: ev.startDate, needed: 4, volunteers: [] } })}>+ Add duty</button>}</div>
                  {evSevas.length === 0 && <div className="empty">No volunteer duties yet.</div>}
                  <ul className="list">{evSevas.map((s) => (
                    <li key={s.id} style={{ alignItems: 'flex-start' }}><span style={{ flex: 1 }}><b>🙋 {s.title}</b> <small className="mono muted" data-testid="rec-id">{s.shortId}</small><br /><small className="muted">{when(s)}</small>{s.description && <div style={{ fontSize: 13 }}>{s.description}</div>}
                      <Signup row={s} listKey="volunteers" limit={Number(s.needed) || 0} canSign={canSign && ev.status !== 'Completed'} manager={manager} me={me} save={saveSeva} noun="volunteering" /></span>
                      {manager && <button className="btn secondary sm" onClick={() => setModal({ kind: 'seva', record: s })}>Edit</button>}</li>
                  ))}</ul>
                </div>
              )}

              {tab === 'donations' && (
                <div className="card" data-testid="cultural-donations">
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                    <h3 style={{ margin: 0, flex: 1 }}>{resident ? 'Your contributions' : 'Donations & sponsorships'}</h3>
                    {finance && <><input aria-label="Search donations" placeholder="Search donor, villa, receipt…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />
                      <select aria-label="Status filter" value={st} onChange={(e) => setSt(e.target.value)} style={{ width: 'auto' }}><option value="">All</option><option>Pledged</option><option>Received</option></select>
                      <button type="button" className="btn secondary sm" onClick={() => csv(`${ev.name}-donations.csv`, evDon.map((d) => ({ Receipt: d.receiptNo, Date: d.date, Donor: d.donor, Unit: d.unit, Type: d.kind, Towards: d.towards, Amount: d.amount, Mode: d.mode, Reference: d.reference, Status: d.status })))}>⬇ CSV</button></>}
                    {ev.status !== 'Completed' && ev.status !== 'Cancelled' && <button className="btn" data-testid="donate" onClick={() => setModal({ kind: 'donation', record: null })}>{finance ? '+ Record donation' : '❤ Donate / pledge'}</button>}
                  </div>
                  {ev.upiId && <div className="notice" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><span style={{ flex: 1 }}>Pay by UPI to <b>{ev.upiId}</b> — scan the QR on your phone. The committee verifies the payment and issues your receipt.</span><button type="button" className="btn secondary sm" data-testid="donations-qr" onClick={() => setPayFor({ event: true })}>📱 UPI QR</button></div>}
                  {shownDon.length === 0 ? <div className="empty">{resident ? 'You have not contributed to this event yet.' : 'No donations match.'}</div> : (
                    <table className="table"><thead><tr><th>Date</th><th>Donor</th><th>Villa</th><th>Type · towards</th><th>Amount</th><th>Status</th><th>Receipt</th><th /></tr></thead>
                      <tbody>{shownDon.map((d) => (
                        <tr key={d.id} data-testid="donation-row" data-rec={d.id} className={flash === d.id ? 'row-flash' : ''}><td data-label="Date">{dshort(d.date)} <small className="mono muted" data-testid="rec-id" style={{ display: 'block' }}>{d.shortId}</small></td><td data-label="Donor">{d.donor}{d.anonymous && finance ? ' 🕶' : ''}</td><td data-label="Villa">{d.unit || '—'}</td><td data-label="Type">{d.kind} · {d.towards}{d.offeringId && d.note ? <small className="muted" style={{ display: 'block' }}>{d.note}{d.sankalpam ? ` · “${d.sankalpam}”` : ''}</small> : null}</td><td data-label="Amount"><b>{inr(d.amount)}</b></td><td data-label="Status"><Tag v={d.status} />{d.status === 'Pledged' && d.paymentClaimedAt ? <small className="tag blue" data-testid="claimed-tag" style={{ marginLeft: 4 }}>Paid — verify UTR {d.reference}</small> : null}</td><td data-label="Receipt">{d.receiptNo ? <button type="button" className="link-btn" data-testid="open-receipt" onClick={() => setReceipt(d)}>{d.receiptNo}</button> : '—'}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {d.status === 'Pledged' && (d.unit === me.unit || finance) && <button type="button" className="btn sm" data-testid="pay-pledge" onClick={() => setPayFor({ id: d.id })}>Pay</button>}{' '}
                            {finance && d.status === 'Pledged' && <button type="button" className="btn good sm" data-testid="mark-received" onClick={() => markReceived(d)}>Mark received</button>}{' '}
                            {(finance || d.status === 'Pledged') && <button type="button" className="btn secondary sm" onClick={() => setModal({ kind: 'donation', record: d })}>Edit</button>}{' '}
                            {!finance && d.status === 'Pledged' && <button type="button" className="btn secondary sm" onClick={() => withdraw(d)}>Withdraw</button>}
                          </td></tr>
                      ))}</tbody></table>
                  )}
                </div>
              )}

              {tab === 'expenses' && finance && (
                <div className="card" data-testid="cultural-expenses">
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}><h3 style={{ margin: 0, flex: 1 }}>Expenses</h3>
                    <button type="button" className="btn secondary sm" onClick={() => csv(`${ev.name}-expenses.csv`, evExp.map((x) => ({ Date: x.date, Item: x.item, Category: x.category, PaidTo: x.vendor, Amount: x.amount, Status: x.status })))}>⬇ CSV</button>
                    <button className="btn" data-testid="add-expense" onClick={() => setModal({ kind: 'expense', record: { eventId: ev.id, status: 'Pending approval', ecApproval: 'Pending', fund: ev.fund || 'Cultural', date: new Date().toISOString().slice(0, 10) } })}>+ Add expense</button></div>
                  {evExp.length > 0 && (
                    <div className="exp-tools" data-testid="expense-tools">
                      <input type="search" aria-label="Search expenses" data-testid="expense-search" placeholder="Search item, category or paid to…" value={expQ} onChange={(e) => setExpQ(e.target.value)} />
                      <select aria-label="Sort expenses" data-testid="expense-sort" value={`${expSort.key}:${expSort.dir}`} onChange={(e) => { const [key, dir] = e.target.value.split(':'); setExpSort({ key, dir }); }}>
                        {[['date', 'Date'], ['item', 'Item'], ['category', 'Category'], ['vendor', 'Paid to'], ['amount', 'Amount'], ['status', 'Status']].flatMap(([k, l]) => [<option key={`${k}d`} value={`${k}:desc`}>{l} ↓</option>, <option key={`${k}a`} value={`${k}:asc`}>{l} ↑</option>])}
                      </select>
                      <small className="muted">{shownExp.length} of {evExp.length}</small>
                    </div>
                  )}
                  {evExp.length === 0 ? <div className="empty">No expenses recorded.</div> : shownExp.length === 0 ? <div className="empty">No expense matches “{expQ}”.</div> : (
                    <table className="table sortable" data-testid="expense-table"><thead><tr>
                      {[['date', 'Date'], ['item', 'Item'], ['category', 'Category'], ['vendor', 'Paid to'], ['fund', 'Fund'], ['amount', 'Amount'], ['status', 'Status']].map(([k, l]) => <th key={k} data-testid={`sort-${k}`} aria-sort={expSort.key === k ? (expSort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} onClick={() => sortBy(k)}>{l} {expSort.key === k && <span className="arr">{expSort.dir === 'asc' ? '▲' : '▼'}</span>}</th>)}
                      <th title="Bills attached">Bills</th><th /></tr></thead>
                      <tbody>{shownExp.map((x) => {
                        const st = stageOf(x);
                        const files = (x.attachments || []).length;
                        const noAmount = !(Number(x.amount) > 0);
                        const ecCan = !noAmount && isEc && x.status === 'Pending approval' && (x.ecApproval || 'Pending') === 'Pending' && (x.recordCreatedBy !== me2 || roleId === 'super_admin');
                        const underLimit = !needsFinal(x);
                        const ecActions = [
                          { key: 'send', label: 'Approve & send to Treasurer', hint: 'The Treasurer / President gives the final approval', onClick: () => ecDecide(x, 'Approved', 'treasurer') },
                          { key: 'final', label: 'Approve — this is the last step', hint: underLimit ? 'Under this event’s Treasurer limit' : 'No Treasurer approval; it goes straight to Payments', onClick: () => ecDecide(x, 'Approved', 'final') },
                          { key: 'reject', label: 'Reject', tone: 'bad', onClick: () => ecDecide(x, 'Rejected') },
                        ];
                        if (underLimit) [ecActions[0], ecActions[1]] = [ecActions[1], ecActions[0]];
                        return (
                          <tr key={x.id} style={{ cursor: 'pointer' }} data-testid="expense-row" data-rec={x.id} className={flash === x.id ? 'row-flash' : ''} onClick={() => setModal({ kind: 'expense', record: x })}>
                            <td data-label="Date">{dshort(x.date)}</td><td data-label="Item"><b>{x.item}</b> <small className="mono muted" data-testid="rec-id">{x.shortId}</small></td><td data-label="Category">{x.category}</td><td data-label="Paid to">{x.vendor || '—'}</td>
                            <td data-label="Fund" data-testid="expense-fund">{x.fund || '—'}</td><td data-label="Amount">{noAmount ? <span className="muted" title="Actual amount not entered yet">{Number(x.estimate) > 0 ? `≈ ${inr(x.estimate)} est.` : '—'}</span> : inr(x.amount)}</td>
                            <td data-label="Status" data-testid="expense-stage"><span className={`tag status-chip ${st.tone}`} title={st.detail}>{st.text}</span></td>
                            <td data-label="Bills" data-testid="expense-bills">{files ? <span className="att-dot" title={`${files} file${files === 1 ? '' : 's'} attached`} aria-label={`${files} bill${files === 1 ? '' : 's'} attached`}>📎{files > 1 ? ` ${files}` : ''}</span> : <span className="muted" title="No bill attached">—</span>}</td>
                            <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                              {x.status !== 'Rejected' && (manager || isEc || finance) && (() => { const n = relRows.filter((r) => r.expenseId === x.id && r.status !== 'Rejected').length; return (x.status !== 'Paid' || n > 0) ? <button type="button" className="btn secondary sm" data-testid="exp-releases" onClick={() => setRelFor(x)}>{n ? `Releases (${n})` : 'Release…'}</button> : null; })()}
                              {x.status === 'Pending approval' && noAmount && <small className="muted" data-testid="need-amount">Enter the actual amount to send it for approval</small>}
                              {ecCan && <ActionMenu label="EC decision" actions={ecActions} testid="ec-decide-expense" align="right" />}
                              {x.status === 'Pending approval' && x.ecApproval === 'Approved' && kit.mayDecide(expPlan(x), x) && <><button type="button" className="btn good sm" data-testid="approve-expense" onClick={() => decide(x, 'Approved')}>Final approve</button>{' '}<button type="button" className="btn danger sm" data-testid="reject-expense" onClick={() => decide(x, 'Rejected')}>Reject</button></>}
                              {approver && x.status === 'Approved' && <button type="button" className="btn sm" data-testid="pay-expense" onClick={() => decide(x, 'Paid')}>Mark paid</button>}
                              {x.status === 'Rejected' && <button type="button" className="btn secondary sm" data-testid="resubmit-expense" onClick={() => resubmit(x)}>Resubmit</button>}
                            </td></tr>);
                      })}</tbody></table>
                  )}
                  <p className="muted" style={{ marginBottom: 0 }}>Every expense is raised by the committee. An EC member decides the next step: send it to the Treasurer (or President) for final approval, or make the EC approval the last step. Approved expenses then wait in Payments → Cultural for the Treasurer to pay. Click a row to see or edit it; hover a status for who approved it.</p>
                </div>
              )}
            </>
          )}
        </>
      )}

      {modal?.kind === 'event' && (
        <Modal title={modal.record.id ? 'Edit event' : 'New event'} subtitle="Residents only see events marked Published." onClose={() => setModal(null)}>
          <DynamicForm schema={schemas(C.CULTURAL_EVENTS)} roleId={roleId} record={modal.record} onSave={saveEventForm} onCancel={() => setModal(null)} />
        </Modal>
      )}
      {modal?.kind === 'program' && <RecordModal collection={C.CULTURAL_PROGRAMS} label="Programme" record={modal.record} hide={['eventId']} allowDelete onClose={closeRec} />}
      {modal?.kind === 'offering' && <RecordModal collection={C.CULTURAL_OFFERINGS} label="Seva Offerings" record={modal.record} hide={['eventId']} allowDelete onClose={closeRec} />}
      {modal?.kind === 'seva' && <RecordModal collection={C.CULTURAL_SEVAS} label="Seva" record={modal.record} hide={['eventId']} allowDelete onClose={closeRec} />}
      {relFor && <ExpenseReleases expense={relFor} event={ev} kit={kit} canAsk={manager || isEc} vendors={vendorRows} users={userRows} onClose={() => setRelFor(null)} />}
      {modal?.kind === 'expense' && <RecordModal collection={C.CULTURAL_EXPENSES} label="Event Expenses" record={modal.record} hide={['eventId', 'status']} allowDelete beforeSave={expenseBefore} onSaved={expenseSaved} onClose={closeRec} />}
      {modal?.kind === 'donation' && ev && <DonationForm ev={ev} record={modal.record} manager={finance} properties={properties} onClose={closeRec} />}
      {payFor && ev && (payFor.event || payDonation) && (
        <PayPanel ev={ev} donation={payFor.event ? null : payDonation} amount={payFor.event ? 0 : undefined} title={payFor.event ? `Contribute to ${ev.name}` : 'Pay your pledge'} onClose={() => setPayFor(null)}
          onClaim={async (utr) => { await claimPayment(payDonation, utr, saveDonation, ev, currentUser?.name || ''); }} onPaid={() => {}}
          onPledge={payFor.event ? async (amount) => { const row = await saveDonation({ eventId: ev.id, donor: me.name || currentUser?.name || 'Resident', unit: me.unit || '', kind: 'Donation', towards: 'General', amount, date: new Date().toISOString().slice(0, 10), mode: 'Online', reference: '', status: 'Pledged', receiptNo: '', anonymous: false }); if (row) await recomputeEventTotals(ev.id); return row; } : undefined} />
      )}
      {agenda && ev && (
        <Modal title={`Agenda · ${ev.name}`} subtitle="Copy to WhatsApp / notice board, or print." onClose={() => setAgenda(false)}>
          <pre data-testid="agenda-text" style={{ whiteSpace: 'pre-wrap', background: '#f6f6f6', padding: 10, borderRadius: 6, maxHeight: 320, overflow: 'auto' }}>{agendaText()}</pre>
          <div className="form-actions"><button type="button" className="btn" data-testid="agenda-copy" onClick={() => navigator.clipboard?.writeText(agendaText())}>Copy text</button><button type="button" className="btn secondary" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(`<pre style="font:16px Arial;white-space:pre-wrap">${agendaText().replace(/</g, '&lt;')}</pre>`); w.document.close(); w.print(); } }}>🖨 Print</button><button type="button" className="btn secondary" onClick={() => setAgenda(false)}>Close</button></div>
        </Modal>
      )}
      {receipt && ev && <Receipt d={receipt} ev={ev} onClose={() => setReceipt(null)} />}
      {creditEv && <CreditDialog ev={creditEv} onClose={() => setCreditEv(null)} onDone={() => setCreditEv(null)} />}
    </div>
  );
}
