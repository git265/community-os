import { fmtDateTime } from './locale.js';
// Service notices: "the whole community has no power", "water supply is off in Block B". Staff post one; residents then see it
// before they raise a request, and a request that is clearly about the same thing asks them to confirm (or is not accepted),
// so the helpdesk is not buried under 150 copies of "no power".
export const KINDS = {
  'Power cut': { icon: '⚡', words: ['power', 'electricity', 'electric supply', 'current', 'blackout', 'no light', 'lights out', 'outage', 'mcb', 'tripping', 'inverter'], hint: 'Back when the grid is restored.' },
  'Water supply': { icon: '💧', words: ['water', 'tap', 'tank', 'pressure', 'borewell', 'no supply'], hint: 'Back when the tanks refill.' },
  'Lift': { icon: '🛗', words: ['lift', 'elevator'], hint: '' },
  'Internet / cable': { icon: '📶', words: ['internet', 'wifi', 'wi-fi', 'broadband', 'cable tv', 'fibre', 'fiber'], hint: '' },
  'Gas supply': { icon: '🔥', words: ['gas', 'lpg', 'pipeline gas'], hint: '' },
  Other: { icon: '📢', words: [], hint: '' },
};
export const KIND_NAMES = Object.keys(KINDS);
export const iconOf = (kind) => KINDS[kind]?.icon || '📢';

export const isActive = (n) => n?.status === 'Active';
export const covers = (n, block) => n.scope !== 'Selected blocks' || (Array.isArray(n.blocks) ? n.blocks : []).includes(block);

const norm = (s) => ` ${String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
/** Does this text look like it is about this kind of outage? ("no power in my villa" -> Power cut). */
export const aboutKind = (kind, text) => { const t = norm(text); return (KINDS[kind]?.words || []).some((w) => t.includes(norm(w).trimEnd()) || t.includes(norm(w))); };

/** Active notices that cover this block and that the request text is about. */
export function matching(notices, { text = '', block = '' } = {}) {
  return notices.filter((n) => isActive(n) && covers(n, block) && aboutKind(n.kind, text));
}

const CLOSED = ['Closed', 'Cancelled', 'Rejected', 'Resolved', 'Completed'];
/**
 * Several villas reporting the same thing in a short time with no notice up: that is an outage. Returns [{ kind, villas, count }].
 */
export function suggest(tickets, notices, { now = Date.now(), hours = 3, minVillas = 3 } = {}) {
  const since = now - hours * 3600e3;
  const recent = tickets.filter((t) => t.unit && !CLOSED.includes(t.status) && new Date(t.recordCreatedAt || 0).getTime() >= since);
  return KIND_NAMES.filter((k) => k !== 'Other' && !notices.some((n) => isActive(n) && n.kind === k)).map((kind) => {
    const villas = [...new Set(recent.filter((t) => aboutKind(kind, `${t.title} ${t.description || ''}`)).map((t) => t.unit))];
    return { kind, villas, count: villas.length };
  }).filter((s) => s.count >= minVillas);
}

export const fmtWhen = (iso) => fmtDateTime(iso);
export const defaultMessage = (kind, scopeText) => ({
  'Power cut': `There is a power cut ${scopeText}. The team is checking the supply and the DG / backup. You do not need to raise a request for this.`,
  'Water supply': `Water supply is interrupted ${scopeText}. The team is working on it. You do not need to raise a request for this.`,
  Lift: `A lift is out of service ${scopeText}. The team has been told.`,
  'Internet / cable': `Internet / cable is down ${scopeText}. The provider has been informed.`,
  'Gas supply': `Pipeline gas is interrupted ${scopeText}. The provider has been informed.`,
  Other: `A service is affected ${scopeText}.`,
}[kind] || '');
