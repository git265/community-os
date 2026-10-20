import React, { useEffect, useRef, useState } from 'react';
import { qrDataUrl } from '../../lib/payments.js';

/** A QR code drawn from text. */
export function QrImage({ text, size = 200, testid = 'qr-img' }) {
  const [src, setSrc] = useState('');
  useEffect(() => { let live = true; if (text) qrDataUrl(text).then((u) => live && setSrc(u)).catch(() => {}); return () => { live = false; }; }, [text]);
  return src ? <img src={src} width={size} height={size} alt="QR code" data-testid={testid} style={{ background: '#fff', padding: 6, borderRadius: 10, maxWidth: '100%', height: 'auto' }} /> : <div style={{ width: size, height: size }} />;
}

/** The camera half of scanning: a button that opens the phone camera where the browser can read QR codes. Renders nothing where it cannot. */
export function CamScan({ onText, testid = 'scan-cam' }) {
  const [cam, setCam] = useState(false); const [err, setErr] = useState('');
  const vid = useRef(null); const stream = useRef(null);
  const canCam = typeof window !== 'undefined' && 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia;
  const stop = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; setCam(false); };
  useEffect(() => () => stream.current?.getTracks().forEach((t) => t.stop()), []);
  async function start() {
    setErr('');
    try {
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); setCam(true);
      await new Promise((r) => setTimeout(r, 50));
      if (vid.current) { vid.current.srcObject = stream.current; await vid.current.play().catch(() => {}); }
      const tick = async () => {
        if (!stream.current) return;
        try { const r = await det.detect(vid.current); if (r[0]?.rawValue) { const t = r[0].rawValue; stop(); onText(t); return; } } catch { /* keep trying */ }
        setTimeout(tick, 300);
      };
      tick();
    } catch { setErr('The camera could not be opened. Type the code instead.'); stop(); }
  }
  if (!canCam) return null;
  return (
    <>
      {!cam && <button type="button" className="btn secondary" data-testid={testid} onClick={start}>📷 Scan</button>}
      {cam && <div style={{ width: '100%', marginTop: 8 }}><video ref={vid} muted playsInline style={{ width: '100%', maxHeight: 260, borderRadius: 10, background: '#000' }} /><button type="button" className="btn secondary sm" onClick={stop}>Stop camera</button></div>}
      {err && <div className="field-error">{err}</div>}
    </>
  );
}

/** Read a code: type or paste it (a hand scanner types it for you), or use the phone camera. */
export function ScanBox({ onText, placeholder = 'Scan or type the code', testid = 'scan', button = 'Use' }) {
  const [v, setV] = useState('');
  const go = () => { const t = v.trim(); if (t) { onText(t); setV(''); } };
  return (
    <div data-testid={testid}>
      <div className="gg-row" style={{ flexWrap: 'wrap' }}>
        <input aria-label="Code" data-testid={`${testid}-text`} value={v} placeholder={placeholder} autoComplete="off" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} style={{ flex: 1, minWidth: 160 }} />
        <button type="button" className="btn" data-testid={`${testid}-go`} onClick={go}>{button}</button>
        <CamScan onText={onText} testid={`${testid}-cam`} />
      </div>
    </div>
  );
}
