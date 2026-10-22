// Allow-list HTML sanitizer for rich-text comments. Runs on the way IN (before
// saving) and on the way OUT (before rendering) - the backend must repeat the
// same allow-list (e.g. OWASP Java HTML Sanitizer) because the browser is not
// a trust boundary.
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'BR', 'P', 'DIV', 'A', 'BLOCKQUOTE', 'CODE', 'SPAN', 'IMG']);
const SAFE_URL = /^(https?:|mailto:|tel:)/i;
// inline pictures are embedded as small data: images only (a backend would store them as files and keep a URL)
const SAFE_IMG = /^data:image\/(png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;
const MAX_IMG = 700 * 1024;
// Previews of uploaded Word / Excel files (mammoth, SheetJS) also keep headings and tables.
const DOC_EXTRA = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'COLGROUP', 'COL', 'CAPTION', 'SUP', 'SUB'];
const DOC_ALLOWED = new Set([...ALLOWED, ...DOC_EXTRA]);
const SPAN_ATTRS = ['colspan', 'rowspan', 'span'];

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const looksLikeHtml = (s) => /<\/?[a-z][\s\S]*?>/i.test(s || '');

function clean(node, doc, opts = { allowed: ALLOWED, maxImg: MAX_IMG }) {
  const out = doc.createDocumentFragment();
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) { out.appendChild(doc.createTextNode(child.nodeValue)); return; }
    if (child.nodeType !== 1) return;
    if (!opts.allowed.has(child.tagName)) {
      if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH'].includes(child.tagName.toUpperCase())) return; // drop entirely
      out.appendChild(clean(child, doc, opts)); // unwrap unknown tag, keep its (cleaned) text
      return;
    }
    if (child.tagName === 'IMG') {
      const src = (child.getAttribute('src') || '').trim();
      if (!SAFE_IMG.test(src) || src.length > opts.maxImg) return;
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
    if (opts.allowed === DOC_ALLOWED) {
      SPAN_ATTRS.forEach((a) => { const v = child.getAttribute(a); if (v && /^\d{1,3}$/.test(v.trim())) el.setAttribute(a, v.trim()); });
    }
    el.appendChild(clean(child, doc, opts));
    out.appendChild(el);
  });
  return out;
}

/**
 * Returns safe HTML. Plain text (legacy comments) is escaped and keeps its line breaks.
 * `{ document: true }` also keeps headings and tables (colspan / rowspan only) for file previews.
 * Event handlers, styles, scripts and javascript: links are always stripped.
 */
export function sanitizeHtml(input, { document: asDoc = false } = {}) {
  const raw = input ?? '';
  if (!looksLikeHtml(raw)) return escapeHtml(raw).replace(/\n/g, '<br>');
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
  const holder = doc.createElement('div');
  holder.appendChild(clean(doc.body, doc, asDoc ? { allowed: DOC_ALLOWED, maxImg: 8 * 1024 * 1024 } : { allowed: ALLOWED, maxImg: MAX_IMG }));
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
