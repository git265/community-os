// Version control for the map. Every time an asset's position (shape, breaks, plan) or the plan's setup (boundary, position on the real
// map, scale) changes, the system keeps what it was before and what it is now. The map shows this as History, offers Undo right after a
// change, and can restore any earlier version (a restore is itself a new change, so nothing is ever lost).
import { storage, COLLECTIONS as C } from '../storage/index.js';
import { uuid } from '../uuid.js';

export const TRACKED = { [C.EQUIPMENT]: ['shape', 'breaks', 'planId'], [C.INFRA_PLANS]: ['boundary', 'geoRef', 'metersPerPx'] };
const KEEP = 40; // versions kept per record
const pick = (rec, keys) => Object.fromEntries(keys.map((k) => [k, rec?.[k] ?? '']));
const count = (s) => { try { const j = JSON.parse(s); return Array.isArray(j) ? j.length : (j?.c?.length || 0); } catch { return 0; } };

function describe(kind, before, after, action) {
  if (action === 'create') return kind === 'asset' ? 'Added to the map' : 'Plan added';
  if (action === 'delete') return 'Removed';
  const out = [];
  const same = (k) => String(before?.[k] ?? '') === String(after?.[k] ?? '');
  if (kind === 'asset') {
    if (!same('shape')) { const a = before?.shape ? JSON.parse(before.shape) : null; const b = after?.shape ? JSON.parse(after.shape) : null; out.push(!a ? 'Placed on the map' : !b ? 'Taken off the map' : a.t === 'point' ? `Pin moved (${Math.round(a.c[0])}, ${Math.round(a.c[1])}) to (${Math.round(b.c[0])}, ${Math.round(b.c[1])})` : `${b.t === 'zone' ? 'Outline' : 'Line'} redrawn (${a.c.length} to ${b.c.length} points)`); }
    if (!same('breaks')) { const x = count(before?.breaks); const y = count(after?.breaks); out.push(y > x ? 'Break marked on the pipe' : y < x ? 'Break cleared' : 'Break changed'); }
    if (!same('planId')) out.push('Moved to another plan');
  } else {
    if (!same('boundary')) out.push(!before?.boundary ? 'Boundary drawn' : !after?.boundary ? 'Boundary removed' : 'Boundary redrawn');
    if (!same('geoRef')) out.push(!before?.geoRef ? 'Placed on the real map' : 'Re-aligned to the real map');
    if (!same('metersPerPx')) out.push(`Scale ${before?.metersPerPx ? `${before.metersPerPx} to ` : 'set to '}${after?.metersPerPx} m per pixel`);
  }
  return out.join('; ');
}

/** Called by the secure storage layer after a write. Never throws and never blocks the save. */
let pendingRestore = '';
/** Set just before a restore writes, so the new version is labelled "Restored". */
export const markRestore = (label = 'restore') => { pendingRestore = label; };
export async function recordMapVersion({ collection, old, next, who, action = 'update' }) {
  const restoreOf = pendingRestore; pendingRestore = '';
  try {
    const keys = TRACKED[collection]; if (!keys) return;
    const kind = collection === C.EQUIPMENT ? 'asset' : 'plan';
    let before; let after;
    if (action === 'delete') { before = { ...old }; after = null; }
    else { before = old ? pick(old, keys) : null; after = pick(next, keys); }
    if (action === 'update' && keys.every((k) => String(before?.[k] ?? '') === String(after?.[k] ?? ''))) return;
    const rows = await storage.list(C.MAP_VERSIONS);
    const n = rows.reduce((m, r) => Math.max(m, Number(String(r.shortId || '').replace('MVR-', '')) || 0), 0) + 1;
    const rid = (next || old).id;
    const row = { id: uuid(), shortId: `MVR-${String(n).padStart(4, '0')}`, kind, recordId: rid, name: (next || old).name || '', action, summary: (restoreOf ? 'Restored: ' : '') + describe(kind, before, after, action), at: new Date().toISOString(), by: who || 'System', before: before ? JSON.stringify(before) : '', after: after ? JSON.stringify(after) : '' };
    await storage.put(C.MAP_VERSIONS, row);
    const mine = rows.filter((r) => r.recordId === rid).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    for (const r of mine.slice(0, Math.max(0, mine.length + 1 - KEEP))) await storage.remove(C.MAP_VERSIONS, r.id);
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.MAP_VERSIONS } }));
  } catch (e) { console.warn('map history not recorded', e); }
}

export const parseVersion = (v) => { try { return { before: v.before ? JSON.parse(v.before) : null, after: v.after ? JSON.parse(v.after) : null }; } catch { return { before: null, after: null }; } };

/** Put an asset or plan back to what a version recorded. `which` = 'before' (undo that change) . Returns the saved record or null. */
export async function restoreVersion(v, save, which = 'before') {
  const { before } = parseVersion(v);
  if (!before) return null;
  markRestore();
  if (v.action === 'delete') return save({ ...before }); // bring a removed asset back with its old id
  const rec = (await storage.get(v.kind === 'asset' ? C.EQUIPMENT : C.INFRA_PLANS, v.recordId));
  if (!rec) return null;
  return save({ ...rec, ...before });
}
