// Fills {{TOKEN}} placeholders of a Notice Template. Values passed in win; otherwise the
// Merge Field Library default is used; unknown tokens are left visible so mistakes are obvious.
export function renderNotice(body, values = {}, mergeFields = []) {
  return String(body || '').replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (m, key) => {
    if (values[key] !== undefined && values[key] !== '') return String(values[key]);
    const def = mergeFields.find((f) => f.token === `{{${key}}}`)?.defaultValue;
    return def ? def : m;
  });
}

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-10' -> 'Oct 2026' */
export function monthLabel(ym) {
  const [y, m] = String(ym || '').split('-');
  return y && m ? `${MONTH_NAMES[Number(m) - 1]} ${y}` : ym || '';
}
/** The current month and the previous `back` months as 'YYYY-MM'. */
export function recentMonths(back = 12) {
  const out = [];
  const d = new Date();
  for (let i = 0; i <= back; i++) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
export const todayIso = () => new Date().toISOString().slice(0, 10);
