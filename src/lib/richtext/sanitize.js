// Allow-list HTML sanitizer for rich-text comments. Runs on the way IN (before
// saving) and on the way OUT (before rendering) - the backend must repeat the
// same allow-list (e.g. OWASP Java HTML Sanitizer) because the browser is not
// a trust boundary.
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'A', 'BLOCKQUOTE', 'CODE', 'SPAN', 'IMG']);
const SAFE_URL = /^(https?:|mailto:|tel:)/i;
// inline pictures are embedded as small data: images only (a backend would store them as files and keep a URL)
const SAFE_IMG = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;
const MAX_IMG = 700 * 1024;

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const looksLikeHtml = (s) => /<\/?[a-z][\s\S]*?>/i.test(s || '');

function clean(node, doc) {
  const out = doc.createDocumentFragment();
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { out.appendChild(doc.createTextNode(child.nodeValue)); return; }
    if (child.nodeType !== 1) return;
    if (!ALLOWED.has(child.tagName)) {
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'].includes(child.tagName.toUpperCase())) return; // drop entirely
      out.appendChild(clean(child, doc)); // unwrap unknown tag, keep its (cleaned) text
      return;
    }
    if (child.tagName === 'IMG') {
      const src = (child.getAttribute('src') || '').trim();
      if (!SAFE_IMG.test(src) || src.length > MAX_IMG) return;
      const im = doc.createElement('img'); im.setAttribute('src', src); im.setAttribute('alt', (child.getAttribute('alt') || 'picture').slice(0, 80)); out.appendChild(im); return;
    }
    const el = doc.createElement(child.tagName.toLowerCase());
    if (child.tagName === 'A') {
      const href = child.getAttribute('href') || '';
      if (SAFE_URL.test(href.trim())) {
        el.setAttribute('href', href.trim());
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer nofollow');
      }
    }
    el.appendChild(clean(child, doc));
    out.appendChild(el);
  });
  return out;
}

/** Returns safe HTML. Plain text (legacy comments) is escaped and keeps its line breaks. */
export function sanitizeHtml(input) {
  const raw = input ?? '';
  if (!looksLikeHtml(raw)) return escapeHtml(raw).replace(/\n/g, '<br>');
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
  const holder = doc.createElement('div');
  holder.appendChild(clean(doc.body, doc));
  return holder.innerHTML;
}

export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(`<body>${html ?? ''}</body>`, 'text/html');
  return (doc.body.textContent || '').replace(/ /g, ' ').trim();
}
export const isEmptyHtml = (html) => htmlToText(html) === '' && !/<img\s/i.test(html || '');

/** Turn bare web addresses in plain text into links (used when pasting). */
export function linkify(text) {
  return escapeHtml(text || '').replace(/\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?)\]'"])/gi, (u) => `<a href="${u.startsWith('http') ? u : `https://${u}`}">${u}</a>`).replace(/\n/g, '<br>');
}
