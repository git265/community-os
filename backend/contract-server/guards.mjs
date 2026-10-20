// Request guards: card data must never reach this server (PCI-DSS), secrets must never reach the audit trail, and clients are rate limited.

// ---- 1. no raw card data -----------------------------------------------------------------------------------------------------------
// Card numbers and security codes are typed into the payment provider's own page (hosted checkout / fields), never into this app.
const CARD_KEYS = /^(cvv2?|cvc2?|cid|cardnumber|card_number|cardno|pan|ccnumber|securitycode)$/i;
const luhn = (d) => { let s = 0, alt = false; for (let i = d.length - 1; i >= 0; i--) { let n = d.charCodeAt(i) - 48; if (alt) { n *= 2; if (n > 9) n -= 9; } s += n; alt = !alt; } return s % 10 === 0; };
export function findCardData(v, depth = 0) {
  if (depth > 8 || v == null) return null;
  if (typeof v === 'string') { const m = v.replace(/[ -]/g, ''); return /^\d{13,19}$/.test(m) && luhn(m) ? 'a card number' : null; }
  if (Array.isArray(v)) { for (const x of v) { const r = findCardData(x, depth + 1); if (r) return r; } return null; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) { if (CARD_KEYS.test(k) && x !== '' && x != null && k.toLowerCase() !== 'pan') return `a field named "${k}"`; const r = findCardData(x, depth + 1); if (r) return r; } }
  return null;
}

// ---- 2. never log secrets -------------------------------------------------------------------------------------------------------------
export const SENSITIVE_FIELD = /(pass(word)?|pwd|secret|token|otp|pin|cvv|cvc|card|aadhaar|ssn|account(number|no)|bankaccount|pan(number)?|authorization|signature)/i;
export const redactChanges = (changes = [], extra = new Set()) => changes.map((c) => (SENSITIVE_FIELD.test(String(c.field || c.label || '')) || extra.has(c.field) ? { ...c, from: c.from === '' || c.from == null ? c.from : '[hidden]', to: c.to === '' || c.to == null ? c.to : '[hidden]' } : c));

// ---- 3. rate limiting (token bucket) --------------------------------------------------------------------------------------------------
// In memory, per server process. With several server instances put the same rule in the gateway (Bucket4j/Redis, nginx limit_req, Cloudflare) - the
// signed-in-user and sign-in limits stored in PostgreSQL (auth_attempts) already hold across instances.
export function createLimiter({ now = Date.now } = {}) {
  const buckets = new Map();
  function take(key, perMinute, cost = 1) {
    const t = now(); const cap = perMinute; let b = buckets.get(key);
    if (!b) { b = { tokens: cap, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(cap, b.tokens + ((t - b.at) / 60000) * perMinute); b.at = t;
    if (b.tokens >= cost) { b.tokens -= cost; return { ok: true, remaining: Math.floor(b.tokens) }; }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((cost - b.tokens) / perMinute) * 60)) };
  }
  const sweep = setInterval(() => { const t = now(); for (const [k, b] of buckets) if (t - b.at > 10 * 60000) buckets.delete(k); }, 60000); sweep.unref?.();
  return { take, size: () => buckets.size };
}
export const clientIp = (req, trustProxy) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '';

// ---- 4. transport headers ------------------------------------------------------------------------------------------------------------
// TLS 1.2+/1.3 is terminated by the reverse proxy / load balancer; this server insists the request really came through it in production.
export function securityHeaders(res, { https }) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
