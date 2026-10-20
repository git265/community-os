// Turn an uploaded plan (a PDF of the layout, or a photo / scan / drawing image) into a web-sized picture the map can draw.
// Large drawings are shrunk to MAX_W pixels wide; "lighten" fades the linework to a soft grey underlay so coloured pins stand out.
// Nothing leaves the browser. (Later the picture goes to the file store with the other uploads; the plan row just keeps its address.)

export const MAX_W = 3200;
const MAX_CHARS = 2_400_000; // keep one plan well inside the browser's session-storage budget

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as a picture.')); };
    img.src = url;
  });
}

async function pdfFirstPage(file) {
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(4, MAX_W / base.width);
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return c;
}

const MAX_SRC = 4800; // the working copy kept while the person trims the sheet

/** Read the uploaded file once into a working picture, plus a small preview for the trim screen. */
export async function loadPlanSource(file) {
  if (!file) throw new Error('Choose a file first.');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let src;
  if (isPdf) src = await pdfFirstPage(file);
  else if (/^image\//.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)) src = await loadImage(file);
  else throw new Error('Upload a PDF or an image (JPG, PNG or WebP).');
  const sw = src.width || src.naturalWidth; const sh = src.height || src.naturalHeight;
  if (!sw || !sh) throw new Error('The file looks empty.');
  const k = Math.min(1, MAX_SRC / sw);
  const work = document.createElement('canvas'); work.width = Math.round(sw * k); work.height = Math.round(sh * k);
  const g = work.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, work.width, work.height); g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, work.width, work.height);
  const pv = document.createElement('canvas'); const pk = Math.min(1, 900 / work.width); pv.width = Math.round(work.width * pk); pv.height = Math.round(work.height * pk);
  pv.getContext('2d').drawImage(work, 0, 0, pv.width, pv.height);
  return { work, width: work.width, height: work.height, preview: pv.toDataURL('image/jpeg', 0.7) };
}

/** Trim (fractions 0-1 off each side), shrink to MAX_W, optionally fade to a grey underlay -> { imageUrl (data URL), width, height }. */
export function renderPlan(source, { crop = {}, lighten = true } = {}) {
  const l = Math.max(0, Math.min(0.9, crop.l || 0)); const t = Math.max(0, Math.min(0.9, crop.t || 0));
  const r = Math.max(0, Math.min(0.9, crop.r || 0)); const b = Math.max(0, Math.min(0.9, crop.b || 0));
  if (l + r > 0.92 || t + b > 0.92) throw new Error('The trim leaves almost nothing of the plan.');
  const sx = Math.round(source.width * l); const sy = Math.round(source.height * t);
  const sw = Math.round(source.width * (1 - l - r)); const sh = Math.round(source.height * (1 - t - b));
  let w = Math.min(MAX_W, sw);
  for (let attempt = 0; attempt < 4; attempt++) {
    const h = Math.round((sh * w) / sw);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); g.imageSmoothingQuality = 'high'; g.drawImage(source.work, sx, sy, sw, sh, 0, 0, w, h);
    if (lighten) {
      const d = g.getImageData(0, 0, w, h); const px = d.data;
      for (let i = 0; i < px.length; i += 4) {
        const grey = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) / 255;
        const p = Math.min(1, Math.max(0, (grey - 0.45) / 0.52)); // 0 = ink, 1 = paper
        const o = 0.58 + 0.42 * p;
        px[i] = Math.round(o * 237); px[i + 1] = Math.round(o * 245); px[i + 2] = Math.round(o * 255);
      }
      g.putImageData(d, 0, 0);
    }
    for (const q of [0.82, 0.7, 0.58]) {
      const url = c.toDataURL('image/jpeg', q);
      if (url.length <= MAX_CHARS) return { imageUrl: url, width: w, height: h };
    }
    w = Math.round(w * 0.8);
  }
  throw new Error('The plan is too detailed to keep in the browser. Trim it or upload a smaller version.');
}

/** One-step version (no trim). */
export async function fileToPlanImage(file, { lighten = true } = {}) { return renderPlan(await loadPlanSource(file), { lighten }); }
