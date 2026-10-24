// AMC and service visits are kept on the asset (Assets → the asset, or the Site map): an entry in its condition history - "AMC visit · Otis" -
// with what was done and the visit report, which moves the asset's last and next service dates. The vendor (Vendors) holds the AMC contract;
// Audits keep the independent inspections and certificates. On the server: POST /assets/{id}/service-visits (AssetService.serviceVisit).
import { todayLocal } from './locale.js';
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { getDataSource } from './storage/dataSource.js';
import { persistPending } from './files/attachments.js';

export const VISIT_KINDS = ['AMC visit', 'Service', 'Repair', 'Warranty claim'];
/** Is this condition history entry a service visit? Then { kind, vendor }. */
export function visitOf(entry) {
  const src = String(entry?.source || '');
  const kind = VISIT_KINDS.find((k) => src === k || src.startsWith(`${k} · `));
  return kind ? { kind, vendor: src.slice(kind.length + 3) || '' } : null;
}
const today = todayLocal;

/** Log a visit: v = { date, kind, vendor, condition, note, nextService }; pending: the report files picked. Returns the history entry. */
export async function logServiceVisit(asset, v, pending = [], by = '') {
  const date = v.date || today();
  if (date > today()) throw new Error('The visit date is today or earlier');
  if (v.nextService && v.nextService < date) throw new Error('The next service is on or after the visit');
  if (!VISIT_KINDS.includes(v.kind)) throw new Error(`A visit is one of: ${VISIT_KINDS.join(', ')}`);
  const { secureStorage } = await import('./storage/secureStorage.js');
  const { uuid } = await import('./uuid.js');
  const id = uuid();
  const reports = pending.length ? await persistPending(pending, { ownerType: 'conditionLog', ownerId: id }) : [];
  if (!reports) return null;
  const source = `${v.kind}${v.vendor ? ` · ${String(v.vendor).trim()}` : ''}`;
  if (getDataSource().mode === 'v2') {
    const { serviceVisitV2 } = await import('./storage/v2/V2ApiAdapter.js');
    const e = await serviceVisitV2(asset.id, { date, kind: v.kind, vendor: v.vendor || null, condition: v.condition || 'Working', note: v.note || null, nextService: v.nextService || null }, reports.map((m) => m.fileId));
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.INFRA_LOG } }));
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: C.EQUIPMENT } }));
    return { ...e, reports };
  }
  const entry = await secureStorage.put(C.INFRA_LOG, { id, assetId: asset.id, assetName: asset.name, date, condition: v.condition || 'Working', source, note: String(v.note || '').trim(), by, reports },
    { summaryOf: () => `${asset.name}: ${source}`, label: 'Condition log' });
  if (!entry) return null;
  const nextService = v.nextService || (asset.nextService && asset.nextService >= date ? asset.nextService : '');
  if (!asset.lastService || asset.lastService <= date) await secureStorage.put(C.EQUIPMENT, { ...asset, lastService: date, nextService, status: v.condition || 'Working', lastInspected: date }, { summaryOf: () => `${asset.name}: serviced`, label: 'Equipment' });
  return entry;
}
