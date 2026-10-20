import React, { useEffect, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { badgeText } from '../../lib/gate/engine.js';
import { Photo } from './gateUi.jsx';
import { QrImage } from './QrImage.jsx';

/** My staff badge: a QR that changes every 30 seconds. The guard scans it; a screenshot of it stops working almost at once. */
export default function GateBadge() {
  const { currentUser, role } = useApp();
  const { records: users } = useCollection(COLLECTIONS.USERS, 'Users');
  const me = users.find((u) => u.id === currentUser?.userId) || users.find((u) => u.name === currentUser?.name && u.roleId === currentUser?.roleId) || users.find((u) => u.roleId === currentUser?.roleId);
  const [text, setText] = useState(''); const [left, setLeft] = useState(30);
  useEffect(() => {
    if (!me) return undefined;
    let live = true;
    const tick = async () => { const now = Date.now(); setLeft(30 - Math.floor((now % 30000) / 1000)); const t = await badgeText(me.id, now); if (live) setText((x) => (x === t ? x : t)); };
    tick(); const id = setInterval(tick, 1000);
    return () => { live = false; clearInterval(id); };
  }, [me?.id]);
  if (!me) return <div className="empty" data-testid="badge-none">Your sign-in is not linked to a staff record, so there is no badge to show. Ask the office.</div>;
  return (
    <div className="card" style={{ textAlign: 'center', maxWidth: 360, margin: '0 auto' }} data-testid="my-badge">
      <Photo src="" name={me.name} size={64} round />
      <h2 style={{ margin: '8px 0 0' }}>{me.name}</h2>
      <div className="muted">{role?.name || me.roleId}</div>
      <div style={{ margin: '12px 0' }}><QrImage text={text} size={220} testid="badge-qr" /></div>
      <div className="muted" data-testid="badge-timer">New code in {left} s</div>
      <small className="muted">Show this to the guard. Do not send it to anyone.</small>
    </div>
  );
}
