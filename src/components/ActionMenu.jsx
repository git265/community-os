import React, { useEffect, useRef, useState } from 'react';

/**
 * One button that opens a short menu of actions (the "multi-action" button used for approval decisions).
 *   actions: [{ key, label, hint?, tone?: 'good' | 'bad', onClick }]
 * Closes on outside click or Escape. Test ids: <testid> (button), <testid>-<key> (menu items).
 */
export default function ActionMenu({ label = 'Decide', actions, testid = 'action-menu', tone = 'good', size = 'sm', disabled = false, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <span className="act-menu" ref={box}>
      <button type="button" className={`btn ${tone} ${size}`} disabled={disabled} aria-haspopup="menu" aria-expanded={open} data-testid={testid} onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}>{label} <span aria-hidden="true">▾</span></button>
      {open && (
        <ul className={`act-menu-list ${align}`} role="menu" data-testid={`${testid}-menu`}>
          {actions.map((a) => (
            <li key={a.key} role="none">
              <button type="button" role="menuitem" className={a.tone || ''} data-testid={`${testid}-${a.key}`} onClick={(e) => { e.stopPropagation(); setOpen(false); a.onClick(); }}>
                <span>{a.label}</span>{a.hint && <small>{a.hint}</small>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
