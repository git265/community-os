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

const RECENT_DAYS = 31;   // older logs are history: changing one never moves today's stock
const daysAgo = (date) => (Date.now() - new Date(`${date}T12:00:00`).getTime()) / 86400000;
const noteFor = (date) => `Plant log ${date}`;
/** What Inventory has already given for this day's log: its movements on the server (the history), the log's own note in the browser demo. */
async function takenFor(item, chem, date, before) {
  if (getDataSource().mode !== 'v2') return num(before?.[`${chem.key}FromStore`]);
  const { stockMovesV2 } = await import('./storage/v2/V2ApiAdapter.js');
  return (await stockMovesV2(item.id)).filter((m) => String(m.note || '').startsWith(noteFor(date)))
    .reduce((n, m) => n + (m.kind === 'Issued' ? num(m.quantity) : m.kind === 'Received' ? -num(m.quantity) : 0), 0);
}

/**
 * Take the day's use out of Inventory: what the log now says less what Inventory already gave for that day (so a corrected log moves only the
 * difference, a lower figure puts stock back, and a log whose stock could not be taken is taken in full next time). Logs older than a month
 * are history and move nothing. Returns the lines said to the person: what was taken, and what could not be.
 */
export async function issueForLog(before, after) {
  const said = [];
  if (!after?.date || daysAgo(after.date) > RECENT_DAYS) return said;
  let inventory = [];
  try { inventory = await secureStorage.list(C.INVENTORY); } catch { return ['Inventory could not be read, so its stock was not updated.']; }
  const kept = {};   // the browser demo notes on the log what Inventory gave
  for (const chem of CHEMICALS) {
    const item = plantItem(inventory, chem);
    if (!item) { if (num(after[chem.used]) > 0) said.push(`${chem.label}: no Inventory item to take it from (add one under Inventory, category Water & Sewage).`); continue; }
    let taken = 0;
    try { taken = await takenFor(item, chem, after.date, before); } catch { said.push(`${chem.label}: what Inventory already gave for this day could not be read, so its stock was not updated.`); continue; }
    const delta = num(after[chem.used]) - taken;
    if (Math.abs(delta) < 0.0005) continue;
    const note = `${noteFor(after.date)}${delta < 0 ? ' (corrected)' : ''}`;
    try {
      if (getDataSource().mode === 'v2') {
        const { moveStockV2 } = await import('./storage/v2/V2ApiAdapter.js');
        await moveStockV2(item.id, { kind: delta > 0 ? 'Issued' : 'Received', quantity: Math.round(Math.abs(delta) * 1000) / 1000, date: after.date, note });
      } else {
        const left = num(item.quantity) - delta;
        if (left < 0) throw new Error(`Only ${fmt(num(item.quantity))} ${item.uom || chem.unit} of ${item.item} in stock`);
        await secureStorage.put(C.INVENTORY, { ...item, quantity: Math.round(left * 1000) / 1000, movementNote: note });
        kept[`${chem.key}FromStore`] = Math.round((taken + delta) * 1000) / 1000;
      }
      said.push(`${chem.label}: ${delta > 0 ? 'took' : 'put back'} ${fmt(Math.abs(delta))} ${chem.unit} ${delta > 0 ? 'from' : 'into'} ${item.item}.`);
    } catch (e) {
      said.push(`${chem.label}: the log is saved, but ${item.item} was not updated - ${e?.message || 'not permitted'}. Record the delivery in Inventory, then save the log again.`);
    }
  }
  if (Object.keys(kept).length) { try { await secureStorage.put(C.PLANT_LOGS, { ...after, ...kept }); } catch { /* the stock moved; the note is only the demo's memory */ } }
  return said;
}

/** An item's movements this month (server only; the browser demo keeps no movement history). */
export async function movesInMonth(item, month) {
  if (!item || getDataSource().mode !== 'v2') return null;
  const { stockMovesV2 } = await import('./storage/v2/V2ApiAdapter.js');
  return (await stockMovesV2(item.id)).filter((m) => String(m.onDate || '').slice(0, 7) === month);
}
