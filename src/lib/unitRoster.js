import { useEffect, useState } from 'react';
import { COLLECTIONS } from './storage/index.js';
import { secureStorage } from './storage/secureStorage.js';
import { getDataSource } from './storage/dataSource.js';

/**
 * The units as pickers, counts and audiences need them: [{ id, unit, zone, blockId, type, occupancy, owner?, tenant? }].
 * On the back end one call (GET /units/roster, a slim row a unit, a resident's own homes), shared for a minute and never stored on the device;
 * the browser demo reads its own list. Screens that need a unit's full record read that one unit.
 */
export async function unitRoster() {
  if (getDataSource().mode === 'v2') {
    const { unitRosterV2 } = await import('./storage/v2/V2ApiAdapter.js');
    return (await unitRosterV2()).slice();   // the rows are shared: each screen gets its own array to sort
  }
  return secureStorage.list(COLLECTIONS.PROPERTIES);
}

/** The roster for a screen: read when shown (and enabled), again when units or blocks change. */
export function useUnitRoster({ enabled = true } = {}) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    if (!enabled) { setLoading(false); return undefined; }
    let on = true;
    const load = () => unitRoster().then((r) => { if (on) setRecords(r); })
      .catch((err) => {
        if (!on) return;
        setRecords([]);
        if (err?.name !== 'AuthzError') window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: `Units could not be loaded: ${err?.message || 'error'}`, kind: err?.name === 'NetworkError' || err?.name === 'TimeoutError' ? 'network' : 'error' } }));
      })
      .finally(() => { if (on) setLoading(false); });
    load();
    const h = (e) => { const c = e?.detail?.collection; if (c === COLLECTIONS.PROPERTIES || c === COLLECTIONS.BLOCKS) load(); };
    window.addEventListener('communityos:changed', h);
    return () => { on = false; window.removeEventListener('communityos:changed', h); };
  }, [enabled]);
  return { records, loading };
}
