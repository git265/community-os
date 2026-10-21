// Reading an uploaded spreadsheet (.xlsx / .xls / .csv) - the ONE place the app parses one.
//
// The parser (SheetJS 0.18.5, the last version on npm) has two published flaws that a crafted file can trigger while it is read: prototype
// pollution (CVE-2023-30533) and a regular-expression slowdown (CVE-2024-22363). Both are fixed in SheetJS 0.20.2+, which is published only on
// cdn.sheetjs.com (npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz). Until then the file is parsed in a Web Worker: polluting the
// worker's Object.prototype cannot touch the app's (the workbook comes back as a structured clone - plain data), and a parse that runs too long
// is stopped. Writing exports is unaffected (the app writes its own data).
const LIMIT_MS = 30000;

/** XLSX.read(data, opts) in a worker. `data` is an ArrayBuffer (opts.type 'array'). */
export async function readWorkbook(data, opts = { type: 'array' }) {
  if (typeof Worker === 'undefined') {                       // no workers (tests, very old browsers): the old way
    const XLSX = await import('xlsx');
    return XLSX.read(data, opts);
  }
  const worker = new Worker(new URL('./xlsxWorker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    const done = (fn) => (x) => { clearTimeout(timer); worker.terminate(); fn(x); };
    const timer = setTimeout(done(reject), LIMIT_MS, new Error('This file took too long to read. Save it again from Excel (as .xlsx) and try once more.'));
    worker.onmessage = done((e) => (e.data?.error ? reject(new Error(`This file could not be read: ${e.data.error}`)) : resolve(e.data.wb)));
    worker.onerror = done(() => reject(new Error('This file could not be read.')));
    const bytes = data instanceof ArrayBuffer ? data : data?.buffer instanceof ArrayBuffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data;
    worker.postMessage({ data: bytes, opts }, bytes instanceof ArrayBuffer ? [bytes] : []);
  });
}
