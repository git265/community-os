import React, { useCallback, useEffect, useRef, useState } from 'react';
import { sanitizeHtml, linkify, isEmptyHtml } from '../lib/richtext/sanitize.js';
import { shrinkImage } from '../lib/files/attachments.js';

const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

/* Icons: 20px strokes that read the same on every platform (emoji and letter glyphs did not). */
const I = {
  bold: <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />,
  italic: <path d="M14 5h-4M14 19h-4M14.5 5 9.5 19" />,
  underline: <path d="M7 5v6a5 5 0 0 0 10 0V5M5 20h14" />,
  strike: <path d="M5 12h14M16.5 7.5C16 6 14.4 5 12 5c-2.8 0-4.5 1.3-4.5 3.2 0 4.3 9 2.6 9 7.4 0 2-1.8 3.4-4.5 3.4-2.6 0-4.3-1.1-4.8-2.8" />,
  ul: <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />,
  ol: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1V9M3.6 14.2A1.3 1.3 0 0 1 6 15c0 1-2.4 2-2.4 3H6" />,
  quote: <path d="M5 11h4v6H5zM5 11c0-3 1.5-5 4-5.5M14 11h4v6h-4zM14 11c0-3 1.5-5 4-5.5" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  image: <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="m4 17 5-5 4 4 2.5-2.5L20 17" /><circle cx="15.5" cy="9.5" r="1.3" /></>,
  clear: <path d="M6 5h12M12 5 9 19M4 20 20 4" />,
};
const Icon = ({ name }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[name]}</svg>
);

const GROUPS = [
  [{ cmd: 'bold', icon: 'bold', title: 'Bold', keys: 'B' }, { cmd: 'italic', icon: 'italic', title: 'Italic', keys: 'I' }, { cmd: 'underline', icon: 'underline', title: 'Underline', keys: 'U' }, { cmd: 'strikeThrough', icon: 'strike', title: 'Strikethrough' }],
  [{ cmd: 'insertUnorderedList', icon: 'ul', title: 'Bullet list' }, { cmd: 'insertOrderedList', icon: 'ol', title: 'Numbered list' }, { cmd: 'quote', icon: 'quote', title: 'Quote' }],
];
/** The cursor as a count of characters from the start of the box, and back: survives the browser rebuilding the line into a list. */
function caretAt(root) {
  const sel = document.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = document.createRange(); r.selectNodeContents(root); r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
function placeCaret(root, n) {
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let left = n; let t = walk.nextNode(); let lastText = null;
  while (t) { if (left <= t.length) { document.getSelection().collapse(t, left); return; } left -= t.length; lastText = t; t = walk.nextNode(); }
  if (lastText) document.getSelection().collapse(lastText, lastText.length);
}
const STATEFUL = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'];
const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
const keyHint = (k) => (k ? ` (${mac ? '⌘' : 'Ctrl+'}${k})` : '');

/**
 * The rich-text box used for every comment, description and note: bold / italic / underline / strikethrough, lists, quote, link,
 * pictures (unless images={false}) and "clear formatting". The value is sanitized HTML; pasted text is flattened (links kept).
 * Built for touch as much as for a mouse: one toolbar row that scrolls sideways on a phone, 40 px targets, the buttons show which
 * formats are on where the cursor is, and links are added in the toolbar itself (no browser pop-up, which phones handle badly).
 */
export default function RichTextEditor({ value, onChange, placeholder = 'Write a comment…', minHeight = 72, id, images = true }) {
  const ref = useRef(null);
  const last = useRef('');
  const saved = useRef(null);       // the selection, kept while the link box has the focus
  const fileRef = useRef(null);
  const linkRef = useRef(null);
  const [active, setActive] = useState({});
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [empty, setEmpty] = useState(() => isEmptyHtml(value || ''));

  // Only touch the DOM when the value changed from outside (e.g. cleared after posting).
  useEffect(() => {
    const el = ref.current;
    if (el && (value || '') !== last.current) { el.innerHTML = value ? sanitizeHtml(value) : ''; last.current = value || ''; setEmpty(isEmptyHtml(value || '')); }
  }, [value]);

  const emit = useCallback(() => {
    const clean = sanitizeHtml(ref.current.innerHTML);
    last.current = clean; setEmpty(isEmptyHtml(clean)); onChange(clean);
  }, [onChange]);

  // which formats are on at the cursor (only while the cursor is in this box)
  const refresh = useCallback(() => {
    const sel = typeof document !== 'undefined' ? document.getSelection() : null;
    if (!ref.current || !sel || !sel.anchorNode || !ref.current.contains(sel.anchorNode)) return;
    const next = {};
    for (const c of STATEFUL) { try { next[c] = document.queryCommandState(c); } catch { next[c] = false; } }
    let n = sel.anchorNode; next.quote = false; next.link = false;
    while (n && n !== ref.current) { if (n.nodeName === 'BLOCKQUOTE') next.quote = true; if (n.nodeName === 'A') next.link = true; n = n.parentNode; }
    setActive((a) => (Object.keys(next).some((k) => a[k] !== next[k]) ? next : a));
  }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', refresh);
    return () => document.removeEventListener('selectionchange', refresh);
  }, [refresh]);

  function run(cmd) {
    if (document.activeElement !== ref.current) ref.current.focus();   // focusing it again would put the cursor back at the start
    // the browser may move the cursor to the start of the line (Chromium does for lists): put it back where it was
    const sel = document.getSelection();
    const at = sel && sel.rangeCount && ref.current.contains(sel.anchorNode) && sel.isCollapsed ? caretAt(ref.current) : null;
    if (cmd === 'quote') document.execCommand('formatBlock', false, active.quote ? '<p>' : '<blockquote>');
    else if (cmd === 'clear') { document.execCommand('removeFormat', false, null); document.execCommand('unlink', false, null); if (active.quote) document.execCommand('formatBlock', false, '<p>'); }
    else document.execCommand(cmd, false, null);
    if (at != null && ['insertUnorderedList', 'insertOrderedList', 'quote'].includes(cmd) && caretAt(ref.current) !== at) placeCaret(ref.current, at);
    emit(); refresh();
  }

  function openLink() {
    const sel = document.getSelection();
    saved.current = sel && sel.rangeCount && ref.current.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    if (active.link) { ref.current.focus(); document.execCommand('unlink', false, null); emit(); refresh(); return; }   // on a link: the button takes it off
    setUrl(''); setLinkOpen(true);
    setTimeout(() => linkRef.current?.focus(), 0);
  }
  function addLink(e) {
    e?.preventDefault();
    const raw = url.trim();
    setLinkOpen(false);
    if (!raw) return;
    const href = /^(https?:|mailto:|tel:)/i.test(raw) ? raw : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`;
    ref.current.focus();
    const sel = document.getSelection();
    if (saved.current) { sel.removeAllRanges(); sel.addRange(saved.current); }
    if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${href.replace(/"/g, '&quot;')}">${raw.replace(/[<>&"]/g, '')}</a>&nbsp;`);
    else document.execCommand('createLink', false, href);
    emit(); refresh();
  }

  async function addImages(files) {
    for (const f of [...files].filter((x) => /^image\//.test(x.type))) {
      try {
        const small = await shrinkImage(f, 900, 0.7);
        const src = await toDataUrl(small);
        ref.current.focus();
        document.execCommand('insertHTML', false, `<img src="${src}" alt="${(f.name || 'picture').replace(/[^\w .-]/g, '')}"><br>`);
      } catch { /* ignore a bad file */ }
    }
    emit();
  }
  function onPaste(e) {
    const cd = e.clipboardData;
    if (cd.files && cd.files.length && [...cd.files].some((f) => /^image\//.test(f.type))) { e.preventDefault(); if (images) addImages(cd.files); return; }
    e.preventDefault();
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    // copied text that carries links keeps them (cleaned by the allow-list); plain addresses become links
    if (html && /<a\s[^>]*href/i.test(html)) document.execCommand('insertHTML', false, sanitizeHtml(html));
    else document.execCommand('insertHTML', false, linkify(text));
    emit();
  }
  function onDrop(e) {
    if (e.dataTransfer?.files?.length && [...e.dataTransfer.files].some((f) => /^image\//.test(f.type))) { e.preventDefault(); if (images) addImages(e.dataTransfer.files); }
  }
  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openLink(); }
  }
  // a toolbar press must not take the focus (and the selection) away from the text
  const keep = (e) => e.preventDefault();
  const Btn = ({ cmd, icon, title, keys, on, onClick, testid }) => (
    <button type="button" className={`rte-btn${on ? ' on' : ''}`} title={title + keyHint(keys)} aria-label={title} aria-pressed={on === undefined ? undefined : !!on}
      data-testid={testid} onMouseDown={keep} onClick={onClick || (() => run(cmd))}><Icon name={icon} /></button>
  );

  return (
    <div className="rte rte-x">
      <div className="rte-bar" role="toolbar" aria-label="Formatting">
        {GROUPS.map((g, gi) => (
          <div className="rte-group" key={gi}>
            {g.map((b) => <Btn key={b.cmd} {...b} testid={`rte-${b.icon}`} on={!!active[b.cmd]} />)}
          </div>
        ))}
        <div className="rte-group">
          <Btn icon="link" title={active.link ? 'Remove link' : 'Add link'} keys="K" on={!!active.link || linkOpen} onClick={openLink} testid="rte-link" />
          {images && <Btn icon="image" title="Insert a picture" onClick={() => fileRef.current?.click()} testid="rte-image" />}
          <Btn icon="clear" title="Clear formatting" onClick={() => run('clear')} testid="rte-clear" />
        </div>
        {images && <input ref={fileRef} type="file" accept="image/*" multiple hidden data-testid="rte-image-input" onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />}
      </div>
      {linkOpen && (
        <div className="rte-linkbar" role="group" aria-label="Add a link" data-testid="rte-linkbar">
          <input ref={linkRef} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="Paste or type a link (https://…)" aria-label="Link address"
            value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addLink(e); if (e.key === 'Escape') { e.preventDefault(); setLinkOpen(false); ref.current?.focus(); } }} />
          <button type="button" className="btn sm" data-testid="rte-link-add" disabled={!url.trim()} onClick={addLink}>Add</button>
          <button type="button" className="btn secondary sm" onClick={() => { setLinkOpen(false); ref.current?.focus(); }}>Cancel</button>
        </div>
      )}
      <div
        id={id}
        ref={ref}
        className={`rte-body${empty ? ' is-empty' : ''}`}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        style={{ minHeight }}
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        onKeyUp={refresh}
        onMouseUp={refresh}
        suppressContentEditableWarning
      />
    </div>
  );
}
