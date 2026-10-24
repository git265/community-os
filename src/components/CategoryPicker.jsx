import React, { useState } from 'react';

/**
 * A pick-one list that costs one line once chosen. With nothing picked it shows a compact grid of tiles (2-3 per row on a phone);
 * after a pick it folds to "🔧 Plumbing   Change". Same data as a drop-down, far less screen. startFolded: one line even before a pick.
 * options: [{ value, label, icon? }]
 */
export default function CategoryPicker({ options, value, onChange, label = 'Category', startFolded = false }) {
  const [open, setOpen] = useState(false);
  const [shut, setShut] = useState(startFolded);   // folded before anything is picked (the common issues come first): one line until opened
  const picked = options.find((o) => o.value === value);
  if (!picked && shut) {
    return (
      <button type="button" className="pick-folded pick-btn" data-testid="cat-folded-empty" aria-expanded="false" onClick={() => setShut(false)}>
        <span className="pick-now">Choose a category</span><span className="link-btn">Show</span>
      </button>
    );
  }
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
