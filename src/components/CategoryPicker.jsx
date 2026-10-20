import React, { useState } from 'react';

/**
 * A pick-one list that costs one line once chosen. With nothing picked it shows a compact grid of tiles (2-3 per row on a phone);
 * after a pick it folds to "🔧 Plumbing   Change". Same data as a drop-down, far less screen.
 * options: [{ value, label, icon? }]
 */
export default function CategoryPicker({ options, value, onChange, label = 'Category' }) {
  const [open, setOpen] = useState(false);
  const picked = options.find((o) => o.value === value);
  if (picked && !open) {
    return (
      <div className="pick-folded" data-testid="cat-folded">
        <span className="pick-now"><span aria-hidden="true">{picked.icon}</span> <b>{picked.label}</b></span>
        <button type="button" className="link-btn" data-testid="cat-change" onClick={() => setOpen(true)}>Change</button>
      </div>
    );
  }
  return (
    <div className="pick-tiles" role="group" aria-label={label} data-testid="cat-tiles">
      {options.map((o) => (
        <button key={o.value} type="button" className={`pick-tile${value === o.value ? ' on' : ''}`} aria-pressed={value === o.value} onClick={() => { onChange(o.value); setOpen(false); }}>
          <span aria-hidden="true">{o.icon}</span>{' '}{o.label}
        </button>
      ))}
    </div>
  );
}
