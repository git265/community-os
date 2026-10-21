// Parses a spreadsheet someone uploaded, away from the app (see xlsxRead.js): whatever a crafted file does to this worker's objects, or however
// long it makes the parser run, stays here. Answers with the parsed workbook (plain data) or an error message.
import * as XLSX from 'xlsx';

self.onmessage = (e) => {
  try { self.postMessage({ wb: XLSX.read(e.data.data, e.data.opts) }); }
  catch (err) { self.postMessage({ error: err?.message || String(err) }); }
};
