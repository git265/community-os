// Portal-wide safety net for form errors: forms that still show ONE error banner for the whole form get that message moved to
// the input it is about (highlighted, with the message under it) when the message clearly names a field. If it can't tell which
// field, the banner stays where it was. The message clears as soon as the person edits that field.
const BANNER = '.notice.error, .field-error, .form-error';
const STOP = new Set(['enter', 'select', 'choose', 'please', 'the', 'and', 'for', 'with', 'can', 'are', 'you', 'your', 'this', 'that', 'must', 'need', 'first', 'before', 'from', 'has', 'have', 'not', 'only', 'into', 'than', 'least', 'valid', 'required', 'cannot', 'could', 'was', 'were', 'will', 'its']);
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const tracked = new Set();

function clear(t) { t.clone.remove(); t.field.classList.remove('invalid'); t.field.removeAttribute('data-inl'); if (t.banner.isConnected) t.banner.style.display = ''; tracked.delete(t); }

function scan() {
  for (const t of [...tracked]) if (!t.banner.isConnected || t.banner.textContent.trim() !== t.msg || !t.field.isConnected) clear(t);
  for (const banner of document.querySelectorAll(BANNER)) {
    if (banner.closest('.field') || banner.querySelector('input, button, select, textarea, a[href]') || banner.style.display === 'none' || [...tracked].some((t) => t.banner === banner)) continue;
    const msg = banner.textContent.trim(); if (!msg) continue;
    const scope = banner.closest('.modal-card, form, .card') || document.body;
    const mw = new Set(words(msg));
    const scored = [...scope.querySelectorAll('.field')].filter((f) => f.querySelector('input:not([type=hidden]), select, textarea') && !f.hasAttribute('data-inl')).map((f) => {
      const lab = f.querySelector('label')?.textContent || '';
      return { f, s: words(lab).filter((w) => mw.has(w)).length };
    }).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (!best || best.s < 1 || (best.s < 2 && scored[1] && scored[1].s === best.s)) continue;
    const clone = document.createElement('div'); clone.className = 'field-error inl'; clone.setAttribute('role', 'alert'); clone.textContent = msg;
    best.f.appendChild(clone); best.f.classList.add('invalid'); best.f.setAttribute('data-inl', '1'); banner.style.display = 'none';
    tracked.add({ banner, clone, field: best.f, msg });
    const input = best.f.querySelector('input:not([type=hidden]), select, textarea'); try { input?.focus({ preventScroll: true }); input?.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* ignore */ }
  }
}

export function startInlineErrors() {
  let raf = 0;
  const mo = new MutationObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(scan); });
  mo.observe(document.body, { childList: true, subtree: true, characterData: true });
  const onEdit = (e) => { const f = e.target.closest?.('.field[data-inl]'); if (!f) return; for (const t of [...tracked]) if (t.field === f) clear(t); };
  document.addEventListener('input', onEdit, true); document.addEventListener('change', onEdit, true);
  return () => { mo.disconnect(); document.removeEventListener('input', onEdit, true); document.removeEventListener('change', onEdit, true); };
}
