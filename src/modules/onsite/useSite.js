import { useCallback, useEffect, useRef, useState } from 'react';
import { SITE_CHANGED } from '../../lib/site/site.js';

/** Load something from the device layer, again when it changes (or every `every` ms while the screen is open). */
export function useLoad(load, { every = 0, on = [SITE_CHANGED], deps = [] } = {}) {
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const live = useRef(true);
  const run = useCallback(async () => {
    try { const v = await load(); if (live.current) { setData(v); setError(''); } } catch (e) { if (live.current) setError(e.message || 'Could not load'); }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    live.current = true; run();
    const h = (e) => { if (on.includes(e.detail?.collection)) run(); };
    window.addEventListener('communityos:changed', h);
    const t = every ? setInterval(run, every) : null;
    return () => { live.current = false; window.removeEventListener('communityos:changed', h); if (t) clearInterval(t); };
  }, [run]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: run };
}

/** Ask the lists behind a screen to read again (no "saved" message: nothing was changed here). */
export const reread = (...collections) => { for (const c of collections) window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: c } })); };

export const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.floor(m / 60)} h ago` : `${Math.floor(m / 1440)} d ago`;
};
