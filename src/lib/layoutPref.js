// How dense the screens are on a phone, chosen by each person (profile menu → Layout):
//   compact      (the default) rows instead of cards, a label beside each value in forms - the most on one screen
//   comfortable  cards, larger spacing - the layout from before
// Kept in this browser, per person. It only changes phone-sized screens: the class on <html> is read by CSS under max-width: 900px.
const KEY = 'communityos:layout';
const keyFor = (who) => (who ? `${KEY}:${who}` : KEY);

export function getLayout(who) {
  try { return localStorage.getItem(keyFor(who)) || localStorage.getItem(KEY) || 'compact'; } catch { return 'compact'; }
}

export function applyLayout(v) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('compact', v === 'compact');
  root.classList.toggle('comfortable', v !== 'compact');
}

export function setLayout(v, who) {
  try { localStorage.setItem(keyFor(who), v); localStorage.setItem(KEY, v); } catch { /* private window: this visit only */ }
  applyLayout(v);
}
