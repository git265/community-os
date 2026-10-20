import React, { useEffect, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { canWriteCollection } from '../../lib/security/authz.js';
import { getPrincipal } from '../../lib/security/principal.js';
import { activeObjectStore } from '../../lib/files/objectStore.js';
import { uploadPhotos, publishToDocuments, removePhoto } from '../../lib/culturalPhotos.js';
import { dateTime } from '../../lib/documents/templates.js';

/** Tile gallery for one event. Photos upload the moment they are chosen (no Save step). */
export default function PhotoGallery({ ev, manager }) {
  const { roleId } = useApp();
  const { records, save, reload } = useCollection(COLLECTIONS.CULTURAL_PHOTOS, 'Event Photos');
  const me = getPrincipal()?.name || '';
  const photos = records.filter((r) => r.eventId === ev.id).sort((a, b) => String(b.recordCreatedAt).localeCompare(String(a.recordCreatedAt)));
  const canUpload = manager || ev.photosBy !== 'Committee only';
  const canFile = canWriteCollection(COLLECTIONS.DOCUMENTS, getPrincipal());
  const [mine, setMine] = useState(false);
  const [caption, setCaption] = useState('');
  const [toDocs, setToDocs] = useState(false);
  const [prog, setProg] = useState(null);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(null); // index in `list`
  const [drag, setDrag] = useState(false);
  const input = useRef(null);
  const list = mine ? photos.filter((x) => x.uploadedBy === me) : photos;

  async function go(files) {
    if (!files?.length) return;
    setMsg(''); setProg({ done: 0, total: files.length });
    const res = await uploadPhotos(files, { ev, caption: caption.trim(), toDocuments: toDocs && canFile, onProgress: setProg });
    setProg(null); setCaption('');
    if (input.current) input.current.value = '';
    await reload?.();
    window.dispatchEvent(new CustomEvent('communityos:changed', { detail: { collection: COLLECTIONS.CULTURAL_PHOTOS } }));
    setMsg(`${res.added.length} photo${res.added.length === 1 ? '' : 's'} added${res.rejected.length ? ` · ${res.rejected.length} skipped: ${res.rejected.map((r) => `${r.name} (${r.reason})`).join('; ')}` : ''}`);
  }

  return (
    <div data-testid="photo-gallery">
      <div className="tab-head"><h3 style={{ margin: 0 }}>Photos <small className="muted">· {photos.length}</small></h3>
        <label className="chip-btn" style={{ cursor: 'pointer' }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine</label></div>
      {canUpload ? (
        <div className={`photo-drop${drag ? ' over' : ''}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); go(e.dataTransfer.files); }}>
          <div className="pd-row">
            <input className="pd-cap" aria-label="Caption for the next photos" placeholder="Caption (optional)" value={caption} onChange={(e) => setCaption(e.target.value)} />
            <button type="button" className="btn" data-testid="photo-add" disabled={!!prog} onClick={() => input.current?.click()}>＋ Add photos</button>
            <input ref={input} data-testid="photo-input" type="file" accept="image/*" multiple hidden onChange={(e) => go(e.target.files)} />
          </div>
          {canFile && <label className="check"><input type="checkbox" data-testid="photo-to-docs" checked={toDocs} onChange={(e) => setToDocs(e.target.checked)} /> Also save to Documents (Cultural events / {ev.name})</label>}
          <small className="muted">Pictures upload as soon as you choose them · stored in {activeObjectStore().name}. Drag and drop works too.</small>
          {prog && <div className="photo-prog" data-testid="photo-progress"><div style={{ width: `${Math.round((prog.done / Math.max(1, prog.total)) * 100)}%` }} /> <small>Uploading {Math.min(prog.done + 1, prog.total)} of {prog.total}…</small></div>}
        </div>
      ) : <div className="notice">Only the committee adds photos for this event.</div>}
      {msg && <div className="notice" data-testid="photo-msg" style={{ marginTop: 8 }}>{msg}</div>}
      {list.length === 0 ? <div className="empty">No photos yet.{canUpload ? ' Add the first one above.' : ''}</div> : (
        <div className="photo-grid" data-testid="photo-grid">
          {list.map((ph, i) => (
            <button key={ph.id} type="button" className="photo-tile" data-testid="photo-tile" onClick={() => setOpen(i)} aria-label={ph.caption || ph.fileName}>
              <img src={ph.thumb} alt={ph.caption || ph.fileName} loading="lazy" />
              <span className="pt-cap">{ph.caption || ph.fileName}<small>{ph.uploadedBy}</small></span>
              {ph.documentId && <span className="pt-doc" title="Also in Documents">📁</span>}
            </button>
          ))}
        </div>
      )}
      {open != null && list[open] && <Lightbox list={list} index={open} setIndex={setOpen} ev={ev} me={me} manager={manager} canFile={canFile} save={save} onClose={() => setOpen(null)} reload={reload} />}
    </div>
  );
}

function Lightbox({ list, index, setIndex, ev, me, manager, canFile, save, onClose, reload }) {
  const ph = list[index];
  const [url, setUrl] = useState('');
  const [cap, setCap] = useState(ph.caption || '');
  const [busy, setBusy] = useState(false);
  const own = manager || ph.uploadedBy === me;
  useEffect(() => { setUrl(''); setCap(ph.caption || ''); activeObjectStore().url(ph.fileId).then(setUrl).catch(() => setUrl(ph.thumb)); }, [ph.id]); // eslint-disable-line
  useEffect(() => { const k = (e) => { if (e.key === 'ArrowRight' && index < list.length - 1) setIndex(index + 1); if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [index, list.length]); // eslint-disable-line
  async function saveCap() { setBusy(true); await save({ ...ph, caption: cap.trim() }); setBusy(false); }
  async function toDocs() { setBusy(true); try { const d = await publishToDocuments(ph, ev); await save({ ...ph, documentId: d.shortId || d.id }); } catch (e) { window.dispatchEvent(new CustomEvent('communityos:denied', { detail: { message: e.message } })); } setBusy(false); }
  async function del() { if (!window.confirm('Remove this photo?')) return; setBusy(true); await removePhoto(ph); await reload?.(); setBusy(false); onClose(); }
  return (
    <Modal title={ph.caption || ph.fileName} subtitle={`${index + 1} of ${list.length}`} onClose={onClose} wide>
      <div className="lb-stage" data-testid="lightbox">
        <button type="button" className="lb-nav" aria-label="Previous photo" disabled={index === 0} onClick={() => setIndex(index - 1)}>‹</button>
        {url ? <img src={url} alt={ph.caption || ph.fileName} /> : <div className="empty">Loading…</div>}
        <button type="button" className="lb-nav" aria-label="Next photo" disabled={index === list.length - 1} onClick={() => setIndex(index + 1)}>›</button>
      </div>
      <div className="kv" style={{ marginTop: 8 }}>
        <span>Uploaded</span><b>{dateTime(ph.recordCreatedAt)} · {ph.uploadedBy}</b>
        <span>Taken on</span><b>{ph.takenOn || '—'}</b>
        <span>File</span><b>{ph.fileName} · {ph.fileSize} KB</b>
        <span>Stored in</span><b>{ph.store === 's3' ? 'Amazon S3' : ph.store === 'azure' ? 'Azure Blob' : 'Browser demo storage'}</b>
        <span>Documents</span><b>{ph.documentId ? `Saved as ${ph.documentId}` : 'Not filed'}</b>
      </div>
      {own && <div className="field" style={{ marginTop: 8 }}><label>Caption</label><div style={{ display: 'flex', gap: 8 }}><input value={cap} onChange={(e) => setCap(e.target.value)} /><button type="button" className="btn secondary" disabled={busy || cap.trim() === (ph.caption || '')} onClick={saveCap}>Save</button></div></div>}
      <div className="form-actions">
        {canFile && !ph.documentId && <button type="button" className="btn" data-testid="photo-file-doc" disabled={busy} onClick={toDocs}>📁 Save to Documents</button>}
        {url && <a className="btn secondary" href={url} download={ph.fileName} style={{ textDecoration: 'none' }}>Download</a>}
        {own && <button type="button" className="btn secondary danger-soft" data-testid="photo-delete" disabled={busy} onClick={del}>Remove</button>}
        <button type="button" className="btn secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
