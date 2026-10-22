// What the app is busy with, for the person using it. One place, used by every action, so no button needs its own spinner code:
//
//   track(promise, { write })  every call to the back end (apiFetch) and every write to the browser store goes through here
//   the button that started it  a click marks the button it was on: it is "busy" (no second click, a spinner after 1 s) until every
//                               request the click started has settled - succeeded, failed or timed out (the request layer never
//                               lets one hang: reads 15 s, writes 30 s, file bytes 120 s)
//   the activity bar            a thin bar and "Working…" after 1 s while a write or a clicked action is still going, "Still working…"
//                               after 12 s; "You are offline" while the browser has no network
//   errors nobody caught        an action that fails without its screen handling it still says so (a toast), instead of failing silently
//
// Background reads (lists refreshing, polls) do not show the bar: only what a person started, or a change being saved.
const listeners = new Set();
let shown = 0;             // writes and clicked actions in flight
let click = null;          // { button, at } the last click, for 400 ms
const perButton = new WeakMap();
const emit = () => { for (const f of listeners) { try { f(shown); } catch { /* a listener's own problem */ } } };
export const onActivity = (f) => { listeners.add(f); f(shown); return () => listeners.delete(f); };
export const busyCount = () => shown;

function claim(button) {
  const n = (perButton.get(button) || 0) + 1;
  perButton.set(button, n);
  button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true');
}
function release(button) {
  const n = (perButton.get(button) || 1) - 1;
  perButton.set(button, n);
  if (n > 0) return;
  // a moment's grace: an action often starts its next request right after the first one (save the files, then the record)
  setTimeout(() => {
    if ((perButton.get(button) || 0) > 0) return;
    button.classList.remove('is-busy'); button.removeAttribute('aria-busy');
    if (click?.button === button) click = null;
  }, 150);
}

/** Follow one piece of work. `write`: it changes something (shown even when no button started it). */
export function track(work, { write = false } = {}) {
  const fresh = click && Date.now() - click.at < 400;
  const button = click && (fresh || (perButton.get(click.button) || 0) > 0) && click.button.isConnected ? click.button : null;
  const visible = write || !!button;
  if (button) claim(button);
  if (visible) { shown += 1; emit(); }
  return Promise.resolve(work).finally(() => {
    if (button) release(button);
    if (visible) { shown -= 1; emit(); }
  });
}

/** A message for the person (the app's toast): kind 'error' | 'network' | 'denied'. */
export function tell(message, kind = 'error') {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message, kind } }));
}

let installed = false;
/** Once, at start-up: remember clicks on buttons, and catch failures nobody handled. */
export function installActivity() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('button, [role=button], a.btn');
    if (b) click = { button: b, at: Date.now() };
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const err = e.reason;
    if (!err || err.name === 'AbortError') return;
    const msg = String(err.message || err);
    const kind = err.name === 'NetworkError' || err.name === 'TimeoutError' ? 'network' : err.name === 'AuthzError' ? 'denied' : 'error';
    tell(kind === 'error' ? `That did not work: ${msg}` : msg, kind);
  });
}
