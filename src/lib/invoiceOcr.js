// Read an invoice (PDF or photo) and turn it into stock lines.
//   PDF with a text layer -> text is taken straight from the PDF (fast, exact).
//   Scanned PDF / photo   -> OCR with Tesseract running in the browser. Its worker, engine and English data are bundled in
//                            /public/ocr, so nothing is downloaded and the document never leaves the device.
// The result is only a DRAFT: the screen always lets the person edit every line before anything is saved.

const BASE = (import.meta.env?.BASE_URL || '/').replace(/\/?$/, '/');

/** Text lines of a PDF, reading each page's text layer; returns '' when the PDF is a scan. */
async function pdfTextLayer(buf) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
  const out = [];
  for (let n = 1; n <= Math.min(doc.numPages, 10); n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3); // items within ~3pt are on one line
      (rows.get(y) || rows.set(y, []).get(y)).push({ x: it.transform[4], s: it.str });
    }
    [...rows.entries()].sort((a, b) => b[0] - a[0]).forEach(([, r]) => out.push(r.sort((a, b) => a.x - b.x).map((i) => i.s).join('  ')));
  }
  return out.join('\n');
}

async function pdfToImages(buf) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: buf.slice(0) }).promise;
  const imgs = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    imgs.push(c);
  }
  return imgs;
}

async function ocrImages(images, onProgress) {
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('eng', 1, {
    workerPath: `${BASE}ocr/worker.min.js`, corePath: `${BASE}ocr/`, langPath: `${BASE}ocr/lang`, gzip: true,
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(Math.round(m.progress * 100)); },
  });
  try {
    const parts = [];
    for (const im of images) parts.push((await worker.recognize(im)).data.text);
    return parts.join('\n');
  } finally { await worker.terminate(); }
}

/** -> { text, method: 'pdf-text' | 'ocr' } */
export async function readInvoice(file, onProgress) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    const buf = await file.arrayBuffer();
    const text = await pdfTextLayer(buf).catch(() => '');
    if (text.replace(/\s/g, '').length > 40) return { text, method: 'pdf-text' };
    return { text: await ocrImages(await pdfToImages(buf), onProgress), method: 'ocr' };
  }
  return { text: await ocrImages([file], onProgress), method: 'ocr' };
}

/* ---------------------------------------------------------------- parsing -- */
const SKIP = /\b(total|sub\s*-?total|grand|gst|cgst|sgst|igst|tax|round|balance|invoice|bill\s*to|ship\s*to|date|phone|mob|e-?mail|gstin|pan|address|bank|ifsc|a\/c|account|discount|paid|due|words|terms|signature|authori[sz]ed|thank|page|hsn|sac|description|particulars|s\.?\s*no|qty|quantity|rate|amount|cheque|upi)\b/i;
const UOMS = { nos: 'Nos', no: 'Nos', pcs: 'Nos', pc: 'Nos', piece: 'Nos', pieces: 'Nos', unit: 'Nos', units: 'Nos', each: 'Nos', kg: 'Kg', kgs: 'Kg', litre: 'Litres', litres: 'Litres', liter: 'Litres', liters: 'Litres', ltr: 'Litres', ltrs: 'Litres', l: 'Litres', mtr: 'Metres', mtrs: 'Metres', metre: 'Metres', metres: 'Metres', meter: 'Metres', meters: 'Metres', m: 'Metres', box: 'Boxes', boxes: 'Boxes', pack: 'Boxes', packs: 'Boxes', bag: 'Nos', bags: 'Nos', roll: 'Nos', rolls: 'Nos', pair: 'Nos', pairs: 'Nos', set: 'Sets', sets: 'Sets' };
const num = (s) => Number(String(s).replace(/[,₹]/g, '').replace(/^Rs\.?/i, ''));
const NUM = /^(?:₹|Rs\.?)?\d{1,3}(?:,\d{2,3})*(?:\.\d+)?$|^(?:₹|Rs\.?)?\d+(?:\.\d+)?$/;

export function parseLine(raw) {
  let line = raw.replace(/[|_]+/g, ' ').replace(/\s{2,}/g, '  ').trim();
  if (line.length < 4 || SKIP.test(line)) return null;
  line = line.replace(/^\s*\d{1,3}[.)]?\s+(?=[A-Za-z])/, ''); // serial number
  const toks = line.split(/\s+/);
  const nums = []; let end = toks.length;
  while (end > 0 && (NUM.test(toks[end - 1]) || UOMS[toks[end - 1].toLowerCase()] || /^[%x×]$/i.test(toks[end - 1]))) {
    if (NUM.test(toks[end - 1])) nums.unshift(num(toks[end - 1]));
    end--;
    if (nums.length === 4) break;
  }
  if (!nums.length || end === 0) return null;
  const uomTok = toks.slice(end).find((t) => UOMS[t.toLowerCase()]);
  let item = toks.slice(0, end).join(' ').replace(/[-–:,.\s]+$/, '');
  // a unit of measure written straight after the name ("Bulb 9W  10 Nos  45  450")
  if (!/[A-Za-z]{2}/.test(item)) return null;
  let qty = 1; let rate = 0; let amount = 0;
  if (nums.length >= 3) {
    amount = nums[nums.length - 1]; rate = nums[nums.length - 2]; qty = nums[nums.length - 3];
    if (Math.abs(qty * rate - amount) > Math.max(1, amount * 0.02)) { // not qty x rate = amount: maybe a tax column in between
      const alt = nums.slice(-4);
      if (alt.length === 4 && Math.abs(alt[0] * alt[1] - alt[3]) <= Math.max(1, alt[3] * 0.2)) { qty = alt[0]; rate = alt[1]; amount = alt[3]; }
    }
  } else if (nums.length === 2) {
    if (Number.isInteger(nums[0]) && nums[0] < 1000 && nums[1] >= nums[0]) { qty = nums[0]; amount = nums[1]; rate = Math.round((amount / qty) * 100) / 100; }
    else { rate = nums[0]; amount = nums[1]; qty = 1; }
  } else { amount = nums[0]; rate = amount; qty = 1; }
  if (!(amount > 0) || qty <= 0 || qty > 100000) return null;
  return { item: item.replace(/\s+/g, ' ').slice(0, 80), quantity: qty, uom: UOMS[(uomTok || '').toLowerCase()] || 'Nos', rate, amount };
}

export function parseInvoice(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const head = lines.slice(0, 12);
  const vendor = (head.find((l) => /[A-Za-z]{3}/.test(l) && !SKIP.test(l) && !/^\W*\d/.test(l)) || '').replace(/[^\w &.,'-]/g, '').trim().slice(0, 60);
  const inv = /(?:invoice|bill|inv)\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9/\-]{2,})/i.exec(text || '');
  const d = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(text || '');
  let date = '';
  if (d) { // Indian invoices write day/month/year
    let [, a, b, y] = d; if (y.length === 2) y = `20${y}`;
    let day = Number(a); let mon = Number(b); if (mon > 12 && day <= 12) [day, mon] = [mon, day];
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) date = `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const items = lines.map(parseLine).filter(Boolean);
  return { vendor, invoiceNo: inv?.[1] || '', date, items };
}
