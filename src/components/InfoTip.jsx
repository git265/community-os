import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** A small ⓘ that shows help on mouse-over, keyboard focus or a tap (phones). The pop-up is placed to fit the screen: it never runs off the left, right or bottom edge. */
export default function InfoTip({ children, label = 'More information' }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState({ visibility: 'hidden' });
  const btn = useRef(null); const pop = useRef(null);

  const place = useCallback(() => {
    const b = btn.current; const p = pop.current; if (!b || !p) return;
    const r = b.getBoundingClientRect(); const vw = document.documentElement.clientWidth; const vh = window.innerHeight; const m = 8;
    const width = Math.min(300, vw - m * 2);
    p.style.width = `${width}px`;
    const h = p.offsetHeight;
    let left = r.left + r.width / 2 - width / 2; left = Math.max(m, Math.min(left, vw - width - m));
    const below = vh - r.bottom - m; const above = r.top - m;
    const top = h <= below || below >= above ? r.bottom + 6 : r.top - h - 6;
    setStyle({ position: 'fixed', left, top: Math.max(m, top), width, maxHeight: Math.max(80, Math.max(below, above) - 6), overflowY: 'auto', visibility: 'visible' });
  }, []);

  useLayoutEffect(() => { if (open) place(); else setStyle({ visibility: 'hidden' }); }, [open, place, children]);
  useEffect(() => {
    if (!open) return undefined;
    const on = () => place(); window.addEventListener('resize', on); window.addEventListener('scroll', on, true);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('scroll', on, true); };
  }, [open, place]);

  return (
    <span className={`info-tip${open ? ' open' : ''}`} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button ref={btn} type="button" className="info-btn" aria-label={label} aria-expanded={open} data-testid="info-tip"
        onClick={(e) => { e.preventDefault(); setOpen((o) => !o); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>ⓘ</button>
      <span ref={pop} role="tooltip" className="info-pop" data-testid="info-pop" style={style}>{children}</span>
    </span>
  );
}
