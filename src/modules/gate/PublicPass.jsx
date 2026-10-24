import { plannedTime } from '../../lib/locale.js';
import React, { useEffect, useState } from 'react';
import { passQrText, readPassLink } from '../../lib/gate/engine.js';
import { qrDataUrl } from '../../lib/payments.js';

const day = (iso) => { if (!iso) return ''; const d = new Date(`${iso}T00:00:00`); return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }); };

/**
 * The page a guest opens from the pass message (WhatsApp / SMS carry text only, so the QR travels as this link). No sign-in and no
 * data from the server: it shows what the link carries - the QR the gate scans, the code to read out, and the pass's dates.
 */
export default function PublicPass() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => { const on = () => setHash(window.location.hash); window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  const p = readPassLink(hash);
  const [src, setSrc] = useState('');
  useEffect(() => { let live = true; setSrc(''); if (p?.code) qrDataUrl(passQrText(p)).then((u) => live && setSrc(u)).catch(() => {}); return () => { live = false; }; }, [p?.code]);
  useEffect(() => { document.title = p ? `Gate pass · ${p.community || 'CommunityOS'}` : 'Gate pass'; }, [p?.community]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!p) return <main className="ppass"><div className="ppass-card"><h1>Gate pass</h1><p className="muted">This pass link is not complete. Ask your host to send it again.</p></div></main>;
  const when = p.validTo && p.validTo !== p.validFrom ? `${day(p.validFrom)} – ${day(p.validTo)}` : day(p.validFrom);
  const hours = p.fromTime ? plannedTime(`${p.fromTime}${p.toTime ? ` – ${p.toTime}` : ''}`) : '';
  return (
    <main className="ppass" data-testid="public-pass">
      <div className="ppass-card">
        <div className="ppass-head">
          <small>{p.community || 'Gate pass'}</small>
          <h1>{p.visitorName ? `Welcome, ${p.visitorName}` : 'Your gate pass'}</h1>
          {(p.hostName || p.unit) && <p>Invited by {[p.hostName, p.unit && `(${p.unit})`].filter(Boolean).join(' ')}</p>}
        </div>
        <div className="ppass-qr">{src ? <img src={src} alt={`QR code for pass ${p.code}`} data-testid="public-pass-qr" /> : <div className="ppass-qr-wait" />}</div>
        <div className="ppass-pin"><small>Code</small><b data-testid="public-pass-pin">{p.code}</b></div>
        <dl className="ppass-facts">
          {when && <><dt>Valid</dt><dd>{when}</dd></>}
          {hours && <><dt>Hours</dt><dd>{hours}</dd></>}
          {p.vehicle && <><dt>Vehicle</dt><dd>{p.vehicle}</dd></>}
        </dl>
        <p className="ppass-how">Show this QR at the gate, or tell the guard the code.</p>
        {src && <a className="btn ppass-save" href={src} download={`gate-pass-${p.code}.png`} data-testid="public-pass-save">Save QR to phone</a>}
      </div>
    </main>
  );
}
