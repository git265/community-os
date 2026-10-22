import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { sanitizeHtml, linkify, isEmptyHtml } from '../lib/richtext/sanitize.js';
import { shrinkImage } from '../lib/files/attachments.js';

const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
const ZW = '​';   // a zero-width space: where the cursor waits after a word made bold, so the next letters are plain again (never saved)
const touch = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; } };

/* Icons: 18px strokes that read the same on every platform. */
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
/** The menu over a selection, as WhatsApp shows it (with the markers that do the same while typing). */
const MENU = [
  { cmd: 'bold', icon: 'bold', title: 'Bold', hint: '*text*' }, { cmd: 'italic', icon: 'italic', title: 'Italic', hint: '_text_' },
  { cmd: 'strikeThrough', icon: 'strike', title: 'Strikethrough', hint: '~text~' }, { cmd: 'underline', icon: 'underline', title: 'Underline' }, { sep: true },
  { cmd: 'insertUnorderedList', icon: 'ul', title: 'Bullet list', hint: '- at the start of a line' }, { cmd: 'insertOrderedList', icon: 'ol', title: 'Numbered list', hint: '1. at the start of a line' },
  { cmd: 'quote', icon: 'quote', title: 'Quote', hint: '> at the start of a line' }, { cmd: 'link', icon: 'link', title: 'Link' }, { cmd: 'clear', icon: 'clear', title: 'Clear formatting' },
];
const STATEFUL = ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'];
const MARK = { '*': 'b', _: 'i', '~': 's' };   // WhatsApp's markers
const markRe = (ch) => { const q = `\\${ch}`; return new RegExp(`(^|[\\s(\\u00a0\\u200B])${q}([^\\s${q}](?:[^${q}\\n]*[^\\s${q}])?)${q}$`); };
const MARK_RE = Object.fromEntries(Object.keys(MARK).map((c) => [c, markRe(c)]));

/** The cursor as a count of characters from the start of the box, and back: survives the browser rebuilding a line into a list. */
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
/** The current line up to the cursor (for "- ", "1. ", "> " at the start of a line): null when it cannot be told. */
function lineBefore(root) {
  const sel = document.getSelection();
  if (!sel?.rangeCount) return null;
  let block = sel.anchorNode;
  while (block && block !== root && !/^(P|DIV|LI|BLOCKQUOTE)$/.test(block.nodeName)) block = block.parentNode;
  if (!block) return null;
  const r = document.createRange(); r.selectNodeContents(block); r.setEnd(sel.anchorNode, sel.anchorOffset);
  // the text since the last line break (Shift+Enter puts a <br>; a new line can also be a block)
  let text = '';
  const walk = document.createTreeWalker(r.cloneContents(), NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === 3) text += n.data; else if (/^(BR|DIV|P|LI|BLOCKQUOTE|UL|OL)$/.test(n.nodeName)) text = '';
  }
  return { text, block };
}

/**
 * The rich-text box used for every message, comment, description and note - it behaves like WhatsApp's:
 *   - a clean box that grows as you type (no toolbar); a picture button inside it unless images={false}
 *   - select text and a small menu appears over it: bold, italic, strikethrough, underline, lists, quote, link, clear
 *   - WhatsApp's own markers work as you type: *bold*  _italic_  ~strikethrough~, and "- " / "1. " / "> " at the start of a line
 *   - onEnter (chat boxes): Enter sends on a computer, Shift+Enter is a new line; on a phone Enter is a new line, as in WhatsApp
 * The value is sanitized HTML; pasted text is flattened (links kept).
 */
export default function RichTextEditor({ value, onChange, placeholder = 'Write a comment…', minHeight = 72, maxHeight = 320, id, images = true, onEnter }) {
  const ref = useRef(null);
  const last = useRef('');
  const saved = useRef(null);       // the selection, kept while the link box has the focus
  const fileRef = useRef(null);
  const linkRef = useRef(null);
  const linkOpenRef = useRef(false);
  const [active, setActive] = useState({});
  const [menu, setMenu] = useState(null);       // { top, left, below } of the selection menu, or null
  const [linkOpen, setLinkOpenState] = useState(false);
  const setLinkOpen = (v) => { linkOpenRef.current = v; setLinkOpenState(v); };
  const [url, setUrl] = useState('');
  const [empty, setEmpty] = useState(() => isEmptyHtml(value || ''));

  // Only touch the DOM when the value changed from outside (e.g. cleared after posting).
  useEffect(() => {
    const el = ref.current;
    if (el && (value || '') !== last.current) { el.innerHTML = value ? sanitizeHtml(value) : ''; last.current = value || ''; setEmpty(isEmptyHtml(value || '')); }
  }, [value]);

  const emit = useCallback(() => {
    const clean = sanitizeHtml(ref.current.innerHTML.split(ZW).join(''));
    last.current = clean; setEmpty(isEmptyHtml(clean)); onChange(clean);
    return clean;
  }, [onChange]);

  // the selection menu and which formats are on - only while the selection is in this box
  const refresh = useCallback(() => {
    if (linkOpenRef.current) return;   // typing a link: the menu stays where it is
    const sel = typeof document !== 'undefined' ? document.getSelection() : null;
    const inside = ref.current && sel && sel.rangeCount && ref.current.contains(sel.anchorNode) && ref.current.contains(sel.focusNode);
    if (!inside) { setMenu(null); return; }
    const next = {};
    for (const c of STATEFUL) { try { next[c] = document.queryCommandState(c); } catch { next[c] = false; } }
    let n = sel.anchorNode; next.quote = false; next.link = false;
    while (n && n !== ref.current) { if (n.nodeName === 'BLOCKQUOTE') next.quote = true; if (n.nodeName === 'A') next.link = true; n = n.parentNode; }
    setActive((a) => (Object.keys(next).some((k) => a[k] !== next[k]) ? next : a));
    if (sel.isCollapsed || !sel.toString().replace(new RegExp(ZW, 'g'), '').trim()) { setMenu(null); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return;
    const below = touch() || r.top < 70;   // on a phone the system's copy / paste bubble sits above the selection: ours goes under it
    const half = Math.min((below && touch() ? 36 : 34) * 9 + 22, window.innerWidth - 16) / 2;   // the menu's own half width (it scrolls when the screen is narrower)
    setMenu({ top: below ? r.bottom + 10 : r.top - 10, left: Math.min(Math.max(r.left + r.width / 2, half + 8), window.innerWidth - half - 8), below });
  }, []);
  useEffect(() => {
    document.addEventListener('selectionchange', refresh);
    window.addEventListener('scroll', refresh, true); window.addEventListener('resize', refresh);
    return () => { document.removeEventListener('selectionchange', refresh); window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh); };
  }, [refresh]);

  function run(cmd) {
    if (cmd === 'link') { openLink(); return; }
    if (document.activeElement !== ref.current) ref.current.focus();
    const sel = document.getSelection();
    // the browser may move the cursor to the start of the line (Chromium does for lists): put it back where it was
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
  function closeLink() { setLinkOpen(false); setMenu(null); ref.current?.focus(); }
  function addLink(e) {
    e?.preventDefault();
    const raw = url.trim();
    setLinkOpen(false); setMenu(null);
    if (!raw) return;
    const href = /^(https?:|mailto:|tel:)/i.test(raw) ? raw : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? `mailto:${raw}` : `https://${raw}`;
    ref.current.focus();
    const sel = document.getSelection();
    if (saved.current) { sel.removeAllRanges(); sel.addRange(saved.current); }
    if (sel.isCollapsed) document.execCommand('insertHTML', false, `<a href="${href.replace(/"/g, '&quot;')}">${raw.replace(/[<>&"]/g, '')}</a>&nbsp;`);
    else { document.execCommand('createLink', false, href); sel.collapseToEnd(); }
    emit(); refresh();
  }

  /** WhatsApp's markers, as they are typed: *word* -> bold, _word_ -> italic, ~word~ -> strikethrough; "- " "1. " "> " start a list or a quote. */
  function shortcuts(ie) {
    if (ie?.inputType !== 'insertText' || !ie.data) return;
    const sel = document.getSelection();
    if (!sel?.isCollapsed || sel.anchorNode?.nodeType !== 3) return;
    const node = sel.anchorNode; const end = sel.anchorOffset; const before = node.data.slice(0, end);
    if (ie.data === ' ') {
      const line = lineBefore(ref.current);
      const t = (line?.text || '').replace(/ /g, ' ').split(ZW).join('');
      const cmd = t === '- ' || t === '* ' ? 'insertUnorderedList' : /^1[.)] $/.test(t) ? 'insertOrderedList' : t === '> ' ? 'quote' : null;
      if (!cmd || (line.block.nodeName === 'LI' && cmd !== 'quote')) return;
      const typed = before.replace(/ /g, ' ').split(ZW).join('');
      if (!typed.endsWith(t)) return;
      for (let i = 0; i < before.length - before.lastIndexOf(t[0]); i++) document.execCommand('delete', false, null);   // the browser's own delete keeps the line a line
      run(cmd);
      return;
    }
    if (!MARK[ie.data]) return;
    const m = MARK_RE[ie.data].exec(before);
    if (!m) return;
    const r = document.createRange(); r.setStart(node, end - m[2].length - 2); r.setEnd(node, end);
    r.deleteContents();
    const el = document.createElement(MARK[ie.data]); el.textContent = m[2];
    const after = document.createTextNode(ZW);
    r.insertNode(after); r.insertNode(el);
    sel.collapse(after, 1);
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
    const k = (e.key || '').toLowerCase();
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      if (k === 'k') { e.preventDefault(); openLink(); return; }
      if (e.shiftKey && k === 'x') { e.preventDefault(); run('strikeThrough'); return; }
    }
    // a new line is its own line (not a break inside the one above), so "- " on it makes a list of that line only
    if (e.key === 'Enter' && e.shiftKey && !e.isComposing && !active.insertUnorderedList && !active.insertOrderedList) { e.preventDefault(); document.execCommand('insertParagraph', false, null); emit(); return; }
    // a chat box sends on Enter (computer); Shift+Enter, a phone's Enter, or Enter inside a list is a new line
    if (onEnter && e.key === 'Enter' && !e.shiftKey && !e.isComposing && !touch() && !active.insertUnorderedList && !active.insertOrderedList) {
      e.preventDefault(); onEnter(emit()); return;   // the text as it is now (the parent's state catches up after)
    }
    if (e.key === 'Escape' && menu) setMenu(null);
  }
  // a menu press must not take the focus (and the selection) away from the text
  const keep = (e) => e.preventDefault();

  const pop = menu && typeof document !== 'undefined' && createPortal(
    <div className={`rte-pop${menu.below ? ' below' : ''}`} style={{ top: menu.top, left: menu.left }} role="toolbar" aria-label="Formatting" data-testid="rte-menu" onPointerDown={keep} onMouseDown={keep}>
      {linkOpen ? (
        <div className="rte-pop-link" data-testid="rte-linkbar">
          <input ref={linkRef} type="url" inputMode="url" autoCapitalize="none" autoCorrect="off" placeholder="Paste a link…" aria-label="Link address" value={url}
            onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addLink(e); if (e.key === 'Escape') { e.preventDefault(); closeLink(); } }} />
          <button type="button" className="rte-pop-btn text" data-testid="rte-link-add" disabled={!url.trim()} onClick={addLink}>Add</button>
          <button type="button" className="rte-pop-btn" onClick={closeLink} aria-label="Cancel">✕</button>
        </div>
      ) : MENU.map((b, i) => (b.sep ? <span key={i} className="rte-pop-sep" /> : (
        <button key={b.cmd} type="button" className={`rte-pop-btn${(b.cmd === 'link' ? active.link : b.cmd === 'quote' ? active.quote : active[b.cmd]) ? ' on' : ''}`}
          title={b.hint ? `${b.title} (or type ${b.hint})` : b.title} aria-label={b.title} data-testid={`rte-${b.icon}`} onClick={() => run(b.cmd)}><Icon name={b.icon} /></button>
      )))}
    </div>,
    document.body,
  );

  return (
    <div className={`rte rte-wa${images ? ' has-pic' : ''}`}>
      <div
        id={id}
        ref={ref}
        className={`rte-body${empty ? ' is-empty' : ''}`}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-placeholder={placeholder}
        data-placeholder={placeholder}
        style={{ minHeight, maxHeight }}
        onInput={(e) => { shortcuts(e.nativeEvent); emit(); }}
        onBlur={() => { emit(); setTimeout(() => { if (!linkOpenRef.current && document.activeElement !== ref.current) setMenu(null); }, 150); }}
        onPaste={onPaste}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        onKeyUp={refresh}
        onMouseUp={refresh}
        onTouchEnd={() => setTimeout(refresh, 60)}
        suppressContentEditableWarning
      />
      {images && <button type="button" className="rte-pic" title="Add a picture" aria-label="Add a picture" data-testid="rte-image" onMouseDown={keep} onClick={() => fileRef.current?.click()}><Icon name="image" /></button>}
      {images && <input ref={fileRef} type="file" accept="image/*" multiple hidden data-testid="rte-image-input" onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />}
      {pop}
    </div>
  );
}
