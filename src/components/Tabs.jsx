import React, { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** True while the screen is phone-sized (the app's one breakpoint, 900px). */
export function usePhone() {
  const q = '(max-width: 900px)';
  const [on, setOn] = useState(() => typeof window !== 'undefined' && window.matchMedia(q).matches);
  useEffect(() => { const m = window.matchMedia(q); const h = (e) => setOn(e.matches); m.addEventListener('change', h); return () => m.removeEventListener('change', h); }, []);
  return on;
}

const isActive = (el) => /\b(active|on)\b/.test(String(el.props.className || '')) || el.props['aria-selected'] === true || el.props['aria-pressed'] === true;
export const flat = (children) => React.Children.toArray(children).flatMap((c) => (isValidElement(c) && c.type === React.Fragment ? React.Children.toArray(c.props.children) : [c])).filter(isValidElement);

/**
 * A page's tab bar. On a computer: every tab in a row, as before. On a phone: the tabs that fit on ONE row, and the rest under "More ▾" -
 * the sections used most stay one tap away, the others are one tap more, and nothing wraps onto a second row or runs off the screen.
 * The open tab is always on the row. Children are the tab buttons, exactly as they were inside <div className="tabs">.
 */
export default function Tabs({ className = '', children, ...rest }) {
  const phone = usePhone();
  const items = flat(children);
  const row = useRef(null); const meas = useRef(null); const more = useRef(null);
  const [fit, setFit] = useState(items.length);
  const [open, setOpen] = useState(false);
  const sig = items.map((el) => `${el.key}:${typeof el.props.children === 'string' ? el.props.children : ''}`).join('|');

  useLayoutEffect(() => {
    if (!phone || items.length <= 2) { setFit(items.length); return undefined; }   // two tabs: both stay (a "More" would hide as much as it saves)
    const measure = () => {
      if (!row.current || !meas.current) return;
      const widths = [...meas.current.children].map((c) => c.getBoundingClientRect().width + 4);
      const avail = row.current.clientWidth;
      const total = widths.reduce((a, b) => a + b, 0);
      if (total <= avail) { setFit(widths.length); return; }
      const room = avail - 76;   // the "More ▾" button
      let used = 0; let n = 0;
      for (const w of widths) { if (used + w > room) break; used += w; n += 1; }
      setFit(Math.max(1, n));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(row.current);
    return () => ro?.disconnect();
  }, [phone, sig]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (more.current && !more.current.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  if (!phone || fit >= items.length) {
    return (
      <div className={`tabs${className ? ` ${className}` : ''}${phone ? ' tabs-fit' : ''}`} ref={row} {...rest}>
        {items}
        {phone && <div className="tabs-measure" aria-hidden="true" ref={meas}>{items.map((el) => cloneElement(el, { key: `m-${el.key}`, onClick: undefined, 'data-testid': undefined, tabIndex: -1, disabled: true }))}</div>}
      </div>
    );
  }
  const active = items.findIndex(isActive);
  let shown = items.slice(0, fit);
  let hidden = items.slice(fit);
  if (active >= fit) { shown = [...items.slice(0, fit - 1), items[active]]; hidden = items.filter((_, i) => i >= fit - 1 && i !== active); }
  return (
    <div className={`tabs tabs-fit${className ? ` ${className}` : ''}`} ref={row} {...rest}>
      {shown}
      <div className="tabs-more" ref={more}>
        <button type="button" aria-haspopup="menu" aria-expanded={open} data-testid="tabs-more" onClick={() => setOpen((v) => !v)}>More ▾</button>
        {open && (
          <div className="tabs-menu" role="menu">
            {hidden.map((el) => cloneElement(el, { key: el.key, role: 'menuitem', onClick: (e) => { setOpen(false); el.props.onClick?.(e); } }))}
          </div>
        )}
      </div>
      <div className="tabs-measure" aria-hidden="true" ref={meas}>{items.map((el) => cloneElement(el, { key: `m-${el.key}`, onClick: undefined, 'data-testid': undefined, tabIndex: -1, disabled: true }))}</div>
    </div>
  );
}
