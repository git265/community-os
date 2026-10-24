import React, { useEffect, useState } from 'react';
import { CONSENT_TEXT, getFace, saveFace, SITE_CHANGED, onV2 } from '../../lib/site/site.js';
import { PhotoCapture } from '../gate/gateUi.jsx';

/** A staff member's own face for the gate terminals: their consent and their photo, theirs to give or withdraw. */
export default function MyFace({ me }) {
  const [face, setFace] = useState(undefined); const [photo, setPhoto] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const load = () => getFace('member', me.id).then((f) => setFace(f || null)).catch(() => setFace(null));
  useEffect(() => {
    load();
    const h = (e) => { if (e.detail?.collection === SITE_CHANGED) load(); };
    window.addEventListener('communityos:changed', h); return () => window.removeEventListener('communityos:changed', h);
  }, [me.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (face === undefined) return null;
  const agreed = !!face?.consentAt && !face.withdrawnAt;
  async function save(consent) {
    setErr(''); setBusy(true);
    try { await saveFace('member', me.id, { consent, photo: consent ? photo || null : null, cardNo: face?.cardNo || null }); setPhoto(''); await load(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ maxWidth: 360, margin: '14px auto 0' }} data-testid="my-face">
      <b>My face at the gate</b>
      <p className="muted" style={{ margin: '6px 0' }}>{agreed ? (face.hasPhoto ? `The gate terminals know your face (on ${face.onDevices} devices).` : 'You agreed; add your photo so the terminals can know you.') : 'With your agreement, the gate terminals let you in by your face and record your attendance.'}</p>
      {!agreed && <p style={{ fontSize: 13 }}>{CONSENT_TEXT}</p>}
      {(!agreed || !face.hasPhoto || photo) && <PhotoCapture value={photo} onChange={setPhoto} label="Face photo (look straight at the camera)" testid="my-face-photo" demoName={onV2() ? '' : me.name} />}
      {err && <div className="field-error">{err}</div>}
      <div className="gg-actions" style={{ marginTop: 8 }}>
        {(!agreed || photo) && <button type="button" className="btn" disabled={busy || (!photo && !face?.hasPhoto)} data-testid="my-face-agree" onClick={() => save(true)}>{agreed ? 'Use this photo' : 'I agree, use my face'}</button>}
        {agreed && <button type="button" className="btn secondary" disabled={busy} data-testid="my-face-withdraw" onClick={() => save(false)}>Withdraw and delete my photo</button>}
      </div>
    </div>
  );
}
