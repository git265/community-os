import React, { useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../../components/Modal.jsx';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';
import { screenFiles, persistPending } from '../../lib/files/attachments.js';
import { readInvoice, parseInvoice } from '../../lib/invoiceOcr.js';
import { isSameName } from '../../lib/fuzzy.js';
import { uuid } from '../../lib/uuid.js';
import { stockStatusFor } from './InventoryModule.jsx';

const addMonthsIso = (iso, n) => { const d = new Date(`${iso}T00:00:00`); d.setMonth(d.getMonth() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const UOMS = ['Nos', 'Kg', 'Litres', 'Metres', 'Boxes', 'Sets'];

/** Add stock from an invoice: choose the file -> it is read (PDF text or OCR) -> check / edit every line beside the document -> confirm and save. */
export default function InvoiceImport({ onClose }) {
  const { schemaFor } = useApp();
  const { records: stock, save } = useCollection(COLLECTIONS.INVENTORY, 'Inventory');
  const schema = schemaFor(COLLECTIONS.INVENTORY);
  const categories = schema?.fields.find((f) => f.key === 'category')?.options || ['General'];
  const [step, setStep] = useState('pick'); // pick | reading | review | saving | done
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState('');
  const [doc, setDoc] = useState(null); // { accepted, url, kind }
  const [text, setText] = useState('');
  const [method, setMethod] = useState('');
  const [head, setHead] = useState({ vendor: '', invoiceNo: '', date: '' });
  const [rows, setRows] = useState([]);
  const [result, setResult] = useState(null);
  const [pane, setPane] = useState('items');
  const inp = useRef(null);
  useEffect(() => () => { if (doc?.url) URL.revokeObjectURL(doc.url); }, [doc]);

  function fill(parsed) {
    setHead({ vendor: parsed.vendor, invoiceNo: parsed.invoiceNo, date: parsed.date });
    setRows(parsed.items.map((i) => ({ ...i, key: uuid(), include: true, category: categories.includes('General') ? 'General' : categories[0], location: 'Main store' })));
  }

  async function pick(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(''); setStep('reading'); setPct(0);
    try {
      const { accepted, rejected } = await screenFiles([f]);
      if (!accepted.length) { setErr(rejected[0]?.reason || rejected[0]?.error || 'This file type is not accepted. Use a PDF, or a photo / scan (PNG, JPG).'); setStep('pick'); return; }
      const kind = f.type === 'application/pdf' || /\.pdf$/i.test(f.name) ? 'pdf' : 'image';
      if (kind === 'image' && !/^image\//.test(f.type)) { setErr('Use a PDF or an image (PNG, JPG).'); setStep('pick'); return; }
      setDoc({ accepted: accepted[0], url: URL.createObjectURL(f), kind, name: f.name });
      const r = await readInvoice(f, setPct);
      setText(r.text); setMethod(r.method); fill(parseInvoice(r.text));
      setStep('review'); setPane('items');
    } catch (ex) { setErr(`Could not read this document: ${ex?.message || 'error'}. You can still add the items by hand below.`); setStep('review'); }
    finally { if (inp.current) inp.current.value = ''; }
  }

  const upd = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const matchFor = (r) => stock.find((s) => isSameName(r.item, s.item));
  const chosen = rows.filter((r) => r.include && r.item.trim() && Number(r.quantity) > 0);
  const total = chosen.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  async function confirm() {
    setStep('saving'); setErr('');
    try {
      let metas = [];
      if (doc) metas = (await persistPending([doc.accepted], { ownerType: 'inventory', ownerId: head.invoiceNo || 'invoice' })) || [];
      let added = 0; let topped = 0;
      for (const r of chosen) {
        const m = matchFor(r);
        const base = m || { item: r.item.trim(), category: r.category, location: r.location || 'Main store', uom: r.uom, minStock: 0 };
        const qty = (m ? Number(m.quantity) || 0 : 0) + Number(r.quantity);
        const wm = Number(r.warrantyMonths) || 0;
        const wInfo = wm > 0 ? { warrantyUntil: addMonthsIso(head.date || new Date().toISOString().slice(0, 10), wm), warrantyProvider: head.vendor || base.warrantyProvider || '' } : {};
        const out = await save({ ...base, ...wInfo, quantity: qty, stockStatus: stockStatusFor(qty, base.minStock), vendor: head.vendor || base.vendor || '', lastRestocked: head.date || base.lastRestocked || '', attachments: [...(base.attachments || []), ...metas] });
        if (out) { if (m) topped += 1; else added += 1; }
      }
      setResult({ added, topped }); setStep('done');
    } catch (ex) { setErr(`Could not save: ${ex?.message || 'error'}`); setStep('review'); }
  }

  return (
    <Modal title="Add stock from an invoice" subtitle="Upload an invoice, check what was read, correct anything, then confirm." onClose={onClose} wide>
      {err && <div className="notice error">{err}</div>}

      {step === 'pick' && (
        <div data-testid="inv-pick">
          <p className="muted">Choose a PDF invoice or a photo / scan of one. Text-based PDFs are read exactly; photos and scans are read with OCR, which can make mistakes — you will check every line before it is saved. Nothing leaves your device.</p>
          <input ref={inp} type="file" data-testid="inv-file" accept="application/pdf,image/png,image/jpeg" onChange={pick} />
          <div style={{ marginTop: 10 }}><button type="button" className="btn secondary" onClick={() => { setDoc(null); setRows([{ key: uuid(), include: true, item: '', quantity: 1, uom: 'Nos', rate: 0, amount: 0, category: categories[0], location: 'Main store' }]); setStep('review'); }}>Enter items by hand instead</button></div>
        </div>
      )}

      {step === 'reading' && <div data-testid="inv-reading"><p>Reading the document… {pct ? `${pct}%` : ''}</p><div className="poll-bar-track"><div className="poll-bar-fill" style={{ width: `${pct || 8}%` }} /></div><small className="muted">The first scan can take a few seconds while the reader loads.</small></div>}

      {(step === 'review' || step === 'saving') && (
        <div data-testid="inv-review" className="inv-wrap">
          {doc && (
            <div className="seg-tabs inv-switch" role="tablist" aria-label="Show">
              <button type="button" role="tab" aria-selected={pane === 'doc'} className={pane === 'doc' ? 'on' : ''} data-testid="inv-pane-doc" onClick={() => setPane('doc')}>📄 Document</button>
              <button type="button" role="tab" aria-selected={pane === 'items'} className={pane === 'items' ? 'on' : ''} data-testid="inv-pane-items" onClick={() => setPane('items')}>🧾 Items ({chosen.length})</button>
            </div>
          )}
          <div className={`inv-split${doc ? ' has-doc' : ''}`} data-pane={pane}>
            {doc && (
              <div className="inv-doc">
                <DocViewer doc={doc} />
                <details style={{ marginTop: 8 }}><summary>Text read from the document ({method === 'ocr' ? 'OCR' : 'PDF text'})</summary>
                  <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} aria-label="Text read" />
                  <button type="button" className="btn secondary sm" onClick={() => fill(parseInvoice(text))}>Read items again from this text</button>
                </details>
              </div>
            )}
            <div className="inv-items">
              <div className="form-grid">
                <div className="field"><label>Supplier</label><input aria-label="Supplier" value={head.vendor} onChange={(e) => setHead({ ...head, vendor: e.target.value })} /></div>
                <div className="field"><label>Invoice no.</label><input aria-label="Invoice no" value={head.invoiceNo} onChange={(e) => setHead({ ...head, invoiceNo: e.target.value })} /></div>
                <div className="field"><label>Invoice date</label><input type="date" aria-label="Invoice date" value={head.date} onChange={(e) => setHead({ ...head, date: e.target.value })} /></div>
              </div>
              {method === 'ocr' && <div className="notice">Read by OCR — numbers and names may be wrong. Check each line against the document.</div>}
              {rows.length === 0 && <div className="notice">No item lines were recognised. Add them by hand, or fix the text and read it again.</div>}
              <div className="inv-lines" data-testid="inv-rows">
                {rows.map((r, i) => {
                  const m = matchFor(r);
                  return (
                    <div key={r.key} className={`inv-line${r.include ? '' : ' off'}`} data-testid="inv-line">
                      <div className="inv-line-head">
                        <label className="inv-inc"><input type="checkbox" aria-label="Include" checked={r.include} onChange={(e) => upd(r.key, { include: e.target.checked })} /> Line {i + 1}</label>
                        {doc && <button type="button" className="btn secondary sm inv-peek" onClick={() => setPane('doc')}>View document</button>}
                        <button type="button" className="att-x" aria-label="Remove line" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>
                      </div>
                      <div className="field inv-item"><label>Item</label><input aria-label="Item" className="inv-item-input" value={r.item} placeholder="Item name as on the invoice" onChange={(e) => upd(r.key, { item: e.target.value })} />
                        {m && <small className="muted">Already in stock ({m.quantity} {m.uom}) — this adds to it</small>}</div>
                      <div className="field"><label>Category</label><select aria-label="Category" className="inv-cat-input" value={r.category} onChange={(e) => upd(r.key, { category: e.target.value })} disabled={!!m}>{categories.map((c) => <option key={c}>{c}</option>)}</select></div>
                      <div className="inv-nums">
                        <div className="field"><label>Qty</label><input type="number" inputMode="decimal" aria-label="Quantity" value={r.quantity} onChange={(e) => { const q = Number(e.target.value); upd(r.key, { quantity: q, amount: Math.round(q * (Number(r.rate) || 0) * 100) / 100 }); }} /></div>
                        <div className="field"><label>Unit</label><select aria-label="Unit" value={r.uom} onChange={(e) => upd(r.key, { uom: e.target.value })} disabled={!!m}>{UOMS.map((u) => <option key={u}>{u}</option>)}</select></div>
                        <div className="field"><label>Rate ₹</label><input type="number" inputMode="decimal" aria-label="Rate" value={r.rate} onChange={(e) => { const rt = Number(e.target.value); upd(r.key, { rate: rt, amount: Math.round((Number(r.quantity) || 0) * rt * 100) / 100 }); }} /></div>
                        <div className="field"><label>Amount ₹</label><input type="number" inputMode="decimal" aria-label="Amount" value={r.amount} onChange={(e) => upd(r.key, { amount: Number(e.target.value) })} /></div>
                        <div className="field"><label>Warranty (months)</label><input type="number" inputMode="numeric" aria-label="Warranty months" placeholder="0" value={r.warrantyMonths ?? ''} onChange={(e) => upd(r.key, { warrantyMonths: e.target.value })} /></div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="btn secondary sm" onClick={() => setRows([...rows, { key: uuid(), include: true, item: '', quantity: 1, uom: 'Nos', rate: 0, amount: 0, category: categories[0], location: 'Main store' }])}>+ Add a line</button>
              <p style={{ marginBottom: 0 }}><b>{chosen.length}</b> item{chosen.length === 1 ? '' : 's'} to add · lines total <b>₹{total.toLocaleString('en-IN')}</b></p>
            </div>
          </div>
          <div className="form-actions" style={{ marginTop: 12 }}>
            <button type="button" className="btn" data-testid="inv-confirm" disabled={step === 'saving' || chosen.length === 0} onClick={confirm}>{step === 'saving' ? 'Saving…' : `Confirm & add ${chosen.length} item${chosen.length === 1 ? '' : 's'} to inventory`}</button>
            <button type="button" className="btn secondary" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}

      {step === 'done' && (
        <div data-testid="inv-done">
          <div className="notice">✅ {result.added} new item{result.added === 1 ? '' : 's'} added{result.topped ? `, ${result.topped} existing item${result.topped === 1 ? '' : 's'} topped up` : ''}. The invoice is attached to each item.</div>
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
      )}
    </Modal>
  );
}

/** The uploaded document with zoom (− / + / fit), a full-screen view, and pinch / scroll on phones. */
function DocViewer({ doc }) {
  const [z, setZ] = useState(1);
  const [full, setFull] = useState(false);
  const step = (d) => setZ((v) => Math.min(5, Math.max(0.5, Math.round((v + d) * 100) / 100)));
  const body = (h) => (doc.kind === 'image'
    ? <div className="inv-scroll" style={{ height: h }}><img src={doc.url} alt="Invoice" style={{ width: `${z * 100}%`, maxWidth: 'none' }} /></div>
    : <iframe key={z} title="Invoice" src={`${doc.url}#zoom=${Math.round(z * 100)}`} style={{ width: '100%', height: h, border: '1px solid var(--line)', borderRadius: 8 }} />);
  const bar = (
    <div className="inv-zoom" data-testid="inv-zoom">
      <button type="button" className="btn secondary sm" aria-label="Zoom out" data-testid="zoom-out" onClick={() => step(-0.25)}>−</button>
      <span data-testid="zoom-level" className="mono">{Math.round(z * 100)}%</span>
      <button type="button" className="btn secondary sm" aria-label="Zoom in" data-testid="zoom-in" onClick={() => step(0.25)}>＋</button>
      <button type="button" className="btn secondary sm" onClick={() => setZ(1)}>Fit</button>
      <button type="button" className="btn secondary sm" data-testid="zoom-full" onClick={() => setFull(true)}>⤢ Full screen</button>
    </div>
  );
  return (
    <>
      {bar}
      {body(420)}
      {full && (
        <div className="inv-full" role="dialog" aria-label="Invoice document" data-testid="inv-full">
          <div className="inv-full-bar">{bar}<button type="button" className="btn sm" data-testid="zoom-close" onClick={() => setFull(false)}>Close</button></div>
          <div className="inv-full-body">{body('100%')}</div>
        </div>
      )}
    </>
  );
}
