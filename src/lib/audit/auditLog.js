import { htmlToText, looksLikeHtml } from '../richtext/sanitize.js';
import { storage, COLLECTIONS } from '../storage/index.js';
import { META_KEYS } from '../security/authz.js';
import { uuid } from '../uuid.js';
import { getPrincipal } from '../security/principal.js';
import { serverDecides } from '../auth/session.js';

export const getPrincipalLabel = () => { const p = getPrincipal(); return p ? (p.name === p.role?.name ? p.name : `${p.name} (${p.role?.name ?? p.roleId})`) : 'System'; };

/**
 * Every create/update/delete made through the secure storage layer writes one
 * of these. Audit rows are written with the RAW adapter (nobody can edit or
 * delete them through the app). On the real backend this is a DB trigger /
 * Hibernate Envers-style interceptor so it can't be skipped by a client.
 *
 * entry = { id, when, who, whoName, what, collection, recordId, unit, action,
 *           summary, changes: [{ field, label, from, to }] }
 */
let numbering = null;
/** SERVER ONLY: the database hands out audit numbers (a sequence), so nobody has to read the whole trail to number one line. */
export const setAuditNumbering = (fn) => { numbering = fn; };
export async function logChange(entry) {
  // when a server enforces access, ONLY the server writes the audit trail (it refuses everybody else); the browser has nothing to add
  if (!numbering && serverDecides()) return null;
  let n;
  if (numbering) n = await numbering();
  else { const rows = await storage.list(COLLECTIONS.AUDIT); n = rows.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace('AUD-', '')) || 0), 0) + 1; }
  const row = { id: uuid(), shortId: `AUD-${String(n).padStart(5, '0')}`, when: new Date().toISOString(), changes: [], ...entry };
  await storage.put(COLLECTIONS.AUDIT, row);
  return row;
}

/** For system-side and sign-in events that have no signed-in principal behind them (or bypass the secure storage layer). Never throws. */
export async function logEvent({ who = 'System', what, action = 'Update', summary = '', recordId = '', recordShortId = '', unit = '', changes = [] }) {
  try { return await logChange({ who, whoName: who, what, collection: what, recordId, recordShortId, unit, action, summary, changes }); } catch { return null; }
}

function short(v) {
  if (v === undefined || v === null || v === '') return '—';
  if (Array.isArray(v)) return v.every((x) => typeof x !== 'object') ? (v.length ? v.join(', ') : '—') : `${v.length} item(s)`;
  if (typeof v === 'object') return '{…}';
  let s = String(v);
  if (s.startsWith('data:')) return '[file]';
  if (looksLikeHtml(s)) s = htmlToText(s) || '—';
  return s.length > 160 ? `${s.slice(0, 157)}…` : s;
}

/** Compact picture of a record at creation or deletion: its filled-in fields only (max 14), so a deleted record can still be reviewed. */
export function snapshotRecord(rec, schema, kind = 'create') {
  const out = [];
  const keys = [...(schema?.fields || []).filter((f) => !f.hidden).map((f) => f.key), ...Object.keys(rec || {})];
  for (const key of [...new Set(keys)]) {
    if (META_KEYS.includes(key) || key === 'id' || key === 'shortId' || key === 'recVersion') continue;
    const v = rec?.[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Array.isArray(v))) continue;
    if (typeof v === 'string' && v.startsWith('data:')) continue;
    const label = schema?.fields.find((f) => f.key === key)?.label ?? key;
    out.push(kind === 'create' ? { field: key, label, from: '—', to: short(v) } : { field: key, label, from: short(v), to: '—' });
    if (out.length >= 14) break;
  }
  return out;
}

/** Field-level diff between the stored record and the incoming one. */
export function diffRecords(oldRec, newRec, schema) {
  const out = [];
  for (const key of Object.keys(newRec)) {
    if (META_KEYS.includes(key)) continue;
    const a = oldRec?.[key];
    const b = newRec[key];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const label = schema?.fields.find((f) => f.key === key)?.label ?? key;
    out.push({ field: key, label, from: short(a), to: short(b) });
  }
  return out;
}
