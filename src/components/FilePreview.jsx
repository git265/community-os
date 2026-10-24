import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import Modal from './Modal.jsx';
import { loadFileData, downloadAttachment } from '../lib/files/attachments.js';
import { getDataSource } from '../lib/storage/dataSource.js';
import { readWorkbook } from '../lib/files/xlsxRead.js';
import { sanitizeHtml } from '../lib/richtext/sanitize.js';
import Tabs from './Tabs.jsx';

const extOf = (m) => String(m?.name || '').split('.').pop().toLowerCase();
export function previewKind(m) {
  const ext = extOf(m); const mime = m?.mime || '';
  if (/^image\//.test(mime) || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (/^video\//.test(mime) || ['mp4', 'm4v', 'mov', '3gp', 'webm'].includes(ext)) return 'video';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'sheet';
  if (['txt'].includes(ext) || mime === 'text/plain') return 'text';
  return 'none'; // .doc / .ppt / .pptx / .rtf: the browser cannot show these - offer the download
}

const dataToBlob = async (dataUrl) => (await fetch(dataUrl)).blob();

/** Shows a stored file inside the app (image, PDF, Word, Excel/CSV, text). Anything else offers a download. */
export default function FilePreview({ meta, onClose }) {
  const kind = previewKind(meta);
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let on = true; let url = null;
    (async () => {
      try {
        const dataUrl = meta.dataUrl || await loadFileData(meta.fileId);
        if (!dataUrl) {
          throw new Error(getDataSource().mode === 'v2'
            ? 'This file is not on the back end. If it was uploaded while the Data source was set to Browser, switch the Data source back to Browser to see it.'
            : 'This file is not in this browser. If it was uploaded while the Data source was set to Back end, switch the Data source to Back end to see it. (Browser storage is cleared when the tab is closed.)');
        }
        if (kind === 'image') return on && setState({ kind, src: dataUrl });
        const blob = await dataToBlob(dataUrl);
        if (kind === 'pdf' || kind === 'video') { url = URL.createObjectURL(blob); return on && setState({ kind, src: url }); }
        if (kind === 'text') return on && setState({ kind, text: await blob.text() });
        if (kind === 'docx') {
          const mammoth = (await import('mammoth/mammoth.browser.js')).default || (await import('mammoth/mammoth.browser.js'));
          const r = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
          return on && setState({ kind, html: sanitizeHtml(r.value, { document: true }) });
        }
        if (kind === 'sheet') {
          const XLSX = await import('xlsx');
          const wb = await readWorkbook(await blob.arrayBuffer(), { type: 'array' });
          const sheets = wb.SheetNames.slice(0, 6).map((n) => ({ name: n, html: sanitizeHtml(XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' }), { document: true }) }));
          return on && setState({ kind, sheets, sheet: 0 });
        }
        return on && setState({ kind: 'none' });
      } catch (e) { if (on) setState({ error: e.message || 'Could not open this file here.' }); }
    })();
    return () => { on = false; if (url) URL.revokeObjectURL(url); };
  }, [meta.fileId, kind]);

  return createPortal(
    <Modal title={meta.name || 'File'} onClose={onClose}>
      <div data-testid="file-preview" className="file-preview">
        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          <button type="button" className="btn secondary sm" onClick={() => (meta.dataUrl ? Object.assign(document.createElement('a'), { href: meta.dataUrl, download: meta.name || 'file' }).click() : downloadAttachment(meta))}>⬇ Download</button>
        </div>
        {state.loading && <div className="muted">Opening…</div>}
        {state.error && <div className="notice error">{state.error} You can still download it.</div>}
        {state.kind === 'image' && <img src={state.src} alt={meta.name} style={{ maxWidth: '100%', maxHeight: '70vh', display: 'block', margin: '0 auto', borderRadius: 8 }} />}
        {state.kind === 'video' && <video src={state.src} controls playsInline preload="metadata" data-testid="video-player" style={{ width: '100%', maxHeight: '70vh', display: 'block', background: '#000', borderRadius: 8 }}>Your browser cannot play this video here. Use Download.</video>}
        {state.kind === 'pdf' && <iframe title={meta.name} src={state.src} style={{ width: '100%', height: '70vh', border: '1px solid var(--line)', borderRadius: 8 }} />}
        {state.kind === 'text' && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: '70vh', overflow: 'auto' }}>{state.text}</pre>}
        {state.kind === 'docx' && <div className="doc-preview" style={{ maxHeight: '70vh', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: state.html }} />}
        {state.kind === 'sheet' && (
          <div>
            {state.sheets.length > 1 && <Tabs style={{ margin: '0 0 8px' }}>{state.sheets.map((s, i) => <button key={s.name} className={i === state.sheet ? 'active' : ''} onClick={() => setState((x) => ({ ...x, sheet: i }))}>{s.name}</button>)}</Tabs>}
            <div className="sheet-preview" style={{ maxHeight: '70vh', overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: state.sheets[state.sheet].html }} />
          </div>
        )}
        {state.kind === 'none' && <div className="notice">The browser cannot show this type of file (Word .doc, PowerPoint, RTF). Use Download to open it on your device.</div>}
      </div>
    </Modal>,
    document.body,
  );
}
