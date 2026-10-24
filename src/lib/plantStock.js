// The plant's chemicals are Inventory items: the daily plant log's salt and chlorine use is taken out of their stock, so the store holds one
// stock figure. Kept apart from plantLogs.js (pure helpers) because it reads and writes Inventory.
import { COLLECTIONS as C } from './storage/StorageAdapter.js';
import { secureStorage } from './storage/secureStorage.js';
import { getDataSource } from './storage/dataSource.js';

export const CHEMICALS = [
  { key: 'salt', label: 'Salt', used: 'saltUsed', stock: 'saltStock', unit: 'kg', match: (i) => /\bsalt\b/i.test(i.item || '') },
  { key: 'chlorine', label: 'Chlorine', used: 'chlorineUsed', stock: 'chlorineStock', unit: 'L', match: (i) => /hypochlorite|chlorine/i.test(i.item || '') && !/pool|pump|diaphragm/i.test(i.item || '') },
];
/** The Inventory item that holds a chemical (Water & Sewage first, then any item of that name). */
export function plantItem(inventory, chem) {
  const list = inventory || [];
  return list.find((i) => i.category === 'Water & Sewage' && chem.match(i)) || list.find((i) => chem.match(i)) || null;
}
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? 0 : Number(v));
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('en-IN');

/**
 * Take the day's use out of Inventory: the change against what was saved before for that day (a new log issues all of it, an edit only the
 * difference, a lower figure puts stock back). Returns the lines said to the person: what was taken, and what could not be.
 */
export async function issueForLog(before, after) {
  const said = [];
  let inventory = [];
  try { inventory = await secureStorage.list(C.INVENTORY); } catch { return ['Inventory could not be read, so its stock was not updated.']; }
  for (const chem of CHEMICALS) {
    const delta = num(after?.[chem.used]) - num(before?.[chem.used]);
    if (Math.abs(delta) < 0.0005) continue;
    const item = plantItem(inventory, chem);
    if (!item) { said.push(`${chem.label}: no Inventory item to take it from (add one under Inventory, category Water & Sewage).`); continue; }
    const note = `Plant log ${after.date}${delta < 0 ? ' (corrected)' : ''}`;
    try {
      if (getDataSource().mode === 'v2') {
        const { moveStockV2 } = await import('./storage/v2/V2ApiAdapter.js');
        await moveStockV2(item.id, { kind: delta > 0 ? 'Issued' : 'Received', quantity: Math.round(Math.abs(delta) * 1000) / 1000, date: after.date, note });
      } else {
        const left = num(item.quantity) - delta;
        if (left < 0) throw new Error(`Only ${fmt(num(item.quantity))} ${item.uom || chem.unit} of ${item.item} in stock`);
        await secureStorage.put(C.INVENTORY, { ...item, quantity: Math.round(left * 1000) / 1000, movementNote: note });
      }
      said.push(`${chem.label}: ${delta > 0 ? 'took' : 'put back'} ${fmt(Math.abs(delta))} ${chem.unit} ${delta > 0 ? 'from' : 'into'} ${item.item}.`);
    } catch (e) {
      said.push(`${chem.label}: the log is saved, but ${item.item} was not updated - ${e?.message || 'not permitted'}. Record the delivery in Inventory, then edit the log again.`);
    }
  }
  return said;
}

/** An item's movements this month (server only; the browser demo keeps no movement history). */
export async function movesInMonth(item, month) {
  if (!item || getDataSource().mode !== 'v2') return null;
  const { stockMovesV2 } = await import('./storage/v2/V2ApiAdapter.js');
  return (await stockMovesV2(item.id)).filter((m) => String(m.onDate || '').slice(0, 7) === month);
}
