import React, { useEffect } from 'react';

const isMobile = () => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches;

/**
 * Desktop: centered dialog. Mobile: full-screen page with a back arrow, so
 * long forms/details behave like a screen, not a cramped popup.
 * `dock`: on a computer the record opens as a panel beside the list (the list stays usable); a phone still gets the full screen.
 */
export default function Modal({ title, subtitle, onClose, children, wide = false, dock = false }) {
  // Lock page scroll behind the popup while it is open (a docked panel leaves the list beside it scrollable).
  useEffect(() => {
    if (dock && !isMobile()) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [dock]);
  // Escape closes the dialog on top (a dialog opened from inside another closes first)
  const ref = React.useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('.bell-panel')) return;   // Esc closes the notifications list first (it can open over a docked panel)
      const all = document.querySelectorAll('.modal-overlay');
      if (all[all.length - 1] === ref.current) onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={`modal-overlay${dock ? ' docked' : ''}`} ref={ref} onClick={() => { if (!isMobile()) onClose(); }}>
      <div className={`modal-card${wide ? ' wide' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="modal-handle" />
        <div className="modal-header">
          <button className="modal-back" onClick={onClose} aria-label="Back">←</button>
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {subtitle && <p className="modal-sub">{subtitle}</p>}
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
