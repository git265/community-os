// A small circuit breaker with a timeout, for calls to an outside service (the payment provider).
// closed -> (N failures in a row) -> open: calls fail at once for `resetMs` -> half-open: ONE trial call; success closes it, failure re-opens it.
// Why: a slow provider must not tie up every request slot waiting for it.
export class CircuitOpenError extends Error { constructor(name) { super(`${name} is not responding; try again in a moment.`); this.status = 503; this.code = 'circuit-open'; } }
export function createBreaker({ name = 'service', timeoutMs = 8000, failureThreshold = 5, resetMs = 30000, now = Date.now } = {}) {
  let state = 'closed', failures = 0, openedAt = 0, trial = false;
  const timeLimit = (p) => new Promise((ok, no) => { const t = setTimeout(() => no(Object.assign(new Error(`${name} took longer than ${timeoutMs} ms.`), { status: 504, code: 'timeout' })), timeoutMs); p.then((v) => { clearTimeout(t); ok(v); }, (e) => { clearTimeout(t); no(e); }); });
  async function call(fn) {
    if (state === 'open') { if (now() - openedAt < resetMs) throw new CircuitOpenError(name); state = 'half-open'; trial = false; }
    if (state === 'half-open') { if (trial) throw new CircuitOpenError(name); trial = true; }
    try { const v = await timeLimit(Promise.resolve().then(fn)); failures = 0; state = 'closed'; return v; }
    catch (e) { failures++; if (state === 'half-open' || failures >= failureThreshold) { state = 'open'; openedAt = now(); } throw e; }
  }
  return { call, state: () => state, failures: () => failures };
}
