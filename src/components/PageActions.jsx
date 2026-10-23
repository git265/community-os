import React, { cloneElement, useEffect, useRef, useState } from 'react';
import { flat, usePhone } from './Tabs.jsx';

/**
 * A page's buttons (beside its title). On a computer: all of them, as before. On a phone: the main one (the first button that is not
 * "secondary") and "⋯" with the others - the action used most is one tap, the rest one tap more, and they no longer fill the screen.
 */
export default function PageActions({ children, keep = 0, inline = false }) {
  const phone = usePhone();
  const items = flat(children);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  if (!phone || items.length <= Math.max(1, keep)) return <div className={`page-actions${inline ? ' inline' : ''}`}>{items}</div>;
  const cls = (el) => String(el.props.className || '');
  // keep: the first N buttons stay (a row of record actions: "Preview" + ⋯); otherwise the main (not "secondary") one
  let main = items.findIndex((el) => /\bbtn\b/.test(cls(el)) && !/\bsecondary\b/.test(cls(el)));
  if (main < 0) main = items.length - 1;
  const shown = keep > 0 ? items.slice(0, keep) : [items[main]];
  const rest = items.filter((el) => !shown.includes(el));
  return (
    <div className={`page-actions phone${inline ? ' inline' : ''}`} ref={box}>
      {shown}
      <div className="pa-more">
        <button type="button" className="btn secondary pa-more-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={open} data-testid="page-more" onClick={() => setOpen((v) => !v)}>⋯</button>
        {open && (
          <div className="pa-menu" role="menu">
            {rest.map((el) => cloneElement(el, { key: el.key, role: 'menuitem', onClick: (e) => { setOpen(false); el.props.onClick?.(e); } }))}
          </div>
        )}
      </div>
    </div>
  );
}
