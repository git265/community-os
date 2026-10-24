import { openSession, clockIn, clockOut } from '../../lib/attendance.js';
import FilePreview from '../../components/FilePreview.jsx';
import AdminDelete from '../../components/AdminDelete.jsx';
import { useDeleteVerdict, DeleteBlockedNote } from '../../components/DeleteGuard.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDataSource } from '../../lib/storage/dataSource.js';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { secureStorage } from '../../lib/storage/secureStorage.js';
import ServerTable from '../../components/ServerTable.jsx';
import RecordMeta from '../../components/RecordMeta.jsx';
import CategoryPicker from '../../components/CategoryPicker.jsx';
import InfoTip from '../../components/InfoTip.jsx';
import QuickIssues from './QuickIssues.jsx';
import ServiceNotices, { OutageGuard, outageVerdict, useMyBlock } from './ServiceNotices.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import RichText from '../../components/RichText.jsx';
import SectionPage from '../../components/SectionPage.jsx';
import { AttachmentList, AttachmentPicker } from '../../components/Attachments.jsx';
import CustomFields from '../../components/CustomFields.jsx';
import { persistPending, isImageMeta } from '../../lib/files/attachments.js';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';
import { TICKET_CATEGORIES } from '../../lib/schema/registry.js';
import Modal from '../../components/Modal.jsx';
import { SegTabs, Segmented, StatTiles, MoneyTiles } from '../../components/ui.jsx';
import CommentThread from './CommentThread.jsx';
import TaskTypesPanel from './TaskTypesPanel.jsx';
import PlannedWorks from './PlannedWorks.jsx';
import TicketQueue, { QueueAvailability, QueuePlace } from './TicketQueue.jsx';
import PaymentRequest from '../approval/PaymentRequest.jsx';
import { isQueueType } from '../../lib/ticketQueue.js';
import { tell } from '../../lib/net/activity.js';
import Wishlist from './Wishlist.jsx';
import AssetBackDialog from '../infra/AssetBackDialog.jsx';
import AssetField from './AssetField.jsx';
import FaultyAssets from './FaultyAssets.jsx';
import { categoryFor, repairKindOf } from '../infra/AssetTaskDialog.jsx';
import ApproversPanel from './ApproversPanel.jsx';
import ApprovalRules from '../approval/ApprovalRules.jsx';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import QuotationsPanel from './QuotationsPanel.jsx';
import LedgerLink from './LedgerLink.jsx';
import { usePrompt } from '../../components/PromptDialog.jsx';
import {
  CORE_STATUSES, tradeFromRoleName, teamFor, creatableTaskTypes, stageApplies, visibleTicketsFor,
  withinEditWindow, isInternalType, assigneesForCategory, todayIso, approvalSteps, approvalState, slaLabel, slaInfo, finalApproverRoleIds, invoiceApproval, readyToClose, ledgerEntryForTask, visibleCommentsFor,
} from './ticketEngine.js';
import { uuid } from '../../lib/uuid.js';
import { liveDebits } from '../../lib/approval/moneyGuard.js';
import { useApprovalKit } from '../../lib/approval/usePlans.js';
import { parseJson } from '../../lib/approval/kit.js';
import ReleasesPanel from '../approval/ReleasesPanel.jsx';
import { releaseSummary } from '../../lib/approval/releases.js';
import { moneyPosition } from '../../lib/approval/position.js';
import { money } from '../../lib/locale.js';
import Tabs, { usePhone } from '../../components/Tabs.jsx';
import PageActions from '../../components/PageActions.jsx';

const EMOJI = { Plumbing: '🔧', Electrical: '⚡', MEP: '🌀', Carpentry: '🪚', Housekeeping: '🧹', Gardening: '🌿', Landscape: '🌳', Security: '🛡', Amenities: '🎾', Cultural: '🎭', Helpdesk: '💬', General: '🧰', Other: '📋' };
/** Super Admin only. Hidden (with the reason) while payments are recorded against the task. */
function TaskDelete({ ticket, onDone }) {
  const { roleId } = useApp();
  const v = useDeleteVerdict(COLLECTIONS.TICKETS, ticket);
  if (roleId !== 'super_admin' || !v.checked) return null;
  return v.blocked ? <DeleteBlockedNote message={v.message} /> : <div style={{ textAlign: 'right' }}><AdminDelete collection={COLLECTIONS.TICKETS} id={ticket.id} label="task" onDone={onDone} /></div>;
}

const LIVE_STATUSES = ['Open', 'Assigned', 'In Progress', 'On Hold', 'Completed', 'Reopened'];
/** The tickets the Maintenance page works from: on the server the live ones only (one filtered read, not every ticket ever raised); the browser
 *  demo keeps all its tickets in memory anyway. Read again whenever tickets change. */
function usePageTickets() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const v2 = getDataSource().mode === 'v2';
      const rows = v2 ? await (await import('../../lib/storage/v2/V2ApiAdapter.js')).liveTicketsV2() : await secureStorage.list(COLLECTIONS.TICKETS);
      setRecords(rows);   // on the server the rows are already the ones this person may see
    } catch (err) {
      if (err?.name !== 'AuthzError') window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: `Maintenance could not be loaded: ${err?.message || 'error'}` } }));
      setRecords([]);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    refresh();
    const h = (e) => { if (e.detail?.collection === COLLECTIONS.TICKETS) refresh(); };
    window.addEventListener('communityos:changed', h);
    return () => window.removeEventListener('communityos:changed', h);
  }, [refresh]);
  return { records, loading, refresh };
}
/** Where the work is, as one highlighted pill (the unit, or the place in the community), so a technician spots it at a glance. */
function LocPill({ t, big }) {
  const community = t.scope === 'Community';
  const text = community ? (t.location || 'Community area') : (t.unit || 'Common area');
  return <span className={`loc-pill${big ? ' lg' : ''}`} data-testid="tk-loc-pill" title="Location">{community ? '🏘' : '📍'} {text}</span>;
}
// Summary cards above the table; clicking one filters the table (the filter is merged into the table's base filters).
const SUMMARY_FILTERS = {
  all: { status: LIVE_STATUSES },   // everything still being worked on: Closed and Cancelled load only from their own tile or the status filter
  open: { status: ['Open', 'Reopened'] },
  progress: { status: ['Assigned', 'In Progress'] },
  hold: { status: 'On Hold' },
  completed: { status: 'Completed' },
  closed: { status: 'Closed' },
  critical: { status: LIVE_STATUSES, priority: ['High', 'Critical'] },
  live: { status: LIVE_STATUSES },
  overdue: { status: LIVE_STATUSES }, // narrowed to the past-SLA ids below
};
/** On the v2 back end the tiles' counts come from the server (GET /summary/tickets: counted from the rows this person may see, with the list's
 *  own rules), so the page does not need every ticket to count them. Refreshed when tickets change. null elsewhere / until loaded. */
function useTicketSummary() {
  const on = getDataSource().mode === 'v2';
  const [sum, setSum] = useState(null);
  useEffect(() => {
    if (!on) return undefined;
    let live = true;
    const load = () => import('../../lib/storage/v2/V2ApiAdapter.js').then((m) => m.v2Summary('tickets')).then((x) => { if (live) setSum(x); }).catch(() => { /* keep the page's own counts */ });
    load();
    const h = (e) => { const c = e?.detail?.collection; if (!c || c === 'tickets') load(); };
    window.addEventListener('communityos:changed', h);
    return () => { live = false; window.removeEventListener('communityos:changed', h); };
  }, [on]);
  return sum;
}
// the five tones (styles.css, Round 48): not started grey, moving blue, waiting amber, done green; red is kept for real problems
const TAG_CLASS = { Open: '', Assigned: 'blue', 'In Progress': 'blue', 'On Hold': 'orange', Completed: 'green', Closed: 'green', Cancelled: '', Reopened: 'orange' };
const RESET_APPROVALS = { plan: '', finalRequired: null, ecApproval: 'Pending', ecApprovedBy: '', ecApprovedAt: '', treasurerApproval: 'Pending', treasurerApprovedBy: '', treasurerApprovedAt: '' };

/** Residents don't pick an SLA; one is set from the priority so it is never empty (an EC member can change it). */
const defaultSla = (priority) => { const d = new Date(); d.setDate(d.getDate() + ({ Critical: 0, High: 1, Medium: 3, Low: 7 }[priority] ?? 3)); return d.toISOString().slice(0, 10); };

function blankRaiseForm() {
  return { taskType: '', title: '', description: '', unit: '', category: '', subCategory: '', priority: 'Medium', preferredTime: '', assignedTo: '', slaDueAt: '', financial: false, assetId: '', assetName: '', outageOk: false };
}

function todayLabel() {
  return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

// The ticket fields edited in the detail FORM. Nothing here is saved until "Save changes" is pressed.
const DRAFT_DEFAULTS = {
  priority: '', assignedTo: '', slaDueAt: '', description: '', status: '', awaitingParts: false, materialsCost: 0, residentRating: 0,
  financial: false, approvedAmount: 0, invoiceApprovalMode: 'Required', selectedQuotationId: '', selectedQuotationIds: [], selectedInvoiceId: '', approvalStage: '', paymentStatus: 'Not Paid',
  finalRequired: null, ecApproval: 'Pending', ecApprovedBy: '', ecApprovedAt: '', treasurerApproval: 'Pending', treasurerApprovedBy: '', treasurerApprovedAt: '',
  attachments: [], cancelReason: '',
};
const DRAFT_KEYS = Object.keys(DRAFT_DEFAULTS);
function pickDraft(t, extra = []) {
  const d = {};
  [...DRAFT_KEYS, ...extra].forEach((k) => { d[k] = t?.[k] ?? DRAFT_DEFAULTS[k]; });
  return d;
}

function CoverageHint({ row, fallback, roles = [], extra = null }) {
  const coordNames = (Array.isArray(row?.coordinator) ? row.coordinator : []).map((id) => roles.find((r) => r.id === id)?.name || id).join(', ');
  return (
    <InfoTip label="Who can be assigned, and why">
      {!row ? <>No coverage is defined for this category yet (Maintenance → Category coverage).</> : (
        <>
          {coordNames && <>Coordinated by: <b>{coordNames}</b> · </>}
          {row.vendor ? <>Vendor: <b>{row.vendor}</b></> : <>No contracted vendor</>}
          {fallback && <> · showing all EC members</>}
        </>
      )}
      {extra && <div style={{ marginTop: 6 }}>{extra}</div>}
    </InfoTip>
  );
}

/** `embeddedRef` + `onEmbeddedClose`: show only one task's details on top of another screen (e.g. Billing) instead of the whole Maintenance page. */
export default function TicketsModule({ embeddedRef = null, onEmbeddedClose = null, onNavigate = null }) {
  const { roleId, role, roles, currentUser, hasPermission, tabAllowed, schemaFor } = useApp();
  // saves only through this one: the page's own list is the live tickets (on the server; the browser demo keeps all), plus a closed one opened on its own
  const { save: saveTicket } = useCollection(COLLECTIONS.TICKETS, 'Maintenance', { enabled: false });
  const liveT = usePageTickets();
  const [extraT, setExtraT] = useState(null);
  const tickets = useMemo(() => (extraT && !liveT.records.some((t) => t.id === extraT.id) ? [...liveT.records, extraT] : liveT.records), [liveT.records, extraT]);
  const refreshTickets = liveT.refresh;
  const { records: taskTypes, loading: typesLoading } = useCollection(COLLECTIONS.TASK_TYPES, 'Task Types');
  const { records: approverRows } = useCollection(COLLECTIONS.APPROVER_SETTINGS, 'Final Approvers');
  const { records: ecRoles } = useCollection(COLLECTIONS.EC_ROLES, 'EC Roster');
  const { records: vendors } = useCollection(COLLECTIONS.VENDORS, 'Vendors');
  const { records: coverage } = useCollection(COLLECTIONS.CATEGORY_MAP, 'Category Coverage');
  const allCategories = useMemo(() => [...new Set([...TICKET_CATEGORIES, ...coverage.map((c) => c.category).filter(Boolean)])], [coverage]);
  // owners, residents and the trades' handymen never see a task's money side, so its lists are not read for them (the server refuses them anyway)
  const moneyReader = role?.category !== 'Resident' && !(String(roleId || '').startsWith('handyman_') && roleId !== 'handyman_mep');
  const { records: allDocs, save: saveDoc } = useCollection(COLLECTIONS.QUOTATIONS, 'Quotations', { enabled: moneyReader });
  const { records: handymen, save: saveHandyman } = useCollection(COLLECTIONS.HANDYMEN, 'Field Staff');
  const { records: quickPhrases } = useCollection(COLLECTIONS.QUICK_PHRASES, 'Ticket Quick Phrases');

  // a planned works reminder opens its tab (App sets communityos:openTab)
  const [tabRaw, setTab] = useState(() => { try { if (sessionStorage.getItem('communityos:openTab') === 'planned') { sessionStorage.removeItem('communityos:openTab'); return 'planned'; } } catch { /* ignore */ } return 'tickets'; });
  const [selectedId, setSelectedId] = useState(null);
  const phoneView = usePhone();
  // Jumped here from another screen (e.g. a financial task in the Payments Cross-check): open that task's details.
  useEffect(() => {
    let want = null;
    if (embeddedRef) want = embeddedRef;
    else { try { want = sessionStorage.getItem('communityos:openTicket'); } catch { /* ignore */ } }
    if (!want || liveT.loading) return;
    const done = (t) => { setSelectedId(t.id); if (!embeddedRef) { try { sessionStorage.removeItem('communityos:openTicket'); } catch { /* ignore */ } } };
    const hit = tickets.find((t) => t.id === want || t.ticketNumber === want || t.shortId === want);
    if (hit) done(hit);
    else secureStorage.get(COLLECTIONS.TICKETS, want).then((t) => { if (t) { setExtraT(t); done(t); } }).catch(() => {});   // a closed one: read on its own
  }, [tickets, embeddedRef, liveT.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  const [raising, setRaising] = useState(null); // null | 'task' | 'request'
  // read only when needed: people to assign (raising a task or one task open), and the payments and chat of the open task
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users', { enabled: !!raising || !!selectedId });
  const { records: ledgerAll } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check', { enabled: !!selectedId && moneyReader });
  const { records: comments, save: saveComment } = useCollection(COLLECTIONS.TICKET_COMMENTS, 'Ticket Discussion', { enabled: !!selectedId });
  const [raiseForm, setRaiseForm] = useState(blankRaiseForm());
  const [raisePending, setRaisePending] = useState([]);
  const [raiseErrors, setRaiseErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [acceptPick, setAcceptPick] = useState('');
  const [closing, setClosing] = useState(false);
  const [assetAsk, setAssetAsk] = useState(null); // a task linked to an infrastructure asset was completed / closed: ask if it works again
  const [closeNote, setCloseNote] = useState('');
  const [draft, setDraft] = useState(null);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [savingTicket, setSavingTicket] = useState(false);
  const [financialOnly, setFinancialOnly] = useState(false);
  const [approvalOnly, setApprovalOnly] = useState(false);
  const [scope, setScope] = useState('all'); // 'mine' | 'all'
  const [resScope, setResScope] = useState('all'); // residents: all | mine | Community

  const isResident = role?.category === 'Resident';
  const isEC = role?.category === 'EC';
  const isCoordinator = roleId === 'facility_manager' || roleId === 'handyman_mep';
  const isHandymanRole = roleId?.startsWith('handyman_');
  const myTrade = isHandymanRole ? tradeFromRoleName(role?.name) : null;
  const myHandymen = myTrade ? handymen.filter((h) => h.trade === myTrade) : [];
  const iAmClockedIn = myHandymen.some((h) => h.clockedIn);
  const isFieldStaff = !isResident;
  // An EC member is also an owner: with a villa on their login they raise requests like any owner.
  const ownerUnit = currentUser?.unit || '';
  const canRaiseRequest = isResident || (isEC && !!ownerUnit);
  // EC/FM/MEP override authority (assign, financial stages, reopen).
  const canManageTickets = isEC || isCoordinator || hasPermission('MANAGE_TICKETS');
  const canSeeFinance = !isResident && (isEC || isCoordinator || hasPermission('MANAGE_TICKETS'));
    const canManageTypes = hasPermission('MANAGE_TICKET_TYPES');
  const { ask: askPrompt, node: promptNode } = usePrompt();
  const myCreatableTypes = useMemo(() => (isResident ? [] : creatableTaskTypes(taskTypes, role)), [taskTypes, role, isResident]);
  const showTabs = !isResident && (!isHandymanRole || roleId === 'handyman_mep');
  const showWishTab = isEC || roleId === 'super_admin'; // the wishlist is the committee's: ideas it weighs, estimates and decides
  const showPlanned = !isResident && role?.category !== 'Vendor';   // planned works: the technicians fill the rounds, the FM / MEP plan them
  const showQueue = role?.category !== 'Vendor';   // the technicians' queue: everyone (residents see other homes' tickets anonymised)
  // a role whose Tickets tab was switched off lands on the first tab it may open
  const firstTab = ['tickets', 'queue', 'planned', 'wishlist', 'coverage', 'approvers', 'types'].find((t) => tabAllowed(`tickets.${t}`)) || 'tickets';
  const tab = showTabs && !tabAllowed(`tickets.${tabRaw}`) ? firstTab : tabRaw;

  const visibleTickets = useMemo(() => visibleTicketsFor(tickets, taskTypes, { role, currentUser }), [tickets, taskTypes, role, currentUser]);
  // the type used for residents' own requests is configurable (Task Types -> "Used for residents' own requests")
  const residentTypeName = (taskTypes.find((t) => t.residentDefault) || taskTypes.find((t) => t.creatorScope === 'Resident'))?.name || 'Resident Maintenance';
  const taskTypeOf = (ticket) => taskTypes.find((t) => t.name === ticket?.taskType);
  // Approval chain: EC first, then the roles set under Maintenance -> Final approvers (default Treasurer + President).
  const canDecideEC = isEC;
  const kit = useApprovalKit();
  const { records: allReleases } = useCollection(COLLECTIONS.RELEASES, 'Fund releases', { enabled: moneyReader });
  const { records: ledgerRows } = useCollection(COLLECTIONS.LEDGER, 'Payments Cross-check', { enabled: !!selectedId && moneyReader });   // the money position of the open task only
  const finalRoleIds = finalApproverRoleIds(approverRows);
  const finalRoleNames = finalRoleIds.map((id) => roles.find((r) => r.id === id)?.name || id).join(', ');
  const canDecideTreasurer = roleId === 'super_admin' || finalRoleIds.includes(roleId);
  const canEditApprovers = canWriteCollection(COLLECTIONS.APPROVER_SETTINGS, getPrincipal());
  const canPostNotice = canWriteCollection(COLLECTIONS.SERVICE_NOTICES, getPrincipal());
  const [svcAsk, setSvcAsk] = useState(0);
  const [payReq, setPayReq] = useState(false);   // an EC member asking the Treasurer to pay (files a task and its release)
  const { records: svcNotices } = useCollection(COLLECTIONS.SERVICE_NOTICES, 'Service Notices');
  const myBlock = useMyBlock();
  const awaitingMe = useMemo(() => (canSeeFinance ? tickets.filter((t) => {
    if (t.status === 'Closed' || t.status === 'Cancelled') return false;
    const w = approvalState(t, taskTypes.find((x) => x.name === t.taskType)).waitingOn;
    if ((w === 'ec' && canDecideEC) || (w === 'treasurer' && canDecideTreasurer)) return true;
    if (t.plan && w && kit.mayDecide(parseJson(t.plan, null) || { steps: [] }, t)) return true;
    // every invoice is approved on its own
    return allDocs.some((d) => d.ticketId === t.id && d.kind === 'Invoice' && ((invoiceApproval(d).waitingOn === 'ec' && canDecideEC) || (invoiceApproval(d).waitingOn === 'final' && canDecideTreasurer) || (d.plan && invoiceApproval(d).waitingOn && kit.mayDecide(parseJson(d.plan, null) || { steps: [] }, d))));
  }) : []), [tickets, taskTypes, allDocs, canSeeFinance, canDecideEC, canDecideTreasurer, kit.me, kit.settings.separate]); // eslint-disable-line react-hooks/exhaustive-deps
  
  async function submitRaise(e) {
    e.preventDefault();
    const ownerForm = raising === 'request' || raising === 'community';
    const isCommunity = raising === 'community';
    const typeName = ownerForm ? residentTypeName : raiseForm.taskType;
    const errs = {};
    if (!raiseForm.title.trim()) errs.title = 'Issue title is required';
    else if (raiseForm.title.trim().length < 3) errs.title = 'Give a short title (at least 3 characters)';
    if (ownerForm) { const v = outageVerdict(svcNotices, { text: `${raiseForm.title} ${String(raiseForm.description || '').replace(/<[^>]+>/g, ' ')}`, block: myBlock, confirmed: raiseForm.outageOk }); if (!v.ok) errs.outage = v.error; }
    if (!raiseForm.category) errs.category = 'Category is required';
    if (!ownerForm && raiseForm.category && raiseSubs.length && !raiseForm.subCategory) errs.subCategory = 'Sub-category is required';
    if (!typeName) errs.taskType = 'Task type is required';
    const showAsset = !ownerForm && assetMode !== 'Hidden';
    if (showAsset && raiseForm.assetName && !raiseForm.assetId) errs.asset = 'That asset is not in the asset register';
    if (showAsset && assetMode === 'Required' && !raiseForm.assetId) errs.asset = 'Pick the asset this task is about';
    if (ownerForm && !ownerUnit) errs.unit = 'Your villa/unit is required';
    if (isCommunity && !String(raiseForm.location || '').trim()) errs.location = 'Say where in the community the problem is';
    if (!ownerForm && (raiseType?.assignmentMode === 'Direct assign' || isInternalType(raiseType)) && !raiseForm.assignedTo) errs.assignedTo = 'Assigned to is required';
    if (!ownerForm && !raiseForm.slaDueAt) errs.slaDueAt = 'SLA due is required';
    else if (!ownerForm && raiseForm.slaDueAt < todayIso()) errs.slaDueAt = 'SLA due must be today or a future date';
    // a staff task's "Location" is a villa / unit (a unit task) or a place (a community task: a plant room, a lawn, an asset's spot)
    let place = null;
    if (!ownerForm) {
      const typed = String(raiseForm.unit || '').trim();
      if (!typed) place = { scope: 'Community', unit: '', location: raiseForm.assetId ? (raiseForm.assetName || 'Common area') : 'Common area' };
      else {
        const hits = (await secureStorage.query(COLLECTIONS.PROPERTIES, { page: 1, pageSize: 10, search: typed }).catch(() => null))?.rows || [];
        const unit = hits.find((u) => String(u.unit).trim().toLowerCase() === typed.toLowerCase());
        if (unit) place = { scope: 'Unit', unit: unit.unit, location: '' };
        else if (/^(villa|flat|apt|apartment|unit)\s*[\w-]+$|^[a-z]{1,3}-?\d{2,5}$/i.test(typed)) errs.unit = `There is no unit "${typed}" - check the number, or leave it blank for a common area`;
        else place = { scope: 'Community', unit: '', location: typed };
      }
    }
    setRaiseErrors(errs);
    if (Object.keys(errs).length) return;
    const tt = taskTypes.find((t) => t.name === typeName);
    if (!ownerForm && !tt) return;

    const internal = !ownerForm && isInternalType(tt);
    const pool = assigneesForCategory({ category: raiseForm.category, internal, coverage, vendors, ecRoles, handymen, users, roles });
    let status = 'Open';
    let assignedTo = '';
    if (!ownerForm && (tt?.assignmentMode === 'Direct assign' || internal)) {
      if (raiseForm.assignedTo && !pool.options.some((o) => o.value === raiseForm.assignedTo)) {
        setRaiseErrors({ assignedTo: 'Pick someone from the list for this category' });
        return;
      }
      if (raiseForm.assignedTo) { status = 'Assigned'; assignedTo = raiseForm.assignedTo; }
    }   // a queue task joins its category's queue: the next free technician is given it when it is saved (ticketQueue.js / the server)

    setSubmitting(true);
    const id = uuid(); // primary key; files are attached to it before the ticket exists
    let saved = null;
    try {   // the Submit button always comes back, whatever fails
    const metas = raisePending.length ? await persistPending(raisePending, { ownerType: 'ticket', ownerId: id }) : [];
    if (!metas) return;
    saved = await saveTicket({
      id,
      taskType: typeName,
      title: !ownerForm && raiseForm.assetId ? `${raiseForm.assetName}: ${raiseForm.title.trim()}` : raiseForm.title.trim(),
      description: raiseForm.description,
      unit: ownerForm ? ownerUnit : place.unit,
      category: raiseForm.category,
      subCategory: ownerForm ? '' : raiseForm.subCategory || '',
      priority: raiseForm.priority || 'Medium',
      status,
      assignedTo,
      slaDueAt: raiseForm.slaDueAt || defaultSla(raiseForm.priority),
      preferredTime: raiseForm.preferredTime || '',
      scope: ownerForm ? (isCommunity ? 'Community' : 'Unit') : place.scope,
      location: ownerForm ? (isCommunity ? String(raiseForm.location || '').trim() : '') : place.location,
      ...(!ownerForm && assetMode !== 'Hidden' && raiseForm.assetId ? { assetId: raiseForm.assetId, assetName: raiseForm.assetName } : {}),
      affectedUnits: isCommunity ? [ownerUnit] : [],
      ...Object.fromEntries(customKeys.filter((k) => raiseForm[k] !== undefined && raiseForm[k] !== '').map((k) => [k, raiseForm[k]])),
      attachments: metas,
      hasPhotos: metas.some(isImageMeta),
      awaitingParts: false,
      materialsCost: 0,
      ...(canSeeFinance && !ownerForm ? { financial: !!raiseForm.financial } : {}),
      paymentStatus: 'Not Paid',
      residentRating: 0,
      createdBy: currentUser?.name || role?.name || '',
      createdByRole: roleId,
      createdAt: todayLabel(),
    });
    } catch (err) { setRaiseErrors((x) => ({ ...x, form: `Could not submit: ${err?.message || 'storage error'}` })); } finally { setSubmitting(false); }
    if (!saved) return;
    if (ownerForm || isQueueType(tt)) tell(saved.assignedTo ? `${saved.ticketNumber || 'Your request'} is with ${saved.assignedTo}.` : `${saved.ticketNumber || 'Your request'} is in the ${saved.category} queue — the next free technician takes it.`, 'success');
    const then = raiseThen.current; raiseThen.current = null;
    setRaiseForm(blankRaiseForm());
    setRaisePending([]);
    setRaiseErrors({});
    setRaising(null);
    then?.(saved);
  }
  // a task raised from elsewhere on the page (a planned works task marked Not OK): the task form, filled in; `then` gets the saved task
  const raiseThen = useRef(null);
  function raiseFrom(prefill, then) {
    const first = myCreatableTypes[0];
    const category = allCategories.includes(prefill.category) ? prefill.category : '';
    // the sub-category the area names (WTP -> "Water treatment plant (WTP)"), when the category has one
    const area = String(prefill.location || '').trim().toLowerCase(); const subs = coverage.find((c) => c.category === category)?.subCategories || [];
    const subCategory = (area && (subs.find((x) => String(x).toLowerCase().includes(`(${area})`)) || subs.find((x) => String(x).toLowerCase().includes(area)))) || '';
    setRaiseForm({ ...blankRaiseForm(), taskType: first?.name || '', financial: first?.quotationStage === 'Yes', title: prefill.title || '', description: prefill.description || '',
      category, subCategory, unit: prefill.location || '', slaDueAt: defaultSla('Medium') });
    setRaisePending([]); setRaiseErrors({}); raiseThen.current = then || null; setRaising('task');
  }

  async function toggleClock(h) {
    const clockingOut = h.clockedIn;
    // the same button also records the attendance punch (with GPS) for the signed-in person
    try {
      const open = await openSession();
      const res = clockingOut ? (open ? await clockOut(open) : null) : (open ? null : await clockIn());
      if (res?.blocked) { window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: res.blocked } })); return; }
    } catch { /* attendance is best effort here; the on-duty flag still changes */ }
    await saveHandyman({ ...h, clockedIn: !h.clockedIn });
    if (clockingOut) {
      const theirTickets = tickets.filter((t) => t.assignedTo === h.name && t.status !== 'Closed' && t.status !== 'Cancelled');
      for (const t of theirTickets) {
        // Work already started stays with the person; anything not started goes back to the category's queue for a colleague to assign.
        if (t.status === 'Assigned') await saveTicket({ ...t, assignedTo: '', status: 'Open' });
      }
    }
  }

  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  // a ticket opened from the Closed tile is not in the live list: read it on its own (again whenever tickets change)
  useEffect(() => {
    if (!selectedId || liveT.records.some((t) => t.id === selectedId)) return undefined;
    let on = true;
    secureStorage.get(COLLECTIONS.TICKETS, selectedId).then((t) => { if (on && t) setExtraT(t); }).catch(() => {});
    return () => { on = false; };
  }, [selectedId, liveT.records]);
  // on a computer the open ticket sits beside the list (split view) and the list turns into two-line rows
  const docked = !!selected && !embeddedRef && !phoneView;
  const selectedType = taskTypeOf(selected);
  const myQueueTicket = !!(isHandymanRole && selected && selected.category === myTrade && !isInternalType(taskTypeOf(selected)));
  const isMyTicket = !!(isResident && selected && selected.unit === currentUser?.unit);
  const open = selected && selected.status !== 'Closed' && selected.status !== 'Cancelled';
  // The assignee as such cannot close or cancel. Only the ticket owner (close once Completed; cancel any time), EC members and
  // the admin can; the final approver closes automatically when the last invoice is approved (see invoiceTools.onDecided).
  const isAssignee = !!selected?.assignedTo && (selected.assignedTo === currentUser?.name
    || users.some((u) => u.name === selected.assignedTo && [u.roleId, ...(Array.isArray(u.extraRoleIds) ? u.extraRoleIds : [])].includes(roleId))
    || myHandymen.some((h) => h.name === selected.assignedTo));
  const ownsTicket = (t) => !!t && (isResident ? t.unit === currentUser?.unit : (t.createdBy === currentUser?.name || t.createdByRole === roleId));
  const ownerConfirms = !!selected && selected.status === 'Completed' && ownsTicket(selected);
  const privileged = isEC || roleId === 'super_admin';
  const canCancel = !!open && (ownsTicket(selected) || privileged);
  // A requester cannot close a task while money is still owed on it (or while this role cannot see the payments to check).
  const ledgerVisible = isEC || roleId === 'facility_manager' || hasPermission('MANAGE_LEDGER') || roleId === 'super_admin';
  const pos = selected && selected.financial ? moneyPosition(selected, allDocs, allReleases, ledgerRows, kit.settings.tolerancePct) : null;
  const moneyBlocked = !!pos && pos.hasMoney && (!ledgerVisible || pos.owed > 0.5);
  const canSetFinancial = isEC || roleId === 'super_admin' || hasPermission('SET_FINANCIAL_FLAG');
  const canClose = !!open && (privileged || (ownerConfirms && !moneyBlocked));
  const canAttach = open && (isMyTicket || myQueueTicket || canManageTickets);
  const canEditDesc = !!selected && open && (canManageTickets || (isMyTicket && withinEditWindow(selected)));
  const canSetStatus = open && (myQueueTicket || canManageTickets || isAssignee);
  // Status dropdown: working statuses for the team; Close / Cancel only for the eligible roles and the ticket owner.
  const statusOptions = (() => {
    if (!selected || !draft || !open) return [];
    const work = canSetStatus && selected.status !== 'Open'
      ? [...(draft.status === 'Reopened' ? ['Reopened'] : []), 'Assigned', 'In Progress', 'On Hold', ...(!selected.financial || draft.status === 'Completed' ? ['Completed'] : [])]
      : [];
    return [...new Set([selected.status, draft.status, ...work, ...(canClose ? ['Closed'] : []), ...(canCancel ? ['Cancelled'] : [])])];
  })();
  const selectedInternal = isInternalType(selectedType);
  // Resident-type tasks (raised by owners/residents) never show the financial workflow - for any role.
  const residentTask = !!selected && (selectedType?.creatorScope === 'Resident' || (!selectedInternal && !!selected.unit && roles.find((r) => r.id === selected.createdByRole)?.category === 'Resident'));
  const showFinance = canSeeFinance && !residentTask;
  // A non-financial task whose type still asks for an EC sign-off: the EC approval closes the ticket.
  const needsEcOnly = !!selected && showFinance && !selected.financial && selectedType?.ecApprovalStage === 'Yes';
  const mineIds = !isResident ? visibleTickets.filter((t) => t.assignedTo === currentUser?.name || t.createdBy === currentUser?.name || awaitingMe.some((x) => x.id === t.id)).map((t) => t.id) : [];
  const confirmMine = visibleTickets.filter((t) => t.status === 'Completed' && ownsTicket(t));
  const [confirmOnly, setConfirmOnly] = useState(false);
  const [dtab, setDtab] = useState('overview');
  const [formError, setFormError] = useState('');

  // The form (draft) is re-seeded whenever a different ticket is opened or the stored record changes.
  // custom attributes the Super Admin added to maintenance tasks (Studio) travel with the draft
  const customKeys = useMemo(() => (schemaFor(COLLECTIONS.TICKETS)?.fields || []).filter((f) => f.isCustom).map((f) => f.key), [schemaFor]);
  const baseline = useMemo(() => (selected ? pickDraft(selected, customKeys) : null), [selected, customKeys]);
  // the attachments too: on the back end attaching a photo does not change the ticket's own version, so the version alone would leave the
  // form holding the old photo list - it then looked unsaved, and saving again would have dropped the new photo
  const attachSig = (selected?.attachments || []).map((m) => m.fileId || m.name).join('|');
  useEffect(() => {
    setDraft(selected ? pickDraft(selected, customKeys) : null);
    setPendingFiles([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selected?.recVersion, attachSig]);
  useEffect(() => { let t = 'overview'; try { const h = sessionStorage.getItem('communityos:openTicketTab'); if (h && selected?.id) { t = h; setTimeout(() => sessionStorage.removeItem('communityos:openTicketTab'), 600); } } catch { /* ignore */ } setDtab(t); }, [selected?.id]);
  const changedKeys = draft && baseline ? [...DRAFT_KEYS, ...customKeys].filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(baseline[k])) : [];
  const dirty = changedKeys.length > 0 || pendingFiles.length > 0;
  const slaMissing = !!selected && !!draft && isEC && open && !draft.slaDueAt;
  const setD = (k, v) => setDraft((d) => ({ ...d, [k]: v }));

  const assignInfo = selected
    ? assigneesForCategory({ category: selected.category, internal: selectedInternal, coverage, vendors, ecRoles, handymen, users, roles })
    : { options: [], row: null };
  const assignOptions = (() => {
    const list = [...assignInfo.options];
    const cur = draft?.assignedTo;
    if (cur && !list.some((o) => o.value === cur)) list.unshift({ value: cur, label: cur });
    return list;
  })();

  const raiseType = taskTypes.find((t) => t.name === raiseForm.taskType);
  const raiseSubs = coverage.find((c) => c.category === raiseForm.category)?.subCategories || [];
  const assetMode = coverage.find((c) => c.category === raiseForm.category)?.assetLink || 'Optional'; // Hidden / Optional / Required, set per category in Category coverage
  const raiseOwnerForm = raising === 'request' || raising === 'community';
  const raiseCommunity = raising === 'community';
  const raiseInternal = !raiseOwnerForm && isInternalType(raiseType);
  const raiseInfo = assigneesForCategory({ category: raiseForm.category, internal: raiseInternal, coverage, vendors, ecRoles, handymen, users, roles });

  const openCount = visibleTickets.filter((t) => t.status === 'Open').length;
  const inProgressCount = visibleTickets.filter((t) => t.status === 'Assigned' || t.status === 'In Progress').length;
  const closedCount = visibleTickets.filter((t) => t.status === 'Closed').length;
  const criticalOpen = tickets.filter((t) => t.status !== 'Closed' && t.status !== 'Cancelled' && (t.priority === 'High' || t.priority === 'Critical')).length;
  const awaitingParts = tickets.filter((t) => t.awaitingParts);
  // a tile on the Command Center can open this list already filtered
  // the list opens on the open tasks (tap "All" for everything); a link from elsewhere may ask for another tile
  // a handyman has no tiles: their queue opens on every task not yet closed (the ones they are working on too), not just the new ones
  const firstCard = isHandymanRole ? 'live' : 'open';
  const [cardKey, setCardKey] = useState(() => { try { const k = sessionStorage.getItem('communityos:ticketCard'); sessionStorage.removeItem('communityos:ticketCard'); return k && SUMMARY_FILTERS[k] ? k : firstCard; } catch { return firstCard; } });
  const overdueIds = tickets.filter((t) => LIVE_STATUSES.includes(t.status) && t.slaDueAt && t.slaDueAt < new Date().toISOString().slice(0, 10)).map((t) => t.id);
  const [resetToken, setResetToken] = useState(0);
  const serverSum = useTicketSummary();
  const serverCount = (key) => {
    const by = serverSum?.byStatus || {};
    const f = SUMMARY_FILTERS[key].status;
    return (Array.isArray(f) ? f : [f]).reduce((n, st) => n + (Number(by[st]) || 0), 0);
  };
  const countOf = (key) => visibleTickets.filter((t) => {
    const f = SUMMARY_FILTERS[key];
    return Object.entries(f).every(([k, v]) => (Array.isArray(v) ? v.includes(t[k]) : t[k] === v));
  }).length;
  const summaryCards = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open', tone: 'warn' },
    { key: 'progress', label: 'Active' },
    { key: 'hold', label: 'On hold' },
    { key: 'closed', label: 'Closed' },
  ].map((c) => ({ ...c, count: serverSum?.byStatus ? serverCount(c.key) : countOf(c.key) }));
  function resetAllFilters() {
    setCardKey(firstCard); setApprovalOnly(false); setConfirmOnly(false); setFinancialOnly(false); setScope('all'); setResetToken((n) => n + 1);
  }
  const materialsCost = awaitingParts.reduce((s, t) => s + (Number(t.materialsCost) || 0), 0);

  function discardChanges() {
    setDraft(pickDraft(selected, customKeys));
    setPendingFiles([]);
  }

  function confirmLoseChanges() {
    return !dirty || window.confirm('You have unsaved changes on this ticket. Discard them?');
  }

  /** Save the whole form in one write (one audit entry listing only the fields that changed). */
  async function saveChanges(e) {
    e?.preventDefault();
    if (!dirty || savingTicket) return;
    setFormError('');
    if (selectedInternal && !draft.assignedTo) { setFormError('Assigned to is required.'); return; }
    if (isEC && open && !draft.slaDueAt) { setFormError('SLA due is required.'); return; }
    if (draft.status === 'Cancelled' && selected.status !== 'Cancelled' && !String(draft.cancelReason || '').trim()) { setFormError('Say why the ticket is cancelled.'); return; }
    setSavingTicket(true);
    let out = null; const patch = {};
    try {   // whatever happens (an upload refused, a timeout, no network), the button comes back: "Saving…" never stays
      changedKeys.forEach((k) => { patch[k] = draft[k]; });
      if (patch.cancelReason !== undefined) patch.cancelReason = String(patch.cancelReason || '').trim();
      if (patch.assignedTo && selected.status === 'Open' && !patch.status) patch.status = 'Assigned';
      if (pendingFiles.length) {
        const metas = await persistPending(pendingFiles, { ownerType: 'ticket', ownerId: selected.id });
        if (!metas) return;   // the reason is already shown; the chosen files stay, ready for another try
        patch.attachments = [...draft.attachments, ...metas];
      }
      if (patch.attachments) patch.hasPhotos = patch.attachments.some(isImageMeta) || (selected.photos || []).length > 0;
      // files taken off the list are removed on the back end (named, so a photo someone else added meanwhile stays)
      const removed = (baseline.attachments || []).map((m) => m.fileId).filter((id) => id && !(patch.attachments || draft.attachments).some((m) => m.fileId === id));
      if (removed.length && getDataSource().mode === 'v2') patch._detach = removed;
      out = await saveTicket({ ...selected, ...patch });
    } catch (err) {
      setFormError(`Could not save: ${err?.message || 'storage error'}`);
    } finally { setSavingTicket(false); }
    if (out) { setPendingFiles([]); setDraft(pickDraft({ ...selected, ...patch, ...out }, customKeys)); }   // the form is what was saved
    if (out && ['Completed', 'Closed'].includes(patch.status) && selected.assetId) setAssetAsk({ ...selected, ...patch });
    // non-financial work finished: remind the person who raised the ticket to confirm and close it
    if (out && patch.status === 'Completed' && !selected.financial) {
      await postComment({
        ticketId: selected.id, author: 'CommunityOS reminder', authorRoleId: 'system', visibility: 'Public', createdAt: new Date().toISOString(),
        body: `<p>✅ <b>Work is marked completed</b> by ${currentUser?.name || role?.name || 'the team'}. ${selected.createdBy || 'Ticket owner'}, please check it and <b>close the ticket</b> if the issue is resolved.</p>`,
      });
    }
  }

  async function act(patch) {
    if (!confirmLoseChanges()) return false;
    // an action (a status step, what a new quotation sets) applies to the ticket as it is NOW: adding a quotation or an approval moves the
    // ticket on the server, so the copy on screen is already a version behind
    const latest = (await secureStorage.get(COLLECTIONS.TICKETS, selected.id).catch(() => null)) || selected;
    const saved = await saveTicket({ ...latest, ...patch });
    if (saved && ['Completed', 'Closed'].includes(patch.status) && selected.assetId) setAssetAsk({ ...selected, ...patch });
    return !!saved;
  }

  async function postComment(c) {
    await saveComment(c);
  }

  /** Assign an Open ticket to a chosen member of my category, or take over one that is only Assigned (to me). */
  async function acceptTicket(forName) {
    if (!confirmLoseChanges()) return;
    const mine = (myHandymen.find((h) => h.name === currentUser?.name) || myHandymen[0])?.name || role?.name;
    const name = forName || acceptPick || mine;
    if (!name) { alert('Choose who the ticket is assigned to first.'); return; }
    // Re-read before writing: client-side stand-in for a row lock (see README).
    const latest = await secureStorage.get(COLLECTIONS.TICKETS, selected.id);
    if (!latest || !(latest.status === 'Open' || latest.status === 'Assigned')) {
      alert(`This ticket has moved on${latest?.assignedTo ? ' (' + latest.assignedTo + ')' : ''}; it can only be reassigned while Open or Assigned.`);
      await refreshTickets();
      return;
    }
    if (latest.status === 'Assigned' && latest.assignedTo === name) { alert('Already assigned to that person.'); return; }
    await saveTicket({ ...latest, status: 'Assigned', assignedTo: name });
    setAcceptPick('');
  }

  async function confirmClose() {
    const ok = await act({ status: 'Closed' });
    if (!ok) return;
    if (!isEmptyHtml(closeNote)) {
      await postComment({ ticketId: selected.id, author: currentUser?.name || role?.name, authorRoleId: roleId, visibility: 'Public', body: `<p><b>Closed.</b></p>${closeNote}`, createdAt: new Date().toISOString() });
    }
    setClosing(false);
    setCloseNote('');
  }

  const [photoView, setPhotoView] = useState(null);
  function closeDetail() {
    if (!confirmLoseChanges()) return;
    setSelectedId(null);
    setClosing(false);
    setCloseNote('');
    if (embeddedRef && onEmbeddedClose) onEmbeddedClose();
  }

  /** Non-financial task that only needs the EC's sign-off: approving records it. The requester still closes the task. */
  async function approveEcOnly() {
    const who = currentUser?.name || role?.name || '';
    await act({ ecApproval: 'Approved', ecApprovedBy: who, ecApprovedAt: todayIso() });
  }

  /** Approve / reject straight from the approval panel: stamps who and when, and saves just that step. */
  async function decideNow(kind, value, opts = {}) {
    const k = kind === 'ec' ? 'ec' : 'treasurer';
    const ok = await act({
      ...(k === 'ec' ? { finalRequired: value === 'Approved' ? opts.send !== false : null } : {}),
      [`${k}Approval`]: value,
      [`${k}ApprovedBy`]: value === 'Pending' ? '' : currentUser?.name || role?.name || '',
      [`${k}ApprovedAt`]: value === 'Pending' ? '' : todayIso(),
    });
    return ok;
  }

  /** Quotations chosen for this task: one or several vendors (e.g. materials from one, labour from another). */
  const chosenQuoteIds = (t) => (Array.isArray(t?.selectedQuotationIds) && t.selectedQuotationIds.length ? t.selectedQuotationIds : t?.selectedQuotationId ? [t.selectedQuotationId] : []);

  /**
   * Choosing (or unchoosing) a quotation: the amount to approve is the total of all chosen ones, and approval starts again. It is an action,
   * saved at once like an approval (not an edit waiting for "Save changes" that approving would then throw away).
   */
  async function chooseQuote(q) {
    const cur = chosenQuoteIds(selected);
    const ids = !q ? [] : cur.includes(q.id) ? cur.filter((x) => x !== q.id) : [...cur, q.id];
    const total = ids.reduce((n, id) => n + (Number(selDocs.find((x) => x.id === id)?.amount) || 0), 0);
    return act({
      selectedQuotationIds: ids,
      selectedQuotationId: ids[0] || '',
      approvedAmount: total,
      approvalStage: ids.length ? 'Quotation' : selected.selectedInvoiceId ? 'Invoice' : '',
      ...RESET_APPROVALS,
    });
  }

  /** A quotation / invoice was just uploaded: work has started (-> In Progress). A first quotation becomes the one under approval. */
  async function documentAdded(kind, doc) {
    const start = ['Open', 'Assigned', 'Reopened'].includes(selected.status) ? { status: 'In Progress' } : {};
    const patch = { financial: true, ...start };
    if (kind === 'Quotation' && !selected.selectedQuotationId) Object.assign(patch, { selectedQuotationId: doc.id, selectedQuotationIds: [doc.id], approvalStage: 'Quotation', approvedAmount: Number(doc.amount) || 0, ...RESET_APPROVALS });
    await act(patch);
    if (kind === 'Invoice' && doc.approvalWaived && invoiceTools) await invoiceTools.onDecided([...allDocs.filter((d) => d.ticketId === selected.id && d.kind === 'Invoice' && d.id !== doc.id), doc]);
  }

  /** Tools the invoice rows need: per-invoice decisions, "record in Payments Cross-check", and the auto-close once all are approved. */
  const invoiceTools = selected ? {
    actor: currentUser?.name || role?.name || '',
    open,
    canDecideEC,
    canDecideFinal: canDecideTreasurer,
    kit,
    ticket: selected,
    ledgerFor: (doc) => liveDebits(ledgerAll).find((l) => l.sourceId === doc.id),
    onDecided: async () => {}, // nothing closes by itself: the requester closes the task
  } : null;
  const quoteTools = selected ? {
    open,
    state: approvalState(selected, selectedType),
    canDecideEC,
    canDecideFinal: canDecideTreasurer,
    finalRoleNames,
    kit,
    savePlan: (plan) => act(kit.planFields(plan, 'ticket')),
    planCtx: { subject: 'Maintenance quotation', amount: Number(selected.approvedAmount) || 0, category: selected.category, taskType: selected.taskType, flags: [] },
    decide: (step, v, o) => decideNow(step === 'ec' ? 'ec' : 'treasurer', v, o),
    note: dirty ? 'Approving or rejecting asks you to discard unsaved edits first.' : '',
    ledgerFor: (q) => (selected ? liveDebits(ledgerAll).find((l) => l.taskRef === selected.ticketNumber && (l.sourceId === q.id || (!l.sourceId && q.id === chosenQuoteIds(selected)[0]))) : null),
  } : null;
  const hasInvoices = !!selected && allDocs.some((d) => d.ticketId === selected.id && d.kind === 'Invoice');
  const hasQuotes = !!selected && allDocs.some((d) => d.ticketId === selected.id && (d.kind || 'Quotation') === 'Quotation');

  const initialsOf = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  /** One ticket as a phone-friendly card (the table stays on desktop). */
  const ticketCard = (t) => {
    const sla = slaInfo(t.slaDueAt, t.status);
    const live = !['Closed', 'Cancelled'].includes(t.status);
    const a = canSeeFinance ? approvalState(t, taskTypeOf(t)) : { label: '' };
    const docs = canSeeFinance ? allDocs.filter((d) => d.ticketId === t.id) : [];
    const inv = docs.filter((d) => d.kind === 'Invoice' && d.selected !== false);
    const quote = docs.find((d) => d.id === t.selectedQuotationId);
    const invWait = inv.find((d) => invoiceApproval(d).label && invoiceApproval(d).key !== 'approved');
    const chip = a.label ? { text: a.label, tone: a.tone } : invWait ? { text: invoiceApproval(invWait).label, tone: invoiceApproval(invWait).tone } : inv.length ? { text: 'Approved', tone: 'green' } : null;
    const needsMe = live && awaitingMe.some((x) => x.id === t.id);
    const invoiced = inv.reduce((n, d) => n + (Number(d.amount) || 0), 0);
    const quoted = quote ? Number(quote.amount) : Number(t.approvedAmount) || 0;
    const created = t.recordCreatedAt ? new Date(t.recordCreatedAt) : null;
    const ageD = created ? Math.max(0, Math.floor((Date.now() - created.getTime()) / 86400000)) : null;
    return (
      <article className={`tk-card prio-${t.priority}${needsMe ? ' needs-me' : ''}`}>
        <div className="tk-card-top">
          <span className="mono">{t.ticketNumber}</span>
          <span className={`tk-prio ${t.priority}`}>{t.priority}</span>
          {ageD != null && <small className="muted tk-age">{ageD === 0 ? 'today' : `${ageD}d`}</small>}
        </div>
        <h3 className="tk-title">{t.financial ? '💰 ' : ''}{t.title}</h3>
        <div className="tk-loc-line"><LocPill t={t} /></div>
        <div className="tk-meta">{EMOJI[t.category] || ''} {t.category}{t.subCategory ? ` › ${t.subCategory}` : ''}{!isResident && t.taskType !== residentTypeName ? ` · ${t.taskType}` : ''}</div>
        {(quoted > 0 || invoiced > 0) && (
          <div className="tk-money">
            {quoted > 0 && <span>Quoted <b>{rupees(quoted)}</b></span>}
            {invoiced > 0 && <span>Invoiced <b>{rupees(invoiced)}</b></span>}
            {chip && <span className={`tag ${chip.tone}`}>{chip.text}</span>}
          </div>
        )}
        <div className="tk-foot">
          <div className="tk-state">   {/* the ticket's state on one row: status and due date together, then who has it */}
            <span className={`tag ${TAG_CLASS[t.status] || ''}`}>{t.status}</span>
            <span className={`tk-sla ${sla.tone}`}><span className="sla-i">⏱ </span>{(() => { const [d, r] = String(sla.text).split(' · '); return r ? <><span className="sla-d">{d}</span><span className="sla-sep"> · </span><span className="sla-r">{r}</span></> : d; })()}</span>
          </div>
          <span className="tk-who"><i>{initialsOf(t.assignedTo)}</i><span className="tk-who-name">{t.assignedTo || 'Unassigned'}</span></span>
          {needsMe && <span className="tag orange tk-needs">✋ Needs your approval</span>}
          {!needsMe && !(quoted > 0 || invoiced > 0) && chip && <span className={`tag ${chip.tone}`}>{chip.text}</span>}
        </div>
      </article>
    );
  };

  const rupees = (n) => money(n, { round: false });

  /** What is waiting for THIS person on the open ticket (invoices on their step, plus the selected quotation). */
  const selDocs = selected && showFinance ? allDocs.filter((d) => d.ticketId === selected.id) : [];
  const selInvoices = selDocs.filter((d) => d.kind === 'Invoice' && d.selected !== false);
  const myPendingInv = selInvoices.filter((d) => (invoiceApproval(d).waitingOn === 'ec' && canDecideEC) || (invoiceApproval(d).waitingOn === 'final' && canDecideTreasurer));
  const qWait = selected && showFinance && !selInvoices.length ? approvalState(selected, selectedType).waitingOn : null;
  const myPendingQuote = !!open && ((qWait === 'ec' && canDecideEC) || (qWait === 'treasurer' && canDecideTreasurer));
  const myPendingCount = (open ? myPendingInv.length : 0) + (myPendingQuote ? 1 : 0);

  /** Ticket header: number, status, priority and owner on one compact strip; what waits for THIS person jumps to the Costs & approvals tab. */
  const ticketHero = (t) => {
    const sla = slaInfo(t.slaDueAt, t.status);
    const phone = (handymen.find((h) => h.name === t.assignedTo) || {}).phone;
    return (
      <div className="tk-hero">
        <div className="tk-hero-top">
          <span className="mono">#{t.ticketNumber}</span>
          <span className="tk-type">{t.taskType === residentTypeName ? 'Resident request' : t.taskType}</span>
          <span className={`tag ${TAG_CLASS[t.status] || ''}`}>{t.status}</span>
          <span className={`tk-prio ${t.priority}`}>{t.priority}</span>
          {t.financial && showFinance && <span className="tag purple">💰</span>}
        </div>
        <div className="tk-strip">
          <span>{EMOJI[t.category] || ''} {t.category}{t.subCategory ? ` › ${t.subCategory}` : ''}</span>
          <span className="tk-loc" data-testid="tk-location"><small>Location</small> <LocPill t={t} big /></span>
          <div className="tk-state">   {/* the ticket's state on one row: status and due date together, then who has it */}
            <span className={`tag ${TAG_CLASS[t.status] || ''}`}>{t.status}</span>
            <span className={`tk-sla ${sla.tone}`}>⏱ {sla.text}</span>
          </div>
          <span className="tk-who"><i>{initialsOf(t.assignedTo)}</i>{t.assignedTo || 'Unassigned'}{t.assignedTo && phone ? <a className="call-btn" href={`tel:${phone}`} title="Call" aria-label="Call" onClick={(e) => e.stopPropagation()}>📞</a> : null}</span>
        </div>
        {t.assetId && !isResident && (
          <div className="tk-src" data-testid="tk-asset-source">
            <span>{t.source === 'Site map' ? '🗺 Raised from the Site map' : '🔧 Linked to an asset'} · <b>{t.assetName}</b>{t.assetRef ? <span className="mono muted"> ({t.assetRef})</span> : null}</span>
            {onNavigate && <button type="button" className="link-btn" data-testid="tk-open-sitemap" onClick={() => { try { sessionStorage.setItem('communityos:siteMapAsset', t.assetId); } catch { /* ignore */ } onNavigate('sitemap'); }}>Show on the Site map →</button>}
          </div>
        )}
        {myPendingCount > 0 && open && dtab === 'overview' && (
          <button type="button" className="tk-action" data-testid="hero-review" onClick={() => setDtab('money')}>
            ✋ {myPendingCount} approval{myPendingCount === 1 ? '' : 's'} waiting for you <span>Review →</span>
          </button>
        )}
      </div>
    );
  };

  /** Everything that happened on this ticket, newest first (derived from the record, its documents, the ledger and system messages). */
  const historyEvents = (t) => {
    const ev = [];
    const at = (x) => { const n = x ? new Date(x).getTime() : 0; return Number.isNaN(n) ? 0 : n; };
    ev.push({ when: at(t.recordCreatedAt), text: `Raised by ${t.createdBy || 'someone'}`, icon: '＋' });
    (t.statusHistory || []).forEach((s, i) => { if (i > 0 || s.status !== 'Open') ev.push({ when: at(s.at), text: `Status → ${s.status}${s.by ? ` · ${s.by}` : ''}`, icon: '➜' }); });
    if (showFinance) {
      if (t.ecApprovedAt) ev.push({ when: at(t.ecApprovedAt) + 1, text: `EC ${t.ecApproval?.toLowerCase()} the quotation · ${t.ecApprovedBy || ''}`, icon: t.ecApproval === 'Rejected' ? '✕' : '✓', tone: t.ecApproval === 'Rejected' ? 'red' : 'green' });
      if (t.treasurerApprovedAt) ev.push({ when: at(t.treasurerApprovedAt) + 1, text: `Final ${t.treasurerApproval?.toLowerCase()} the quotation · ${t.treasurerApprovedBy || ''}`, icon: t.treasurerApproval === 'Rejected' ? '✕' : '✓', tone: t.treasurerApproval === 'Rejected' ? 'red' : 'green' });
      selDocs.forEach((d) => {
        const label = `${d.kind === 'Invoice' ? 'Invoice' : 'Quotation'} ${d.vendor || ''} ${rupees(d.amount)}`;
        ev.push({ when: at(d.recordCreatedAt), text: `${label} uploaded`, icon: '📄' });
        if (d.kind === 'Invoice') {
          if (d.ecApprovedAt) ev.push({ when: at(d.ecApprovedAt) + 1, text: `EC ${String(d.ecApproval).toLowerCase()} ${label} · ${d.ecApprovedBy || ''}`, icon: d.ecApproval === 'Rejected' ? '✕' : '✓', tone: d.ecApproval === 'Rejected' ? 'red' : 'green' });
          if (d.finalApprovedAt) ev.push({ when: at(d.finalApprovedAt) + 1, text: `Final ${String(d.finalApproval).toLowerCase()} ${label} · ${d.finalApprovedBy || ''}`, icon: d.finalApproval === 'Rejected' ? '✕' : '✓', tone: d.finalApproval === 'Rejected' ? 'red' : 'green' });
        }
      });
      ledgerAll.filter((l) => l.taskRef === t.ticketNumber).forEach((l) => ev.push({ when: at(l.date || l.recordCreatedAt), text: `Recorded in Payments Cross-check · ${rupees(l.amount)}${l.account ? ' · ' + l.account : ''}`, icon: '₹' }));
    }
    comments.filter((c) => c.ticketId === t.id && c.authorRoleId === 'system').forEach((c) => ev.push({ when: at(c.createdAt), text: String(c.body || '').replace(/<[^>]+>/g, ''), icon: 'ⓘ' }));
    return ev.sort((a, b) => b.when - a.when);
  };

  const ticketColumns = [
    { key: 'ticketNumber', label: 'Ticket #', render: (t) => <b style={{ whiteSpace: 'nowrap' }}>{t.ticketNumber}</b> },
    { key: 'recordCreatedAt', label: 'Created', render: (t) => { if (!t.recordCreatedAt) return '—'; const d = new Date(t.recordCreatedAt); const same = d.getFullYear() === new Date().getFullYear(); return <span style={{ whiteSpace: 'nowrap' }}>{d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', ...(same ? {} : { year: 'numeric' }) })}</span>; } },
    { key: 'title', label: 'Issue', render: (t) => <span style={{ display: 'inline-block', minWidth: 140 }}>{t.financial ? '💰 ' : ''}{(t.hasPhotos || t.attachments?.length) ? '📎 ' : ''}{t.title}{!isResident && t.taskType && t.taskType !== 'Resident Maintenance' && <><br /><small className="tag purple">{t.taskType}</small></>}</span> },
    { key: 'category', label: 'Category', render: (t) => `${EMOJI[t.category] || ''} ${t.category}${t.subCategory ? ` › ${t.subCategory}` : ''}` },
    { key: 'unit', label: 'Location', render: (t) => <LocPill t={t} /> },
    { key: 'priority', label: 'Priority', render: (t) => <span className={`tag ${t.priority === 'Critical' || t.priority === 'High' ? 'red' : ''}`}>{t.priority}</span> },
    { key: 'status', label: 'Status', render: (t) => <span className={`tag ${TAG_CLASS[t.status] || ''}`}>{t.status}</span> },
    ...(canSeeFinance ? [{ key: 'approval', label: 'Approval', sortable: false, render: (t) => { const a = approvalState(t, taskTypeOf(t)); return a.label ? <span className={`tag ${a.tone}`}>{a.label}</span> : <span className="muted">—</span>; } }] : []),
    { key: 'slaDueAt', label: 'SLA due', render: (t) => { const late = t.slaDueAt && t.slaDueAt < todayIso() && !['Closed', 'Cancelled', 'Completed'].includes(t.status); return <span className={late ? 'tag red' : ''} style={{ whiteSpace: 'nowrap' }}>{/^\d{4}-\d{2}-\d{2}$/.test(t.slaDueAt || '') ? new Date(`${t.slaDueAt}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', ...(t.slaDueAt.slice(0, 4) === String(new Date().getFullYear()) ? {} : { year: 'numeric' }) }) : slaLabel(t.slaDueAt)}</span>; } },
    { key: 'assignedTo', label: 'Assigned to', render: (t) => t.assignedTo || 'Unassigned' },
  ];


  return (
    <div className={docked ? 'tk-docked list-docked' : undefined}>
      {!embeddedRef && (<>
      <div className="page-head">
        <div>
          <h1>{isResident ? 'My Maintenance' : 'Maintenance operations'}</h1>
          <p>{isResident ? 'Raise a request and track it through to close-out.' : 'Role-queue assignment, financial workflow and staff workload.'}</p>
        </div>
        <PageActions>
          {canRaiseRequest && (
            <button className={isResident ? 'btn' : 'btn secondary'} onClick={() => { setRaiseForm(blankRaiseForm()); setRaisePending([]); setRaiseErrors({}); setRaising('request'); }}>
              + <span className="m-hide">Raise </span>Maintenance Request{!isResident ? ` (${ownerUnit})` : ''}
            </button>
          )}
          {!isResident && canPostNotice && (tab === 'tickets' || !showTabs) && <button type="button" className="btn secondary" data-testid="svc-post" onClick={() => setSvcAsk((n) => n + 1)}>📢 <span className="m-hide">Service </span>notice</button>}
          {isEC && <button type="button" className="btn secondary" data-testid="payreq-open" onClick={() => setPayReq(true)}>₹ <span className="m-hide">Payment </span>request</button>}
          {myCreatableTypes.length > 0 && (
            <button className="btn" onClick={() => { const first = myCreatableTypes[0]; setRaiseForm({ ...blankRaiseForm(), taskType: first?.name || '', financial: first?.quotationStage === 'Yes' }); setRaisePending([]); setRaiseErrors({}); setRaising('task'); }}>
              + New task
            </button>
          )}
        </PageActions>
      </div>

      {(showWishTab || showTabs || showPlanned || showQueue) && (
        <Tabs>
          {(!showTabs || tabAllowed('tickets.tickets')) && <button className={tab === 'tickets' ? 'active' : ''} onClick={() => setTab('tickets')}>Tickets</button>}
          {showQueue && tabAllowed('tickets.queue') && <button data-testid="tab-queue" className={tab === 'queue' ? 'active' : ''} onClick={() => setTab('queue')}>Queue</button>}
          {showPlanned && tabAllowed('tickets.planned') && <button data-testid="tab-planned" className={tab === 'planned' ? 'active' : ''} onClick={() => setTab('planned')}>Planned works</button>}
          {showWishTab && (!showTabs || tabAllowed('tickets.wishlist')) && <button data-testid="tab-wishlist" className={tab === 'wishlist' ? 'active' : ''} onClick={() => setTab('wishlist')}>Wishlist</button>}
          {showTabs && tabAllowed('tickets.coverage') && <button className={tab === 'coverage' ? 'active' : ''} onClick={() => setTab('coverage')}>Category coverage</button>}
          {showTabs && canEditApprovers && tabAllowed('tickets.approvers') && <button className={tab === 'approvers' ? 'active' : ''} onClick={() => setTab('approvers')}>Final approvers</button>}
          {showTabs && canManageTypes && tabAllowed('tickets.types') && <button className={tab === 'types' ? 'active' : ''} onClick={() => setTab('types')}>Task Types</button>}
        </Tabs>
      )}

      {tab === 'queue' && showQueue && tabAllowed('tickets.queue') ? (
        <TicketQueue categories={allCategories} coverage={coverage}
          defaultCategory={myTrade || (isResident ? visibleTickets.find((t) => !['Closed', 'Cancelled'].includes(t.status))?.category || visibleTickets[0]?.category : '') || ''} />
      ) : tab === 'planned' && showPlanned && tabAllowed('tickets.planned') ? (
        <PlannedWorks onRaise={myCreatableTypes.length ? raiseFrom : null} categories={allCategories} />
      ) : tab === 'wishlist' && showWishTab ? (
        <Wishlist />
      ) : tab === 'approvers' && showTabs && canEditApprovers ? (
        <><ApproversPanel /><ApprovalRules /></>
      ) : tab === 'types' && showTabs ? (
        <TaskTypesPanel />
      ) : tab === 'coverage' && showTabs ? (
        <SectionPage
          sectionId={COLLECTIONS.CATEGORY_MAP}
          title="Category coverage"
          description="Which vendor handles each category, who coordinates it (Facility Manager / MEP) and, optionally, a contracted vendor. Add a new category by typing its name. This drives the “Assign to” list on new tasks."
          filters={[{ key: 'vendor', label: 'All vendors' }, { key: 'coordinator', label: 'All coordinators' }]}
          baseSort={{ key: 'category', dir: 'asc' }}
        />
      ) : (
        <>
          <ServiceNotices tickets={isResident ? [] : tickets} canPost={!isResident && canPostNotice} postAsk={svcAsk} />
          {!isHandymanRole && (
            <StatTiles label="Ticket summary — tap a tile to filter the list" value={cardKey || 'all'}
              items={summaryCards}
              onChange={(k) => { setCardKey(k === 'all' ? '' : k); setApprovalOnly(false); setConfirmOnly(false); }} />
          )}

          {!isResident && <FaultyAssets tickets={tickets} onOpenTicket={setSelectedId} />}

          {isHandymanRole && myHandymen.length > 0 && (
            <div className="card" style={{ marginBottom: 16 }}>
              <h2>My shift · {myTrade}</h2>
              <ul className="list">
                {myHandymen.map((h) => (
                  <li key={h.id}>
                    <span>{h.name} <small className="muted">{h.shift} shift</small></span>
                    <button className={`btn ${h.clockedIn ? 'secondary' : ''}`} onClick={() => toggleClock(h)}>
                      {h.clockedIn ? 'Clock out' : 'Clock in'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {isHandymanRole && !iAmClockedIn && roleId !== 'handyman_mep' ? (
            <div className="empty">Clock in above to see your ticket queue.</div>
          ) : (
            <div className="card tk-list-card" style={{ marginTop: 16 }}>
              {(canDecideEC || canDecideTreasurer) && (awaitingMe.length > 0 || approvalOnly) && (
                <div className="approval-banner">
                  {awaitingMe.length ? <span>✋ <b>{awaitingMe.length}</b> task{awaitingMe.length === 1 ? '' : 's'} waiting for your approval</span> : <span>✅ Nothing is waiting for your approval.</span>}
                  <button type="button" className="btn secondary" onClick={() => { setApprovalOnly((v) => !v); setConfirmOnly(false); }}>{approvalOnly ? 'Show all tasks' : 'Review now'}</button>
                </div>
              )}
              {confirmMine.length > 0 && (
                <div className="approval-banner confirm">
                  <span>✅ <b>{confirmMine.length}</b> ticket{confirmMine.length === 1 ? ' is' : 's are'} marked completed — please check and close {confirmMine.length === 1 ? 'it' : 'them'}</span>
                  <button type="button" className="btn secondary" onClick={() => { setConfirmOnly((v) => !v); setApprovalOnly(false); }}>{confirmOnly ? 'Show all tasks' : 'Review now'}</button>
                </div>
              )}
              {(!isResident && !isHandymanRole) || canSeeFinance ? (
                <div className="tk-scope">
                  {!isResident && !isHandymanRole && (
                    <Segmented label="Whose tickets" value={scope} onChange={setScope}
                      options={[{ value: 'mine', label: 'Mine', count: mineIds.length }, { value: 'all', label: 'All', count: visibleTickets.length }]} />
                  )}
                  {canSeeFinance && (
                    <label className="check tk-fin-only">
                      <input type="checkbox" checked={financialOnly} onChange={(e) => setFinancialOnly(e.target.checked)} /> 💰 Financial only
                    </label>
                  )}
                </div>
              ) : null}
              {typesLoading ? <div className="empty">Loading…</div> : (
                <ServerTable
                  collection={COLLECTIONS.TICKETS}
                  columns={ticketColumns}
                  cardRender={ticketCard}
                  cardSorts={[{ key: 'recordCreatedAt', dir: 'desc', label: 'Newest first' }, { key: 'slaDueAt', dir: 'asc', label: 'SLA soonest' }, { key: 'status', dir: 'asc', label: 'Status' }]}
                  rowClassName={(t) => `prio-${t.priority}${t.id === selectedId ? ' row-sel' : ''}`}
                  cardsAlways={docked}
                  baseFilters={{
                    ...(isHandymanRole && roleId !== 'handyman_mep' ? { category: myTrade } : {}),
                    ...(cardKey ? SUMMARY_FILTERS[cardKey] : SUMMARY_FILTERS.all),
                    ...(cardKey === 'overdue' ? { id: overdueIds.length ? overdueIds : ['__none__'] } : {}),
                    ...(financialOnly ? { financial: true } : {}),
                    ...(isResident && resScope === 'Community' ? { scope: 'Community' } : {}),
                    ...(isResident && resScope === 'mine' ? { unit: ownerUnit } : {}),
                    ...(scope === 'mine' && !isResident ? { id: mineIds.length ? mineIds : ['__none__'] } : {}),
                    ...(approvalOnly ? { id: awaitingMe.length ? awaitingMe.map((t) => t.id) : ['__none__'] } : {}),
                    ...(confirmOnly ? { id: confirmMine.length ? confirmMine.map((t) => t.id) : ['__none__'] } : {}),
                  }}
                  baseSort={{ key: 'recordCreatedAt', dir: 'desc' }}
                  filters={[
                    { key: 'status', label: 'All status', options: [...CORE_STATUSES, 'Cancelled', 'Reopened'] },
                    ...(isHandymanRole && roleId !== 'handyman_mep' ? [] : [{ key: 'category', label: 'All categories', options: allCategories }]),
                    { key: 'priority', label: 'All priorities', options: ['Low', 'Medium', 'High', 'Critical'] },
                    ...(isResident ? [] : [{ key: 'taskType', label: 'All task types', options: taskTypes.map((t) => t.name) }]),
                  ]}
                  searchKeys={['ticketNumber', 'title', 'unit', 'category', 'status', 'assignedTo', 'createdBy']}
                  consumeNavSearch
                  resetToken={resetToken}
                  toolbarExtra={(
                    <button type="button" className="icon-btn reset-filters" title="Reset all filters" aria-label="Reset all filters" onClick={resetAllFilters}>⟲</button>
                  )}
                  onRowClick={(t) => { if (selectedId && t.id !== selectedId && !confirmLoseChanges()) return; setSelectedId(t.id); }}
                  emptyText="No tickets match."
                />
              )}
            </div>
          )}
        </>
      )}

      {payReq && <PaymentRequest onClose={() => setPayReq(false)} onDone={(task) => { setPayReq(false); refreshTickets?.(); if (task?.id) { setExtraT(task); setSelectedId(task.id); } }} />}
      {raising && (
        <Modal
          title={raiseCommunity ? 'Raise a community request' : raiseOwnerForm ? 'Raise a maintenance request' : 'Create a task'}
          subtitle={raiseCommunity ? 'Report a problem in a shared area (lift, road, garden, clubhouse, lights…) to the HOA. Other residents can add “Me too” so the team sees how many are affected.' : raiseOwnerForm ? 'Tell the facilities team what needs fixing. You can follow progress and chat with the team on the ticket afterwards.' : 'Create work for the facilities team or a vendor. Pick a category to see who can take it; mark it financial if money will be spent.'}
          onClose={() => { raiseThen.current = null; setRaising(null); }}>
          <form className="form-grid" onSubmit={submitRaise} noValidate>
            {raiseOwnerForm && quickPhrases.length > 0 && (
              <QuickIssues phrases={quickPhrases} emoji={EMOJI} defaultOpen onPick={(qp) => setRaiseForm((f) => ({ ...f, title: qp.phrase, category: qp.category, subCategory: '' }))} />
            )}
            {!raiseOwnerForm && (
              <div className={`field${raiseErrors.taskType ? ' invalid' : ''}`}>
                <label>Task type *</label>
                <select value={raiseForm.taskType} onChange={(e) => {
                  const tt = taskTypes.find((t) => t.name === e.target.value);
                  setRaiseForm((f) => ({ ...f, taskType: e.target.value, assignedTo: '', financial: tt?.quotationStage === 'Yes' || f.financial }));
                }}>
                  {myCreatableTypes.map((t) => <option key={t.id} value={t.name}>{t.icon} {t.name}</option>)}
                </select>
                {raiseErrors.taskType && <div className="field-error">{raiseErrors.taskType}</div>}
              </div>
            )}
            <div className={`field${raiseErrors.category ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
              <label>Category *</label>
              <CategoryPicker label="Category" value={raiseForm.category} startFolded={raiseOwnerForm && quickPhrases.length > 0} options={allCategories.map((c) => ({ value: c, label: c, icon: EMOJI[c] || '' }))}
                onChange={(c) => setRaiseForm((f) => ({ ...f, category: c, subCategory: '', assignedTo: '' }))} />
              {raiseErrors.category && <div className="field-error">{raiseErrors.category}</div>}
              {raiseForm.category && (raiseOwnerForm || isQueueType(raiseType)) && <QueueAvailability category={raiseForm.category} />}
            </div>
            {!raiseOwnerForm && raiseSubs.length > 0 && (
              <div className={`field${raiseErrors.subCategory ? ' invalid' : ''}`}>
                <label>Sub-category *</label>
                <select aria-label="Sub-category" value={raiseForm.subCategory} onChange={(e) => setRaiseForm((f) => ({ ...f, subCategory: e.target.value }))}>
                  <option value="">Select…</option>
                  {raiseSubs.map((c) => <option key={c}>{c}</option>)}
                </select>
                {raiseErrors.subCategory && <div className="field-error">{raiseErrors.subCategory}</div>}
              </div>
            )}
            {!raiseOwnerForm && assetMode !== 'Hidden' && raiseForm.category && (
              <AssetField value={raiseForm} required={assetMode === 'Required'} invalid={!!raiseErrors.asset} category={raiseForm.category} cats={allCategories}
                onChange={(v) => setRaiseForm((f) => ({ ...f, assetId: v.assetId, assetName: v.assetName, ...(v.asset ? { unit: [v.asset.area, v.asset.location].filter(Boolean).join(' / ') || 'Common area' } : {}), ...(v.asset && !f.category ? { category: repairKindOf(v.asset, allCategories) } : {}) }))} />
            )}
            {raiseErrors.asset && <div className="field-error" style={{ gridColumn: '1 / -1' }}>{raiseErrors.asset}</div>}
            {raiseCommunity && (
              <div className={`field${raiseErrors.location ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
                <label>Where in the community? *</label>
                <input data-testid="community-location" value={raiseForm.location || ''} onChange={(e) => setRaiseForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Block C lift, Clubhouse, Main gate road, Park" />
                {raiseErrors.location && <div className="field-error">{raiseErrors.location}</div>}
              </div>
            )}
            <div className={`field${raiseErrors.title ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}>
              <label>{raiseOwnerForm ? 'Describe the issue *' : 'Issue / what is wrong *'}</label>
              <div className="gg-row" style={{ flexWrap: 'nowrap' }}>
                {!raiseOwnerForm && raiseForm.assetId && <span className="tag" data-testid="title-prefix" style={{ whiteSpace: 'nowrap', maxWidth: '45%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{raiseForm.assetName}:</span>}
                <input data-testid="raise-title" value={raiseForm.title} onChange={(e) => setRaiseForm((f) => ({ ...f, title: e.target.value, outageOk: false }))} placeholder="e.g. Kitchen tap won't stop dripping" style={{ flex: 1 }} />
              </div>
              {raiseErrors.title && <div className="field-error">{raiseErrors.title}</div>}
            </div>
            {raiseOwnerForm && <OutageGuard text={`${raiseForm.title} ${String(raiseForm.description || '').replace(/<[^>]+>/g, ' ')}`} confirmed={raiseForm.outageOk} onConfirm={(v) => setRaiseForm((f) => ({ ...f, outageOk: v }))} />}
            {raiseErrors.outage && <div className="field-error" style={{ gridColumn: '1 / -1' }} data-testid="outage-error">{raiseErrors.outage}</div>}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Additional details</label>
              <RichTextEditor value={raiseForm.description} onChange={(h) => setRaiseForm((f) => ({ ...f, description: h }))} placeholder="Anything that helps the team — what happened, where, since when…" minHeight={80} />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Priority</label>
              <Segmented label="Priority" value={raiseForm.priority} onChange={(v) => setRaiseForm((f) => ({ ...f, priority: v }))}
                options={['Low', 'Medium', 'High', 'Critical']} />
            </div>
            {raiseOwnerForm ? (
              <>
                <div className={`field${raiseErrors.unit ? ' invalid' : ''}`}><label>Location</label><div className="ro-value">{ownerUnit || '—'}</div>{raiseErrors.unit && <div className="field-error">{raiseErrors.unit}</div>}</div>
                <div className="field"><label>Preferred time (optional)</label>
                  <input value={raiseForm.preferredTime} onChange={(e) => setRaiseForm((f) => ({ ...f, preferredTime: e.target.value }))} placeholder="e.g. After 5pm" />
                </div>
              </>
            ) : (
              <>
                <div className={`field${raiseErrors.unit ? ' invalid' : ''}`}><label>Location</label>
                  <input value={raiseForm.unit} onChange={(e) => setRaiseForm((f) => ({ ...f, unit: e.target.value }))} placeholder="Blank for common area" />
                  <small className="muted">A villa / unit, or a place such as "Pump room"; blank means the common area.</small>
                  {raiseErrors.unit && <div className="field-error" data-testid="task-unit-error">{raiseErrors.unit}</div>}
                </div>
                {raiseType?.assignmentMode === 'Direct assign' || raiseInternal ? (
                  <div className={`field${raiseErrors.assignedTo ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }}><label>Assign to *{raiseForm.category && <CoverageHint row={raiseInfo.row} fallback={raiseInfo.fallback} roles={roles} extra={raiseInternal ? 'Internal tasks go to the people who coordinate this category (or an EC member) — never to vendors, owners or residents. Vendors are added on the quotation or invoice.' : null} />}</label>
                    <select value={raiseForm.assignedTo} onChange={(e) => setRaiseForm((f) => ({ ...f, assignedTo: e.target.value }))} disabled={!raiseForm.category}>
                      <option value="">{raiseForm.category ? 'Choose who will do this…' : 'Choose a category first'}</option>
                      {raiseInfo.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    {raiseErrors.assignedTo && <div className="field-error">{raiseErrors.assignedTo}</div>}
                  </div>
                ) : null}
                <div className={`field${raiseErrors.slaDueAt ? ' invalid' : ''}`}><label>SLA due (date) *</label>
                  <input type="date" min={todayIso()} value={raiseForm.slaDueAt} onChange={(e) => setRaiseForm((f) => ({ ...f, slaDueAt: e.target.value }))} />
                  <small className="muted">Must be a future date. After the task is created only an EC member can change it.</small>
                  {raiseErrors.slaDueAt && <div className="field-error">{raiseErrors.slaDueAt}</div>}
                </div>
                {canSeeFinance && canSetFinancial && (
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <label className="check">
                      <input type="checkbox" checked={!!raiseForm.financial} onChange={(e) => setRaiseForm((f) => ({ ...f, financial: e.target.checked }))} /> 💰 Involves a financial transaction
                    </label>
                    <small className="muted">Flags the task for the finance team and lets it be linked to the Payments Cross-check.</small>
                  </div>
                )}
              </>
            )}
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>Photos &amp; files (optional)</label>
              <AttachmentPicker compact pending={raisePending} onChange={setRaisePending} />
            </div>
            <div style={{ gridColumn: '1 / -1' }}><CustomFields sectionId={COLLECTIONS.TICKETS} value={raiseForm} onChange={(k, v) => setRaiseForm((f) => ({ ...f, [k]: v }))} /></div>
            {raiseErrors.form && <div className="field-error" role="alert" style={{ gridColumn: '1 / -1' }}>{raiseErrors.form}</div>}
            <div className="form-actions">
              <button type="button" className="btn secondary" onClick={() => setRaising(null)}>Cancel</button>
              <button type="submit" className="btn" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit'}</button>
            </div>
          </form>
        </Modal>
      )}

      </>)}

      {selected && draft && (() => {
        const msgCount = visibleCommentsFor(comments, selected.id, { isFieldStaff }).length;
        const quotes = chosenQuoteIds(draft).map((id) => selDocs.find((d) => d.id === id)).filter(Boolean);
        const quote = quotes[0] || null;
        const quotedTotal = quotes.reduce((n, d) => n + (Number(d.amount) || 0), 0);
        const invoiced = selInvoices.reduce((n, d) => n + (Number(d.amount) || 0), 0);
        const recorded = ledgerAll.filter((l) => l.taskRef === selected.ticketNumber).reduce((n, l) => n + (Number(l.amount) || 0), 0);
        const ap = approvalState(selected, selectedType);
        const invWait = selInvoices.find((d) => invoiceApproval(d).key !== 'approved');
        const apTone = invWait ? invoiceApproval(invWait) : ap;
        const moneyTiles = [
          { label: 'Quoted', value: quote ? rupees(quotedTotal) : Number(draft.approvedAmount) ? rupees(draft.approvedAmount) : '—', sub: quotes.length > 1 ? `${quotes.length} vendors` : quote?.vendor },
          { label: 'Invoiced', value: invoiced ? rupees(invoiced) : '—', sub: selInvoices.length ? `${selInvoices.length} invoice${selInvoices.length > 1 ? 's' : ''}` : '' },
          { label: 'In Payments', value: recorded ? rupees(recorded) : '—', tone: recorded ? 'green' : '' },
          { label: 'Approval', value: apTone.label || (selInvoices.length || quote ? 'Approved' : '—'), tone: apTone.tone || (selInvoices.length || quote ? 'green' : '') },
        ];
        const events = historyEvents(selected);
        const tabs = [
          { key: 'overview', label: 'Overview' },
          { key: 'money', label: 'Costs & approvals', hidden: !showFinance || !tabAllowed('tickets.d.money'), dot: myPendingCount > 0 && open },
          { key: 'chat', label: 'Chat', count: msgCount, hidden: !tabAllowed('tickets.d.chat'), disabled: dirty, title: dirty ? 'Save or discard your changes first' : '' },
          { key: 'history', label: 'History', hidden: !tabAllowed('tickets.d.history'), disabled: dirty, title: dirty ? 'Save or discard your changes first' : '' },
        ];
        return (
        <Modal title={selected.title} onClose={closeDetail} wide dock={!embeddedRef}>
          {photoView && <FilePreview meta={photoView} onClose={() => setPhotoView(null)} />}
          {ticketHero(selected)}
          <SegTabs tabs={tabs} value={dtab} onChange={setDtab} label="Ticket sections" />

          <div hidden={dtab !== 'overview'} className="tk-pane">
            {open && isQueueType(taskTypeOf(selected)) && <QueuePlace ticket={selected} />}
          {showFinance && apTone.label && apTone.tone === 'orange' && (
            <div className="notice" data-testid="next-step" style={{ marginTop: 8 }}>
              <b>Next step:</b> {apTone.key === 'pending-ec' ? 'EC approval' : 'Final approval (Treasurer / President)'} — the {apTone.key === 'pending-ec' ? 'EC members' : 'final approvers'} have been notified. Open the Costs & approvals tab to see what is being approved.
            </div>
          )}
          {needsEcOnly && (
            <div className={`approval-panel compact ${selected.ecApproval === 'Approved' ? 'approved' : 'pending-ec'}`}>
              <div className="ap-head"><b>EC approval</b><span className={`tag ${selected.ecApproval === 'Approved' ? 'green' : selected.ecApproval === 'Rejected' ? 'red' : 'orange'}`}>{selected.ecApproval || 'Pending'}</span></div>
              <div className="ap-step">
                <span className="ap-title">EC<small className="muted ap-hint"></small></span>
                {selected.ecApproval && selected.ecApproval !== 'Pending' && <small className="muted">{selected.ecApprovedBy || '—'}{selected.ecApprovedAt ? ` · ${/^\d{4}-\d{2}-\d{2}/.test(selected.ecApprovedAt) ? new Date(`${String(selected.ecApprovedAt).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : selected.ecApprovedAt}` : ''}</small>}
                {open && isEC && (
                  <span className="ap-actions">
                    {selected.ecApproval !== 'Approved' && <button type="button" className="btn good sm" onClick={approveEcOnly}>Approve</button>}
                    {selected.ecApproval !== 'Rejected' && <button type="button" className="btn secondary sm" onClick={() => decideNow('ec', 'Rejected')}>{selected.ecApproval === 'Approved' ? 'Change to rejected' : 'Reject'}</button>}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Category staff assign explicitly: Open tickets to themselves or a colleague; Assigned ones can be taken over by another member of the team. */}
          {myQueueTicket && open && (selected.status === 'Open' || (selected.status === 'Assigned' && teamFor(handymen, myTrade).some((h) => h.name !== selected.assignedTo))) && (
            <div style={{ marginTop: 12 }} className="field" data-testid="assign-box">
              {selected.status === 'Open' ? (
                <>
                  <label>Assign this ticket</label>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <select style={{ width: 'auto' }} aria-label="Assign to" value={acceptPick || (myHandymen.find((h) => h.name === currentUser?.name) || myHandymen[0])?.name || ''} onChange={(e) => setAcceptPick(e.target.value)}>
                      {teamFor(handymen, myTrade).map((h) => <option key={h.id} value={h.name}>{h.name}{h.name === currentUser?.name ? ' (me)' : ''}{h.clockedIn ? '' : ' · off shift'}</option>)}
                    </select>
                    <button className="btn" onClick={() => acceptTicket()}>Assign</button>
                  </div>
                  <small className="muted">Several people cover {myTrade}, so someone from the team assigns each new ticket.</small>
                </>
              ) : (
                <>
                  <label>Assigned to {selected.assignedTo}</label>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    <select style={{ width: 'auto' }} aria-label="Take over as" value={acceptPick || (teamFor(handymen, myTrade).find((h) => h.name === currentUser?.name && h.name !== selected.assignedTo) || teamFor(handymen, myTrade).find((h) => h.name !== selected.assignedTo))?.name || ''} onChange={(e) => setAcceptPick(e.target.value)}>
                      {teamFor(handymen, myTrade).filter((h) => h.name !== selected.assignedTo).map((h) => <option key={h.id} value={h.name}>{h.name}{h.name === currentUser?.name ? ' (me)' : ''}</option>)}
                    </select>
                    <button className="btn secondary" onClick={() => acceptTicket(acceptPick || (teamFor(handymen, myTrade).find((h) => h.name === currentUser?.name && h.name !== selected.assignedTo) || teamFor(handymen, myTrade).find((h) => h.name !== selected.assignedTo))?.name)}>Reassign to me</button>
                  </div>
                  <small className="muted">A colleague in {myTrade} can take it over until work starts.</small>
                </>
              )}
            </div>
          )}

          {ownerConfirms && open && !closing && (
            <div className="approval-banner confirm" style={{ marginTop: 12 }}>
              <span>✅ The team marked this <b>completed</b>. If the issue is resolved, close the ticket.</span>
              <button type="button" className="btn good" onClick={() => setClosing(true)}>Close ticket</button>
            </div>
          )}

          {isEC && !open && selected.status === 'Closed' && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
              <button className="btn secondary" onClick={() => act({ status: 'Reopened' })}>Reopen</button>
            </div>
          )}
          {closing && (
            <div className="assign">
              <div className="field"><label>Closing comment (optional)</label>
                <RichTextEditor value={closeNote} onChange={setCloseNote} placeholder="e.g. Issue resolved, thanks" minHeight={56} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn good" onClick={confirmClose}>Confirm close</button>
                <button className="btn secondary" onClick={() => { setClosing(false); setCloseNote(''); }}>Back</button>
              </div>
            </div>
          )}

          </div>

          {/* ---- The ticket FORM: edits are held here and written once, by "Save changes". Overview and Money are panes of ONE form. ---- */}
          <form onSubmit={saveChanges} className="ticket-form">
            <div hidden={dtab !== 'overview'} className="tk-pane">
            <div className="form-grid" style={{ marginTop: 16 }}>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>Description</label>
                {canEditDesc
                  ? <RichTextEditor value={draft.description || ''} onChange={(h) => setD('description', h)} minHeight={80} />
                  : <div className="ro-value ro-rich">{selected.description ? <RichText html={selected.description} /> : '—'}</div>}
                {isMyTicket && open && !canManageTickets && <small className="muted">You can edit the description for 30 minutes after raising the ticket.</small>}
              </div>
              {selected.scope === 'Community' && (
                <div className="field" style={{ gridColumn: '1 / -1' }} data-testid="community-box">
                  <label>🏘 Villas affected</label>
                  <div className="ro-value">
                    <b data-testid="affected-count">{(selected.affectedUnits || []).length}</b> villa{(selected.affectedUnits || []).length === 1 ? '' : 's'} affected
                    {(selected.affectedUnits || []).length > 0 && <span className="muted"> · {(selected.affectedUnits || []).join(', ')}</span>}
                  </div>
                  {isResident && open && currentUser?.unit && (
                    <div style={{ marginTop: 6 }}>
                      {(selected.affectedUnits || []).includes(currentUser.unit)
                        ? <button type="button" className="btn secondary small" data-testid="me-too-undo" onClick={() => saveTicket({ ...selected, affectedUnits: (selected.affectedUnits || []).filter((u) => u !== currentUser.unit) })}>Remove my villa</button>
                        : <button type="button" className="btn small" data-testid="me-too" onClick={() => saveTicket({ ...selected, affectedUnits: [...(selected.affectedUnits || []), currentUser.unit] })}>🙋 Me too — this affects {currentUser.unit}</button>}
                    </div>
                  )}
                </div>
              )}
              <div className="field"><label>Priority</label>
                {canManageTickets && open ? (
                  <select value={draft.priority} onChange={(e) => setD('priority', e.target.value)}>
                    {['Low', 'Medium', 'High', 'Critical'].map((p) => <option key={p}>{p}</option>)}
                  </select>
                ) : <div className="ro-value ro-select">{selected.priority}</div>}
              </div>
              {/* who has it is at the top of the ticket; the field is here only for those who change it */}
              {canManageTickets && open && (
                <div className="field"><label>Assigned to{selectedInternal ? ' *' : ''}<CoverageHint row={assignInfo.row} fallback={assignInfo.fallback} roles={roles} /></label>
                  <select value={draft.assignedTo} onChange={(e) => setD('assignedTo', e.target.value)}>
                    {!selectedInternal && <option value="">Unassigned</option>}
                    {selectedInternal && !draft.assignedTo && <option value="">Choose…</option>}
                    {assignOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              )}
              {ownerConfirms && !privileged && moneyBlocked && <div className="notice" data-testid="close-blocked">You cannot close this task yet: {ledgerVisible ? `₹${Number(pos.owed).toLocaleString('en-IN')} is still to be paid.` : 'its payments have not been checked. Ask the Treasurer or an EC member.'}</div>}
              {statusOptions.length > 1 && (
                <div className="field"><label>Status</label>
                  <select value={draft.status} onChange={(e) => { setD('status', e.target.value); if (e.target.value === 'On Hold') setD('awaitingParts', true); }}>
                    {statusOptions.map((st) => <option key={st}>{st}</option>)}
                  </select>
                  {(canClose || canCancel) && <small className="muted">{canClose && canCancel ? 'Close and Cancel are offered to you as the ticket owner / EC.' : canClose ? 'Close is offered to you as the ticket owner / EC.' : 'Cancel is offered to you as the ticket owner / EC.'}</small>}
                </div>
              )}
              {draft.status === 'Cancelled' && selected.status !== 'Cancelled' && (
                <div className={`field${formError && !String(draft.cancelReason || '').trim() ? ' invalid' : ''}`} style={{ gridColumn: '1 / -1' }} data-testid="cancel-reason">
                  <label>Reason for cancelling *</label>
                  <input aria-label="Reason for cancelling" value={draft.cancelReason || ''} maxLength={500} onChange={(e) => setD('cancelReason', e.target.value)} placeholder="e.g. Raised twice, resident fixed it, not our scope" autoFocus />
                </div>
              )}
              {selected.status === 'Cancelled' && selected.cancelReason && (
                <div className="field" style={{ gridColumn: '1 / -1' }}><label>Cancelled because</label><div className="ro-value">{selected.cancelReason}</div></div>
              )}
              <div className={`field${slaMissing ? ' invalid' : ''}`}><label>SLA due{isEC && open ? ' *' : ''}</label>
                {isEC && open ? (
                  <input type="date" min={/^\d{4}-\d{2}-\d{2}$/.test(selected?.slaDueAt || '') && selected.slaDueAt < todayIso() ? selected.slaDueAt : todayIso()} value={/^\d{4}-\d{2}-\d{2}$/.test(draft.slaDueAt) ? draft.slaDueAt : ''} onChange={(e) => setD('slaDueAt', e.target.value)} />
                ) : <div className="ro-value">{slaLabel(selected.slaDueAt)}</div>}
                {slaMissing && <div className="field-error">SLA due is required</div>}
                {canManageTickets && !isEC && open && <small className="muted">Only an EC member can change the SLA date.</small>}
              </div>
              {selected.preferredTime && <div className="field"><label>Preferred time</label><div className="ro-value">{selected.preferredTime}</div></div>}
            </div>

            <CustomFields sectionId={COLLECTIONS.TICKETS} value={draft} onChange={setD} />
            <div style={{ marginTop: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 650, marginBottom: 4 }}>Files</label>
              <AttachmentList items={draft.attachments} onRemove={canAttach ? (i) => setD('attachments', draft.attachments.filter((_, j) => j !== i)) : undefined} />
              {(selected.photos || []).length > 0 && <div className="photo-grid" style={{ marginTop: 6 }}>{selected.photos.map((p, i) => <img key={i} src={p} alt="" style={{ cursor: 'zoom-in' }} onClick={() => setPhotoView({ dataUrl: p, name: `Photo ${i + 1}`, mime: 'image/jpeg' })} />)}</div>}
              {canAttach && <div style={{ marginTop: 8 }}><AttachmentPicker pending={pendingFiles} onChange={setPendingFiles} /></div>}
            </div>


            {isResident && selected.status === 'Closed' && (
              <div className="field" style={{ marginTop: 14 }}><label>Rate the resolution (1–5)</label>
                <select value={draft.residentRating || ''} onChange={(e) => setD('residentRating', Number(e.target.value))}>
                  <option value="">Not rated</option>
                  {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
            )}


              <RecordMeta record={selected} />
            </div>

            <div hidden={dtab !== 'money'} className="tk-pane">
              <MoneyTiles items={moneyTiles} />
            {showFinance && (
              <div className="card fin-card" id="fin-card">
                <h3 style={{ marginTop: 0 }}>Financial workflow</h3>
                <p className="muted fin-note" style={{ marginTop: -6 }}>Tracked separately from the task status - residents never see this section.</p>
                <label className="check">
                  <input type="checkbox" data-testid="financial-flag" checked={!!draft.financial} disabled={!open || !canSetFinancial || (!!baseline.financial && (pos?.paid || 0) > 0)} onChange={(e) => setD('financial', e.target.checked)} /> 💰 Involves a financial transaction
                </label>
                <small className="muted fin-note" style={{ display: 'block', marginBottom: 10 }}>Flags the task for the finance team and links it to the Payments Cross-check.{!canSetFinancial ? ' Only the EC and Super Admin (or roles given that permission) can change this.' : (baseline.financial && (pos?.paid || 0) > 0) ? ' Locked: a payment has been made.' : ''}</small>

                {baseline.financial ? (
                  <>
                    <QuotationsPanel
                      kind="Quotation"
                      ticket={selected}
                      selectedIds={chosenQuoteIds(draft)}
                      onSelect={chooseQuote}
                      quoteTools={quoteTools}
                      invoicesExist={hasInvoices}
                      onAdded={(doc) => documentAdded('Quotation', doc)}
                      canEdit={open && (isEC || isCoordinator)}
                      vendors={vendors}
                      defaultVendor={assignInfo.row?.vendor || selected.assignedTo}
                    />
                    <ReleasesPanel ticket={selected} kit={kit} vendors={vendors} users={users} open={open} canEC={isEC} canAsk={isEC || isCoordinator} onSaveTicket={(patch) => act(patch)} defaultVendor={assignInfo.row?.vendor || selected.assignedTo} />
                    <QuotationsPanel
                      kind="Invoice"
                      ticket={selected}
                      invoiceTools={invoiceTools}
                      quotesExist={hasQuotes}
                      onAdded={(doc) => documentAdded('Invoice', doc)}
                      canEdit={open && (isEC || isCoordinator)}
                      vendors={vendors}
                      defaultVendor={assignInfo.row?.vendor || selected.assignedTo}
                    />
                  </>
                ) : (
                  <small className="muted" style={{ display: 'block' }}>{draft.financial ? 'Save the task to upload quotations and invoices.' : 'Tick the box above to upload quotations and invoices and send them for EC and final approval.'}</small>
                )}

                {baseline.financial && !hasInvoices && !draft.selectedQuotationId && (
                  <LedgerLink ticket={selected} />
                )}
                {!baseline.financial && draft.financial && <small className="muted">Save the task to link it to the Payments Cross-check.</small>}
              </div>
            )}

            </div>

            {formError && <div className="notice error" style={{ marginTop: 10 }}>{formError}</div>}
            {(dirty || savingTicket) && (
              <div className="save-bar">
                <span>Unsaved changes{changedKeys.length ? ` · ${changedKeys.length} field${changedKeys.length > 1 ? 's' : ''}` : ''}{pendingFiles.length ? ` · ${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}` : ''}</span>
                <button type="submit" className="btn" disabled={savingTicket}>{savingTicket ? 'Saving…' : 'Save changes'}</button>
                <button type="button" className="btn secondary" disabled={savingTicket} onClick={discardChanges}>Discard</button>
              </div>
            )}
          </form>

          <div hidden={dtab !== 'chat'} className="tk-pane">
            <CommentThread
              comments={comments}
              ticketId={selected.id}
              author={currentUser?.name || role?.name || 'Unknown'}
              authorRoleId={roleId}
              isFieldStaff={isFieldStaff}
              canPost
              onAdd={postComment}
            />
          </div>

          <div hidden={dtab !== 'history'} className="tk-pane">
            <ol className="hist">
              {events.map((e, i) => (
                <li key={i} className={e.tone || ''}><i>{e.icon}</i><div><span>{e.text}</span>{e.when ? <small>{new Date(e.when).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', ...(String(e.when).length && new Date(e.when).getHours() + new Date(e.when).getMinutes() ? { hour: '2-digit', minute: '2-digit' } : {}) })}</small> : null}</div></li>
              ))}
            </ol>
            {/* deleting a task is rare (Super Admin only): at the end of its history, not at the top of every task */}
            <TaskDelete ticket={selected} onDone={closeDetail} />
          </div>

        </Modal>
        );
      })()}

      {promptNode}
      {assetAsk && <AssetBackDialog ticket={assetAsk} onClose={() => setAssetAsk(null)} />}
    </div>
  );
}
