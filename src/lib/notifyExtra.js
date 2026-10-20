// Notifications for the places that had none: forum, polls, e-voting results and reminders, ticket chat, tasks raised by
// residents, and release approvals (maintenance and cultural). Called from secureStorage after a successful write
// (`notifyAfterWrite`) and from the App scheduler (`runBallotReminders`). Each uses an EVENT from notify.js, so the community
// can switch channels per event and each person can pick WhatsApp / SMS / e-mail. Every row carries a deep link.
import { storage } from './storage/index.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { notify } from './notify.js';
import { planState, stepWho } from './approval/engine.js';
import { finalApproverRoleIds } from '../modules/tickets/ticketEngine.js';

const safe = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n = 110) => (safe(s).length > n ? `${safe(s).slice(0, n)}…` : safe(s));
const parse = (v) => { try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; } };
const rolesOf = (roles, cats) => roles.filter((r) => cats.includes(r.category)).map((r) => r.id);
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

async function approverRoleIds(step, roles) {
  const ids = new Set();
  for (const a of step?.approvers || []) {
    if (a.kind === 'role') ids.add(a.value);
    else if (a.kind === 'group' && a.value === 'EC members') rolesOf(roles, ['EC']).forEach((x) => ids.add(x));
    else if (a.kind === 'group' && a.value === 'Final approvers') finalApproverRoleIds(await storage.list('approverSettings')).forEach((x) => ids.add(x));
  }
  return [...ids];
}

export async function notifyAfterWrite({ collection, old, next, actor }) {
  const roles = await storage.list(C.ROLES);
  const by = actor?.name || '';

  if (collection === C.FORUM && !old) {
    const poll = next.kind === 'Poll';
    await notify({ event: poll ? 'poll' : 'forum_topic', title: `${poll ? 'New poll' : 'New forum topic'} · ${next.title}`, body: `${by || 'A neighbour'} started “${next.title}” in ${next.category || 'the forum'}.`, link: `#/forum/${next.id}`, toRoleIds: rolesOf(roles, ['Resident', 'EC']), by });
  }

  if (collection === C.FORUM_POSTS && !old) {
    const topic = await storage.get(C.FORUM, next.topicId);
    const parent = next.parentId ? await storage.get(C.FORUM_POSTS, next.parentId) : null;
    const names = new Set([topic?.author || String(topic?.recordCreatedBy || '').replace(/ \(.*\)$/, ''), parent?.author].filter(Boolean));
    names.delete(by);
    for (const nm of names) await notify({ event: 'forum_reply', title: `New reply · ${topic?.title || 'forum'}`, body: `${by || 'Someone'} replied: ${clip(next.body)}`, link: `#/forum/${next.topicId}`, toName: nm, by });
  }

  if (collection === C.BALLOTS && old && old.status !== 'Closed' && next.status === 'Closed') {
    await notify({ event: 'ballot_result', title: `Voting closed · ${next.title}`, body: 'The votes are counted. Open E-voting to see the result and verify your receipt.', link: `#/ballot/${next.id}`, toRoleIds: rolesOf(roles, ['Resident', 'EC']), by });
  }

  if (collection === C.TICKET_COMMENTS && !old && next.authorRoleId !== 'system') {
    const t = await storage.get(C.TICKETS, next.ticketId);
    if (t) {
      const pub = next.visibility !== 'Internal';
      const names = new Set([t.assignedTo, pub ? t.createdBy : null].filter(Boolean)); names.delete(next.author); names.delete(by);
      for (const nm of names) await notify({ event: 'ticket_chat', title: `New message · ${t.ticketNumber}`, body: `${next.author || by}: ${clip(next.body)}`, link: `#/ticket/${t.ticketNumber}/chat`, toName: nm, by, extra: { ticketId: t.id, ticketNumber: t.ticketNumber, ticketTitle: t.title } });
    }
  }

  if (collection === C.TICKETS && !old && next.scope !== 'Community') {
    const resident = roles.find((r) => r.id === next.createdByRole)?.category === 'Resident';
    if (resident) await notify({ event: 'ticket_new', title: `New request from ${next.unit || 'a resident'} · ${next.ticketNumber}`, body: `${next.title}${next.location ? ` — ${next.location}` : ''}. ${next.assignedTo ? '' : 'Not assigned yet.'}`.trim(), link: `#/ticket/${next.ticketNumber}`, toRoleIds: roles.filter((r) => ['facility_manager', 'helpdesk'].includes(r.id)).map((r) => r.id), by, extra: { ticketId: next.id, ticketNumber: next.ticketNumber, ticketTitle: next.title } });
  }

  if (collection === C.RELEASES) {
    const cultural = !!next.expenseId;
    const link = cultural ? '#/cultural' : next.ticketShortId ? `#/ticket/${next.ticketShortId}` : '#/billing';
    const what = `${inr(next.amount)} release to ${next.vendor || 'a payee'}${next.ticketShortId ? ` (${next.ticketShortId})` : ''}`;
    const was = planState(parse(old?.plan)); const now = planState(parse(next.plan));
    if (now.key === 'pending' && (!old || was.key !== 'pending' || was.index !== now.index)) {
      const toRoleIds = await approverRoleIds(now.step, roles);
      if (toRoleIds.length) await notify({ event: 'approval', title: `Release approval needed${next.ticketShortId ? ` · ${next.ticketShortId}` : ''}`, body: `${what} waits for ${stepWho(now.step, (id) => roles.find((r) => r.id === id)?.name || id)}.`, link, toRoleIds, by });
    }
    if (old && now.key === 'approved' && was.key !== 'approved') {
      await notify({ event: 'ticket_decision', title: 'Release approved', body: `${what} is approved and now in Payments.`, link, toName: next.requestedBy || next.recordCreatedBy, by });
      await notify({ event: 'payment_made', title: 'Release ready to pay', body: `${what} is approved. Open Payments.`, link: '#/billing', toRoleIds: ['treasurer'], by });
    }
    if (old && now.key === 'rejected' && was.key !== 'rejected') await notify({ event: 'ticket_decision', title: 'Release rejected', body: `${what} was rejected.`, link, toName: next.requestedBy || next.recordCreatedBy, by });
    if (old && old.status !== 'Paid' && next.status === 'Paid') await notify({ event: 'payment_made', title: 'Release paid', body: `${what} has been paid.`, link, toName: next.requestedBy || next.recordCreatedBy, by });
  }
}

/** Open ballots closing within 2 days: remind each villa that has not voted yet, once per ballot. */
export async function runBallotReminders(now = new Date()) {
  const ballots = (await storage.list(C.BALLOTS)).filter((b) => b.status === 'Open' && b.closesOn);
  if (!ballots.length) return 0;
  const sent = await storage.list('notifications');
  let n = 0;
  for (const b of ballots) {
    const left = (new Date(`${b.closesOn}T23:59:59`) - now) / 86400000;
    if (left < 0 || left > 2 || sent.some((x) => x.kind === 'ballot_reminder' && x.ballotId === b.id)) continue;
    const voted = new Set((await storage.list(C.VOTE_ROLL)).filter((m) => m.ballotId === b.id).map((m) => m.unit));
    const units = [...new Set((b.roll || []).map((r) => r.unit))].filter((u) => !voted.has(u));
    for (const u of units) { await notify({ event: 'ballot', kind: 'ballot_reminder', title: `Last chance to vote · ${b.title}`, body: `Voting closes on ${b.closesOn}. ${u} has not voted yet.`, link: `#/ballot/${b.id}`, toUnit: u, by: 'System', extra: { ballotId: b.id } }); n += 1; }
  }
  return n;
}
