import React, { useState } from 'react';

/**
 * "Common issues" for a resident request: one line until opened (or open from the start: defaultOpen), then a wrapping grid (no sideways
 * scrolling - works on a phone).
 * Picking one fills the form and folds the list again.
 */
export default function QuickIssues({ phrases, emoji = {}, onPick, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const [picked, setPicked] = useState('');
  return (
    <div className="field" style={{ gridColumn: '1 / -1' }} data-testid="quick-issues">
      <label>Common issues</label>
      {!open ? (
        <button type="button" className="pick-folded pick-btn" data-testid="qi-toggle" aria-expanded="false" onClick={() => setOpen(true)}>
          <span className="pick-now">{picked ? <><span aria-hidden="true">✓</span> {picked}</> : <>⚡ Tap to pick a common issue</>}</span>
          <span className="link-btn">{picked ? 'Change' : 'Show'}</span>
        </button>
      ) : (
        <div className="pick-tiles qi-grid" role="group" aria-label="Common issues" data-testid="qi-grid">
          {phrases.map((qp) => (
            <button key={qp.id} type="button" className="pick-tile qi-tile" data-testid="qi-item" onClick={() => { setPicked(qp.phrase); setOpen(false); onPick(qp); }}>
              <span aria-hidden="true">{emoji[qp.category] || ''}</span>{' '}{qp.phrase}
            </button>
          ))}
          <button type="button" className="pick-tile qi-tile qi-close" onClick={() => setOpen(false)}>Close ▴</button>
        </div>
      )}
    </div>
  );
}
