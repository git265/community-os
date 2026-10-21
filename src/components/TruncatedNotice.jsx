import React, { useEffect, useState } from 'react';

/**
 * A list on this screen came back cut at the server's limit (X-List-Truncated): say so, instead of letting the screen look complete.
 * Cleared when the person moves to another screen.
 */
export default function TruncatedNotice() {
  const [cap, setCap] = useState(0);
  useEffect(() => {
    const cut = (e) => setCap((c) => Math.max(c, Number(e.detail?.cap) || 0));
    const moved = () => setCap(0);
    window.addEventListener('communityos:truncated', cut);
    window.addEventListener('hashchange', moved);
    return () => { window.removeEventListener('communityos:truncated', cut); window.removeEventListener('hashchange', moved); };
  }, []);
  if (!cap) return null;
  return (
    <div className="notice" role="status" data-testid="truncated-notice" style={{ margin: '0 0 12px' }}>
      Showing the newest {cap.toLocaleString()} records of a longer list. Use the date, status or unit filters to see older ones.
      <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => setCap(0)}>Dismiss</button>
    </div>
  );
}
