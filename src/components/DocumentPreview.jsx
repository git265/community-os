import React, { useRef } from 'react';
import Modal from './Modal.jsx';

/** Shows a generated document (receipt / statement) exactly as it will print, with Print / Save as PDF and Download. */
export default function DocumentPreview({ title, html, fileName = 'document', onClose }) {
  const ref = useRef(null);
  const print = () => { const w = ref.current?.contentWindow; if (w) { w.focus(); w.print(); } };
  const download = () => { const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([html], { type: 'text/html' })), download: `${fileName}.html` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
  return (
    <Modal title={title} subtitle="Preview. Use Print → Save as PDF to keep a copy." onClose={onClose} wide>
      <iframe ref={ref} title={title} srcDoc={html} data-testid="doc-frame" style={{ width: '100%', height: '62vh', border: '1px solid var(--line)', borderRadius: 8, background: '#fff' }} />
      <div className="form-actions">
        <button type="button" className="btn" data-testid="doc-print" onClick={print}>🖨 Print / Save as PDF</button>
        <button type="button" className="btn secondary" data-testid="doc-download" onClick={download}>Download</button>
        <button type="button" className="btn secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** A button that builds a document on demand and opens its preview: <DocButton build={() => billReceipt(due)} label="Receipt" /> */
export function DocButton({ build, label, title, fileName, testid, className = 'btn secondary sm' }) {
  const [html, setHtml] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  async function open() { setBusy(true); try { setHtml(await build()); } finally { setBusy(false); } }
  return (
    <>
      <button type="button" className={className} data-testid={testid} disabled={busy} onClick={open}>{busy ? 'Preparing…' : label}</button>
      {html && <DocumentPreview title={title || label} html={html} fileName={fileName || label} onClose={() => setHtml(null)} />}
    </>
  );
}
