import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import DocumentPreview from '../../components/DocumentPreview.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { getLetterhead } from '../../lib/documents/letterhead.js';
import { brochureHtml } from '../../lib/documents/brochure.js';
import { addBrochureImage, imageUrl, dropImage } from '../../lib/brochureImages.js';
import { activeObjectStore } from '../../lib/files/objectStore.js';
import { notify, offeredChannels } from '../../lib/notify.js';

const KINDS = [
  ['Cover', 'Cover - big picture, name, dates'],
  ['Text', 'Text and picture'],
  ['Programme', 'Programme - fills itself from the Programme tab'],
  ['Offerings', 'Seva offerings - fills itself'],
  ['Photos', 'Photo grid - from the event photos'],
  ['Contact', 'Contact and thanks'],
];
const AUTO = ['Programme', 'Offerings', 'Photos'];
const ICON = { Cover: '🖼', Text: '📝', Programme: '🗓', Offerings: '🪔', Photos: '📷', Contact: '☎️' };

/**
 * Event brochure: the programme and any other information, laid out as pages with pictures, then published to residents.
 * Everyone sees the finished brochure; the committee also gets the page list to edit. Programme, offerings and photos pages fill themselves.
 */
export default function Brochure({ ev, manager, programs, offerings, saveEvent }) {
  const { currentUser, roles } = useApp();
  const { records, save, remove, refresh: reload } = useCollection(C.CULTURAL_BROCHURE, 'Event Brochure');
  const { records: allPhotos } = useCollection(C.CULTURAL_PHOTOS, 'Event Photos');
  const pages = useMemo(() => records.filter((r) => r.eventId === ev.id).sort((a, b) => (a.order || 0) - (b.order || 0)), [records, ev.id]);
  const photos = useMemo(() => allPhotos.filter((r) => r.eventId === ev.id), [allPhotos, ev.id]);
  const [html, setHtml] = useState('');
  const [edit, setEdit] = useState(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pub, setPub] = useState(null);
  const [done, setDone] = useState('');
  const live = ev.brochureStatus === 'Published';

  const sig = JSON.stringify([pages.map((p) => [p.id, p.recVersion, p.order]), programs.map((p) => [p.id, p.recVersion]), offerings.map((o) => [o.id, o.recVersion]), photos.length, ev.recVersion]);
  async function build() {
    const urls = {};
    for (const p of pages) if (p.fileId) urls[p.fileId] = await imageUrl(p);
    if (pages.some((p) => p.kind === 'Photos')) for (const ph of photos.slice(0, 6)) urls[`photo:${ph.id}`] = await activeObjectStore().url(ph.fileId).catch(() => ph.thumb) || ph.thumb;
    return brochureHtml({ lh: await getLetterhead(), ev, pages, programs, offerings, photos, urls });
  }
  useEffect(() => { let on = true; build().then((h) => on && setHtml(h)); return () => { on = false; }; }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  async function addPage(kind) {
    const p = await save({ eventId: ev.id, order: (pages.at(-1)?.order || 0) + 10, kind, heading: kind === 'Cover' ? ev.name : kind === 'Text' ? 'About the event' : kind === 'Contact' ? 'Join us' : '', body: '', layout: 'Picture top' });
    if (p) setEdit(p);
  }
  async function starter() {
    let n = 0;
    const plain = String(ev.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    for (const row of [{ kind: 'Cover', heading: ev.name }, { kind: 'Text', heading: 'About the event', body: plain }, { kind: 'Programme', heading: 'Programme' }, { kind: 'Offerings', heading: 'Seva offerings' }, { kind: 'Contact', heading: 'Join us', body: 'Everyone is welcome. Sign up for seva and contribute from the Cultural page.' }]) {
      n += 10; await save({ eventId: ev.id, order: n, layout: 'Picture top', ...row });
    }
  }
  async function move(p, dir) {
    const i = pages.findIndex((x) => x.id === p.id);
    const o = pages[i + dir];
    if (!o) return;
    await save({ ...p, order: o.order }); await save({ ...o, order: p.order });
  }
  async function unpublish() {
    setBusy(true); await saveEvent({ ...ev, brochureStatus: 'Draft' }); setBusy(false);
  }
  /** Publish or republish. Notification goes out on the channels the community configured for "Event brochure published or updated". */
  async function publish({ tell, everyone, message }) {
    setBusy(true);
    const version = (Number(ev.brochureVersion) || 0) + 1;
    const out = await saveEvent({ ...ev, brochureStatus: 'Published', brochurePublishedAt: new Date().toISOString(), brochureVersion: version });
    let sent = 0;
    if (out && tell) {
      const to = everyone ? roles.filter((r) => r.category !== 'Vendor').map((r) => r.id) : ['owner', 'resident'];
      sent = await notify({ event: 'brochure', title: `${version > 1 ? 'Brochure updated' : 'Brochure'} · ${ev.name}`, body: message, link: '#/cultural', toRoleIds: to, by: currentUser?.name || '' }).catch(() => 0);
    }
    setBusy(false); setPub(null);
    setDone(tell ? `${version > 1 ? 'Republished' : 'Published'}. Residents were notified${sent ? ` (${sent} extra message${sent === 1 ? '' : 's'} queued on e-mail / WhatsApp / SMS)` : ' in the app'}.` : `${version > 1 ? 'Republished' : 'Published'} without sending a notification.`);
  }
  async function del(p) {
    if (!window.confirm('Remove this page?')) return;
    await remove(p.id); await dropImage(p, records); setEdit(null); reload?.();
  }

  return (
    <div className="card" data-testid="cultural-brochure">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Brochure {manager && <span className={`tag ${live ? 'green' : 'orange'}`} data-testid="bro-status">{live ? `Published${Number(ev.brochureVersion) > 1 ? ` · version ${ev.brochureVersion}` : ''}` : 'Draft – residents cannot see it'}</span>}{!manager && Number(ev.brochureVersion) > 1 && ev.brochurePublishedAt && <small className="muted" style={{ marginLeft: 8 }}>Updated {new Date(ev.brochurePublishedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</small>}</h3>
        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {pages.length > 0 && <button type="button" className="btn secondary sm" data-testid="bro-open" onClick={() => setFull(true)}>🖨 Open / print / save as PDF</button>}
          {manager && pages.length > 0 && <button type="button" className="btn sm" data-testid="bro-publish" disabled={busy} onClick={() => setPub({ republish: live })}>{live ? '🔁 Republish…' : '📣 Publish…'}</button>}
          {manager && live && <button type="button" className="btn secondary sm" data-testid="bro-unpublish" disabled={busy} onClick={unpublish}>Unpublish</button>}
        </span>
      </div>
      {manager && !live && pages.length > 0 && <div className="notice" style={{ marginTop: 8 }}>Only the committee sees this brochure. Publish it when it is final.</div>}
      {done && <div className="notice" style={{ marginTop: 8 }} data-testid="bro-done">{done}</div>}

      {manager && (
        <div style={{ marginTop: 10 }} data-testid="bro-pages">
          {pages.length === 0 && (
            <div className="empty" data-testid="bro-empty">
              No pages yet. <button type="button" className="btn sm" data-testid="bro-starter" onClick={starter}>Start with a ready layout</button>
              <div className="muted" style={{ marginTop: 4 }}>Cover, about, programme, offerings and contact. Then add your pictures and edit the words.</div>
            </div>
          )}
          {pages.map((p, i) => (
            <div key={p.id} className="bro-row" data-testid="bro-row">
              {p.thumb ? <img src={p.thumb} alt="" className="bro-thumb" /> : <span className="bro-thumb ph" aria-hidden="true">{ICON[p.kind]}</span>}
              <span style={{ flex: 1, minWidth: 0 }}><b>{p.heading || p.kind}</b><br /><small className="muted">{p.kind}{AUTO.includes(p.kind) ? ' · fills itself' : ''}{p.body ? ` · ${p.body.slice(0, 50)}${p.body.length > 50 ? '…' : ''}` : ''}</small></span>
              <button type="button" className="btn secondary sm" aria-label="Move up" disabled={i === 0} onClick={() => move(p, -1)}>↑</button>
              <button type="button" className="btn secondary sm" aria-label="Move down" disabled={i === pages.length - 1} onClick={() => move(p, 1)}>↓</button>
              <button type="button" className="btn secondary sm" data-testid="bro-edit" onClick={() => setEdit(p)}>Edit</button>
            </div>
          ))}
          {pages.length > 0 && (
            <div className="chips" style={{ marginTop: 8 }}>
              <span className="muted" style={{ alignSelf: 'center' }}>Add a page:</span>
              {KINDS.map(([k]) => <button key={k} type="button" className="chip-btn" data-testid={`bro-add-${k}`} onClick={() => addPage(k)}>{ICON[k]} {k}</button>)}
            </div>
          )}
        </div>
      )}

      {pages.length === 0 && !manager && <div className="empty">The brochure will be published soon.</div>}
      {pages.length > 0 && <iframe title="Brochure" srcDoc={html} data-testid="bro-frame" className="bro-frame" />}

      {edit && <PageEditor page={edit} ev={ev} all={records} onSave={save} onDelete={() => del(edit)} onClose={() => { setEdit(null); reload?.(); }} />}
      {pub && <PublishDialog ev={ev} again={pub.republish} busy={busy} onGo={publish} onClose={() => setPub(null)} />}
      {full && <DocumentPreview title={`Brochure · ${ev.name}`} html={html} fileName={`${ev.name} brochure`} onClose={() => setFull(false)} />}
    </div>
  );
}

function PageEditor({ page, ev, all, onSave, onDelete, onClose }) {
  const [p, setP] = useState(page);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef(null);
  const auto = AUTO.includes(p.kind);
  const set = (k, v) => setP((x) => ({ ...x, [k]: v }));
  async function pick(files) {
    const f = files?.[0]; if (!f) return;
    setBusy(true); setErr('');
    try {
      const old = p.fileId ? p : null;
      const img = await addBrochureImage(f, ev);
      const next = await onSave({ ...p, ...img });
      if (old) await dropImage(old, all.filter((r) => r.id !== p.id));
      setP(next || { ...p, ...img });
    } catch (e) { setErr(e.message || 'Could not add that picture'); }
    setBusy(false);
  }
  async function dropPic() {
    setBusy(true);
    const old = p;
    const next = await onSave({ ...p, fileId: '', objectKey: '', thumb: '', imageName: '' });
    await dropImage(old, all.filter((r) => r.id !== p.id));
    setP(next || { ...p, fileId: '', objectKey: '', thumb: '', imageName: '' });
    setBusy(false);
  }
  async function done() { setBusy(true); const ok = await onSave(p); setBusy(false); if (ok) onClose(); }
  return (
    <Modal title={`${ICON[p.kind] || ''} ${p.kind} page`} subtitle={auto ? 'This page fills itself from the event. You can change the heading and add a line of introduction.' : 'Words and a picture. Keep it short — people read this on a phone.'} onClose={onClose}>
      <div className="form-grid">
        <div className="field"><label>Page type</label><select aria-label="Page type" value={p.kind} onChange={(e) => set('kind', e.target.value)}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label>Heading</label><input aria-label="Heading" data-testid="bro-heading" value={p.heading || ''} onChange={(e) => set('heading', e.target.value)} /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>{p.kind === 'Cover' ? 'Tagline' : 'Text'}</label><textarea rows={p.kind === 'Text' ? 6 : 3} aria-label="Text" data-testid="bro-body" value={p.body || ''} onChange={(e) => set('body', e.target.value)} /></div>
        {p.kind === 'Text' && p.fileId && <div className="field"><label>Picture position</label><select aria-label="Picture position" value={p.layout || 'Picture top'} onChange={(e) => set('layout', e.target.value)}><option>Picture top</option><option>Picture left</option><option>Picture right</option></select></div>}
      </div>
      {!auto && (
        <div className="field" style={{ marginTop: 8 }}>
          <label>Picture</label>
          {p.thumb && <img src={p.thumb} alt="" className="bro-edit-img" data-testid="bro-img" />}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn secondary" data-testid="bro-pick" disabled={busy} onClick={() => input.current?.click()}>{p.thumb ? 'Change picture' : '＋ Add a picture'}</button>
            {p.thumb && <button type="button" className="btn secondary danger-soft" disabled={busy} onClick={dropPic}>Remove picture</button>}
            <input ref={input} data-testid="bro-file" type="file" accept="image/*" hidden onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
          </div>
          <small className="muted">Large photos are shrunk automatically.</small>
        </div>
      )}
      {err && <div className="field-error" data-testid="bro-error">{err}</div>}
      <div className="form-actions">
        <button type="button" className="btn" data-testid="bro-save" disabled={busy} onClick={done}>{busy ? 'Working…' : 'Save page'}</button>
        <button type="button" className="btn secondary danger-soft" disabled={busy} onClick={onDelete}>Delete page</button>
        <button type="button" className="btn secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function PublishDialog({ ev, again, busy, onGo, onClose }) {
  const [tell, setTell] = useState(true);
  const [everyone, setEveryone] = useState(false);
  const [note, setNote] = useState('');
  const [channels, setChannels] = useState(null);
  useEffect(() => { offeredChannels('brochure').then(setChannels).catch(() => setChannels([])); }, []);
  const message = again
    ? `The brochure for ${ev.name} has been updated${note.trim() ? `: ${note.trim()}` : '.'} Open the Cultural page to see the latest.`
    : `The brochure for ${ev.name} is ready${note.trim() ? ` — ${note.trim()}` : ''}. Programme, seva and everything you need to know is on the Cultural page.`;
  return (
    <Modal title={again ? 'Republish the brochure' : 'Publish the brochure'} subtitle={again ? 'Residents see the latest pages straight away. Tell them what changed.' : 'Residents can read it as soon as you publish.'} onClose={onClose}>
      <label className="check" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" data-testid="pub-tell" checked={tell} onChange={(e) => setTell(e.target.checked)} /> Send a notification</label>
      {tell && (
        <div style={{ marginTop: 8 }}>
          <div className="field"><label>{again ? 'What changed (optional)' : 'A line to add (optional)'}</label><input aria-label="Note" data-testid="pub-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={again ? 'e.g. Dinner moved to 8 pm' : 'e.g. Sign up for seva by Friday'} /></div>
          <div className="field"><label>Who is told</label>
            <select aria-label="Who is told" data-testid="pub-who" value={everyone ? 'all' : 'res'} onChange={(e) => setEveryone(e.target.value === 'all')}><option value="res">Owners and residents</option><option value="all">Everyone (committee and staff too)</option></select></div>
          <div className="notice" data-testid="pub-channels">In the app{channels && channels.length ? <>, plus <b>{channels.join(', ')}</b></> : channels ? '' : '…'}. This follows <b>Notification settings</b> for “Event brochure published or updated”; each person’s own opt-ins apply.</div>
          <div className="box muted" style={{ marginTop: 8 }} data-testid="pub-preview">“{message}”</div>
        </div>
      )}
      <div className="form-actions">
        <button type="button" className="btn" data-testid="pub-go" disabled={busy} onClick={() => onGo({ tell, everyone, message })}>{busy ? 'Working…' : again ? 'Republish' : 'Publish'}{tell ? ' & notify' : ''}</button>
        <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
