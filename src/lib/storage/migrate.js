// Copy a whole community between data sources (session <-> backend), so a demo built in the browser can be pushed to the
// database, or a database pulled into the browser for a quick offline look. Uses the adapters directly (not the facade).
import { ADAPTERS, COLLECTIONS } from './index.js';

const CHUNK = 400;

/** @param {'session'|'api'} from  @param {'session'|'api'} to  @param {{slug:string, wipe?:boolean, onProgress?:(done:number,total:number,name:string)=>void}} opts */
export async function copyCommunity(from, to, { slug, wipe = true, onProgress } = {}) {
  if (from === to) throw new Error('Pick two different data sources.');
  const src = ADAPTERS[from].forCommunity(slug);
  const dst = ADAPTERS[to].forCommunity(slug);
  const names = [...new Set(Object.values(COLLECTIONS))];
  let rowsCopied = 0;
  for (let i = 0; i < names.length; i++) {
    const c = names[i];
    onProgress?.(i, names.length, c);
    let rows = await src.list(c);
    if (c === COLLECTIONS.COMMUNITIES) { // the platform registry is shared by every community: copy only THIS community's row
      rows = rows.filter((r) => r.slug === slug);
      for (const r of rows) await dst.put(c, r);
      rowsCopied += rows.length; continue;
    }
    if (!rows.length) continue;
    if (wipe) await dst.replaceAll(c, []);
    if (c === COLLECTIONS.FILES) {
      for (const r of rows) { const full = (await src.get(c, r.id)) || r; await dst.put(c, full); }
    } else {
      for (let j = 0; j < rows.length; j += CHUNK) await dst.putMany(c, rows.slice(j, j + CHUNK));
    }
    rowsCopied += rows.length;
  }
  onProgress?.(names.length, names.length, '');
  return { collections: names.length, rows: rowsCopied };
}
