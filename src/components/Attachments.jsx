import React, { useEffect, useRef, useState } from 'react';
import { screenFiles, loadFileData, isImageMeta, isVideoMeta } from '../lib/files/attachments.js';
import FilePreview from './FilePreview.jsx';
import { ATTACHMENT_ACCEPT, ATTACHMENT_HELP, MAX_BYTES } from '../lib/files/fileValidation.js';
import { tell } from '../lib/net/activity.js';

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const icon = (m) => (isImageMeta(m) ? '🖼' : isVideoMeta(m) ? '🎬' : /pdf/.test(m.mime || m.name) ? '📕' : /sheet|excel|xls|csv/.test(m.mime || m.name) ? '📊' : /word|doc/.test(m.mime || m.name) ? '📘' : '📄');

function Thumb({ meta }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { let on = true; loadFileData(meta.fileId).then((d) => on && setSrc(d)); return () => { on = false; }; }, [meta.fileId]);
  return src ? <img src={src} alt="" /> : <span className="att-icon">🖼</span>;
}

function PendingThumb({ file }) {
  const [src, setSrc] = useState(null);
  useEffect(() => { const u = URL.createObjectURL(file); setSrc(u); return () => URL.revokeObjectURL(u); }, [file]);
  const video = /^video\//.test(file.type);
  if (!src) return <span className="att-icon">{video ? '🎬' : '🖼'}</span>;
  // a video shows its first frame (no sound, no controls: tap it after saving to play)
  return video ? <video src={`${src}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" /> : <img src={src} alt="" />;
}

/** Already-stored files on a record. Click to preview in the app (download from the preview); optional remove (applies when the form is saved). */
export function AttachmentList({ items = [], onRemove }) {
  const [viewing, setViewing] = useState(null);
  if (!items.length) return <span className="muted">No files.</span>;
  return (
    <div className="att-list">
      {items.map((m, i) => (
        <div className={`att-item${isImageMeta(m) || isVideoMeta(m) ? ' att-tile' : ''}`} key={m.fileId || i}>
          <button type="button" className="att-open" onClick={() => setViewing(m)} title="Preview" data-testid={isImageMeta(m) ? 'att-thumb' : undefined}>
            {isImageMeta(m) ? <Thumb meta={m} /> : <span className="att-icon" data-testid={isVideoMeta(m) ? 'att-video' : undefined}>{icon(m)}</span>}
            <span className="att-name">{m.name}<small>{kb(m.size || 0)}</small></span>
          </button>
          {onRemove && <button type="button" className="att-x" onClick={() => onRemove(i)} aria-label={`Remove ${m.name}`}>✕</button>}
        </div>
      ))}
      {viewing && <FilePreview meta={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}

/**
 * Multi-file picker: ONE "Attach files" button, everywhere in the portal. It opens the device's own chooser, which on a phone offers the
 * camera (photo or video), the gallery and documents in one place; on a computer, any file. Files are screened at once but only
 * STORED when the parent form is saved: `pending` / `onChange` is the parent's staged list.
 */
export function AttachmentPicker({ pending, onChange, label = 'Attach files' }) {
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState([]);

  async function pick(e) {
    const files = e.target.files;
    if (!files?.length) return;
    setBusy(true);
    try {
      const { accepted, rejected: bad } = await screenFiles(files);
      setRejected(bad);
      if (accepted.length) onChange([...pending, ...accepted]);
    } catch (e) {
      tell(e?.message || String(e), e?.name === 'NetworkError' || e?.name === 'TimeoutError' ? 'network' : 'error');
    } finally {
      setBusy(false);
    }
    if (ref.current) ref.current.value = '';
  }

  return (
    <div className="file-upload">
      <input ref={ref} type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={pick} aria-label={label} data-testid="att-input" style={{ display: 'none' }} />
      <button type="button" className="btn secondary att-btn" data-testid="att-attach" disabled={busy} title={label} onClick={() => ref.current?.click()}>📎 Attach files</button>
      <div className="muted file-help" style={{ fontSize: 12, marginTop: 4 }}>Photo, video or document ({ATTACHMENT_HELP.replace(/^Images, videos, /, '')}) · max {MAX_BYTES / 1024 / 1024} MB each (a video about 20 seconds) · checked before upload</div>
      {busy && <div className="notice">🔍 Checking files…</div>}
      {rejected.map((r, i) => <div key={i} className="notice error">🚫 {r.name}: {r.reason}</div>)}
      {pending.length > 0 && (
        <div className="att-list" style={{ marginTop: 8 }}>
          {pending.map((p, i) => (
            <div className={`att-item pending${/^(image|video)\//.test(p.file.type) ? ' att-tile' : ''}`} key={i}>
              <span className="att-open">{/^(image|video)\//.test(p.file.type) ? <PendingThumb file={p.file} /> : <span className="att-icon">{icon({ mime: p.file.type, name: p.file.name })}</span>}<span className="att-name">{p.file.name}<small>{kb(p.file.size)} · ready to upload on save</small></span></span>
              <button type="button" className="att-x" onClick={() => onChange(pending.filter((_, j) => j !== i))} aria-label={`Remove ${p.file.name}`}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
