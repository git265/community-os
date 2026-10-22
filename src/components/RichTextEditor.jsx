import React, { useEffect, useRef, useState } from 'react';
import { sanitizeHtml, linkify } from '../lib/richtext/sanitize.js';
import { shrinkImage } from '../lib/files/attachments.js';

const toDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });

const BUTTONS = [
  { cmd: 'bold', label: 'B', title: 'Bold', style: { fontWeight: 800 } },
  { cmd: 'italic', label: 'I', title: 'Italic', style: { fontStyle: 'italic' } },
  { cmd: 'underline', label: 'U', title: 'Underline', style: { textDecoration: 'underline' } },
  { cmd: 'insertUnorderedList', label: '•≡', title: 'Bullet list' },
  { cmd: 'insertOrderedList', label: '1.≡', title: 'Numbered list' },
];

/**
 * Simple rich-text editor (bold / italic / underline / lists / link) used for
 * every comment box in the portal. Value is sanitized HTML; pasted content is
 * flattened to plain text so no foreign markup gets in.
 */
export default function RichTextEditor({ value, onChange, placeholder = 'Write a comment…', minHeight = 72, id }) {
  const ref = useRef(null);
  const last = useRef('');
  const [open, setOpen] = useState(false); // formatting menu is collapsed until the glyph is clicked

  // Only touch the DOM when the value changed from outside (e.g. cleared after posting).
  useEffect(() => {
    const el = ref.current;
    if (el && (value || '') !== last.current) { el.innerHTML = value ? sanitizeHtml(value) : ''; last.current = value || ''; }
  }, [value]);

  const emit = () => { const clean = sanitizeHtml(ref.current.innerHTML); last.current = clean; onChange(clean); };
  function run(cmd) {
    ref.current.focus();
    document.execCommand(cmd, false, null);
    emit();
  }
  function link() {
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    ref.current.focus();
    document.execCommand('createLink', false, /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`);
    emit();
  }
  async function addImages(files) {
    for (const f of [...files].filter((x) => /^image\//.test(x.type))) {
      try {
        const small = await shrinkImage(f, 900, 0.7);
        const url = await toDataUrl(small);
        ref.current.focus();
        document.execCommand('insertHTML', false, `<img src="${url}" alt="${(f.name || 'picture').replace(/[^\w .-]/g, '')}"><br>`);
      } catch { /* ignore a bad file */ }
    }
    emit();
  }
  function onPaste(e) {
    const cd = e.clipboardData;
    if (cd.files && cd.files.length && [...cd.files].some((f) => /^image\//.test(f.type))) { e.preventDefault(); addImages(cd.files); return; }
    e.preventDefault();
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    // copied text that carries links keeps them (cleaned by the allow-list); plain addresses become links
    if (html && /<a\s[^>]*href/i.test(html)) document.execCommand('insertHTML', false, sanitizeHtml(html));
    else document.execCommand('insertHTML', false, linkify(text));
    emit();
  }
  function onDrop(e) {
    if (e.dataTransfer?.files?.length && [...e.dataTransfer.files].some((f) => /^image\//.test(f.type))) { e.preventDefault(); addImages(e.dataTransfer.files); }
  }
  const fileRef = useRef(null);

  return (
    <div className="rte">
      <div className={`rte-bar${open ? ' open' : ''}`} role="toolbar" aria-label="Formatting">
        <button type="button" className="rte-toggle" data-testid="rte-toggle" aria-expanded={open} title={open ? 'Hide formatting' : 'Show formatting'} aria-label={open ? 'Hide formatting' : 'Show formatting'} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>{open ? '✕' : 'Aa'}</button>
        <button type="button" className="rte-img" data-testid="rte-image" title="Insert a picture" aria-label="Insert a picture" onMouseDown={(e) => e.preventDefault()} onClick={() => fileRef.current?.click()}>🖼</button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden data-testid="rte-image-input" onChange={(e) => { addImages(e.target.files); e.target.value = ''; }} />
        {open && BUTTONS.map((b) => (
          <button key={b.cmd} type="button" title={b.title} aria-label={b.title} style={b.style} onMouseDown={(e) => e.preventDefault()} onClick={() => run(b.cmd)}>{b.label}</button>
        ))}
        {open && <button type="button" title="Insert link" aria-label="Insert link" onMouseDown={(e) => e.preventDefault()} onClick={link}>🔗</button>}
      </div>
      <div
        id={id}
        ref={ref}
        className="rte-body"
        contentEditable
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        style={{ minHeight }}
        onInput={emit}
        onBlur={emit}
        onPaste={onPaste}
        onDrop={onDrop}
        suppressContentEditableWarning
      />
    </div>
  );
}
