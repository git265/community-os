// secureStorage when the BACK END (backend/api) is the authority: this browser only asks. Who may see which rows, which fields are hidden, what a
// write is allowed to change, the stamps and the audit line are all decided and written by the server in one transaction.
import { storage } from './index.js';
import { uuid } from '../uuid.js';
import { ConflictError } from '../security/errors.js';

// After every write the screens are told, exactly as the browser rule book does (secureStorage.js notify): every list of that collection reloads and
// holds the version the server just stamped. Without this a screen kept the version it had before the save, and the NEXT save of the same record was
// refused as "changed by someone else".
const changed = (c) => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: c } })); };
const announce = (c) => (result) => { changed(c); return result; };

// A safety net for screens that keep their own copy of a record and do not reload it after saving: the versions THIS tab wrote, per record.
// When the server refuses a save as stale but the stored version is the one this tab itself wrote last (and the version sent is one this tab
// started from), nobody else has touched the record in between: the save is sent again on top of our own last write. A change by anyone else
// still ends in the "changed by someone else" message.
const own = new Map();   // `${collection}|${id}` -> { base: first version sent, to: last version the server stamped for us }
function remember(c, sent, saved) {
  if (!saved?.id || saved.recVersion == null) return;
  const k = `${c}|${saved.id}`; const o = own.get(k); const v = Number(sent?.recVersion);
  own.set(k, o && Number.isFinite(v) && v >= o.base && v <= o.to ? { base: o.base, to: Number(saved.recVersion) } : { base: Number.isFinite(v) ? v : Number(saved.recVersion), to: Number(saved.recVersion) });
}
function ownConflict(c, sent, err) {
  const o = own.get(`${c}|${sent.id}`); const cur = Number(err?.current?.recVersion); const v = Number(sent.recVersion);
  return !!o && Number.isFinite(cur) && cur === o.to && Number.isFinite(v) && v >= o.base && v < cur;
}

export const remoteSecure = {
  list: (c) => storage.list(c),
  query: (c, params) => storage.query(c, params),
  get: (c, id) => storage.get(c, id),
  // the server stamps ids, short ids, versions and the audit line; we send the version we loaded so a stale save is refused (409)
  async put(c, record, { summaryOf, label } = {}) {
    const rec = { ...record, id: record.id || uuid() };
    let summary = ''; try { summary = summaryOf ? String(summaryOf(rec) ?? '') : ''; } catch { /* the server falls back to the short id */ }
    const body = { ...rec, __opts: { label: label || '', summary } };
    let saved;
    try { saved = await storage.put(c, body); }
    catch (e) {
      if (!(e instanceof ConflictError) || !ownConflict(c, rec, e)) throw e;
      saved = await storage.put(c, { ...body, recVersion: e.current.recVersion });   // our own earlier save is the only newer version
    }
    remember(c, rec, saved);
    return announce(c)(saved);
  },
  // the typed API has no generic delete / bulk routes: those go through its adapter (V2ApiAdapter), which knows each collection's own calls
  remove: (c, id) => storage.remove(c, id).then(() => { changed(c); return undefined; }),
  createMany: (c, rows) => storage.putMany(c, rows).then(announce(c)),
  updateMany: (c, rows) => storage.putMany(c, rows).then(announce(c)),
  importMany: (c, rows) => storage.putMany(c, rows).then((out) => { changed(c); return out.length; }),
};
