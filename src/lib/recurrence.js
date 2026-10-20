// Repeating cultural events (e.g. Ganapati Abhishekam every Saturday). The event row stores the FIRST date plus a rule; the dates are worked out on demand.
export const REPEATS = ['Does not repeat', 'Weekly', 'Every 2 weeks', 'Monthly (same date)'];
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const isRepeating = (ev) => !!ev && !!ev.repeat && ev.repeat !== 'Does not repeat';
export function occurrences(ev, { from = iso(new Date()), count = 4 } = {}) {
  if (!ev?.startDate) return [];
  if (!isRepeating(ev)) return ev.startDate >= from ? [ev.startDate] : [];
  const out = []; const until = ev.repeatUntil || '';
  const step = (d, k) => { const n = new Date(d); if (ev.repeat === 'Weekly') n.setDate(d.getDate() + 7 * k); else if (ev.repeat === 'Every 2 weeks') n.setDate(d.getDate() + 14 * k); else n.setMonth(d.getMonth() + k); return n; };
  const first = parse(ev.startDate);
  for (let k = 0; k < 600 && out.length < count; k += 1) {
    const s = iso(step(first, k));
    if (until && s > until) break;
    if (s >= from) out.push(s);
  }
  return out;
}
export function repeatLabel(ev) {
  if (!isRepeating(ev)) return '';
  const wd = parse(ev.startDate).toLocaleDateString('en-GB', { weekday: 'long' });
  const time = ev.startTime ? ` at ${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ''}` : '';
  const dn = parse(ev.startDate).getDate(); const ord = (dn % 100 >= 11 && dn % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[dn % 10] || 'th');
  const base = ev.repeat === 'Weekly' ? `Every ${wd}` : ev.repeat === 'Every 2 weeks' ? `Every other ${wd}` : `Monthly on the ${dn}${ord}`;
  return `🔁 ${base}${time}${ev.repeatUntil ? ` until ${ev.repeatUntil}` : ''}`;
}
