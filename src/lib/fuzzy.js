// Small fuzzy matcher used to stop duplicate records (e.g. the same vendor typed two ways).
// "Sri Ganesh Electricals", "Shri Ganesh Electrical" and "ganesh electricals pvt ltd" all land close together.
const NOISE = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'the', 'and', 'services', 'service', 'solutions', 'enterprises', 'enterprise', 'traders', 'agency', 'sri', 'shri', 'sree', 'm', 's', 'ms']);

export const normalize = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
// "electricals" ~ "electrical": trim a trailing plural s
const stem = (w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w);
const tokens = (s) => normalize(s).split(' ').map(stem).filter((w) => w && !NOISE.has(w));

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const ratio = (a, b) => (a || b ? 1 - levenshtein(a, b) / Math.max(a.length, b.length) : 1);

/** 0..1 similarity between two names. */
export function similarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = tokens(a), tb = tokens(b);
  const whole = ratio(ta.join(' '), tb.join(' '));
  // every word of the shorter name has a close match in the longer one (typos / dropped words)
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const cover = small.length ? small.reduce((s, w) => s + Math.max(0, ...big.map((x) => ratio(w, x))), 0) / small.length : 0;
  const shrink = small.length === big.length ? 1 : 0.9;
  return Math.max(whole, cover * shrink);
}

/** Existing records whose `key` looks like `text`. Best first. */
export function findSimilar(text, records, { key = 'name', exclude = '', min = 0.74 } = {}) {
  if (normalize(text).length < 3) return [];
  return records
    .filter((r) => r.id !== exclude && r[key])
    .map((r) => ({ record: r, score: similarity(text, r[key]) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}
export const isSameName = (a, b) => normalize(a) === normalize(b) || tokens(a).join(' ') === tokens(b).join(' ');
