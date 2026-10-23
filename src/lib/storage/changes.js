// One way to tell every open screen that a collection changed: `communityos:changed` with { collection }.
// Lists (useCollection, ServerTable and the screens that load their own data) reload when it names their collection, so a
// change made in a pop-up shows in the table behind it at once, not only after moving to another page and back.
//
// The same write is often announced twice in a few milliseconds (the store's own write, then the rule book after its
// follow-up steps), and a loop of writes (a bill run, one row at a time) announces many times. Announcements are therefore
// gathered for a moment and sent once per collection: 30 ms after the last one, and never later than 250 ms after the first.
const QUIET_MS = 30;
const MAX_MS = 250;
const pending = new Set();
let timer = null;
let firstAt = 0;

function flush() {
  timer = null; firstAt = 0;
  const list = [...pending]; pending.clear();
  for (const collection of list) window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection } }));
}

/** Say that these collections changed (any number of names; empty ones are ignored). */
export function announceChange(...collections) {
  if (typeof window === 'undefined') return;
  for (const c of collections) if (c) pending.add(c);
  if (!pending.size) return;
  const now = Date.now();
  if (!firstAt) firstAt = now;
  clearTimeout(timer);
  timer = setTimeout(flush, Math.max(0, Math.min(QUIET_MS, firstAt + MAX_MS - now)));
}
