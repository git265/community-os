// One-shot "open this tab" hints written by global search (sessionStorage) and read by a page when it mounts.
// The hint is cleared a moment after it is read (not at once) so React's double render in development sees it twice.
const KEY = 'communityos:openTab';
export function takeHint(valid) {
  try {
    const t = sessionStorage.getItem(KEY);
    if (!t) return '';
    const ok = !valid || valid.includes(t);
    if (ok) setTimeout(() => { try { if (sessionStorage.getItem(KEY) === t) sessionStorage.removeItem(KEY); } catch { /* ignore */ } }, 400);
    return ok ? t : '';
  } catch { return ''; }
}
