// Upload validation + malware screening.
//
// HONEST SCOPE: a browser cannot run a real antivirus engine. What this layer
// does (all client-side, all bypassable):
//   1. allow-list by extension AND MIME type            (pdf, xls/xlsx, txt/csv, images)
//   2. max size
//   3. magic-byte check - the file's real signature must match its extension
//      (a .exe renamed to .pdf is rejected)
//   4. block active content inside "documents" (PDF /JavaScript, /Launch, /EmbeddedFile,
//      Office macros: vbaProject.bin) - these are how most document malware runs
//   5. EICAR antivirus test-string detection (proves the pipeline end to end)
//   6. a pluggable `scanRemote()` hook: when VITE_SCAN_URL is set, the file is
//      POSTed to the backend, which must run ClamAV (clamd INSTREAM) before the
//      bytes are stored. Until then status is 'checked-locally', never 'clean'.
//
// Production: the Spring Boot upload endpoint MUST re-validate and scan
// server-side (ClamAV) and quarantine on failure. Never trust this file's result.

export const ALLOWED_TYPES = [
  { ext: ['pdf'], mime: ['application/pdf'], label: 'PDF', magic: [[0x25, 0x50, 0x44, 0x46]] }, // %PDF
  { ext: ['xls'], mime: ['application/vnd.ms-excel'], label: 'Excel (.xls)', magic: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] }, // OLE2
  { ext: ['xlsx'], mime: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], label: 'Excel (.xlsx)', magic: [[0x50, 0x4b, 0x03, 0x04]] }, // ZIP
  { ext: ['doc'], mime: ['application/msword'], label: 'Word (.doc)', magic: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] }, // OLE2
  { ext: ['docx'], mime: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], label: 'Word (.docx)', magic: [[0x50, 0x4b, 0x03, 0x04]] }, // ZIP
  { ext: ['ppt'], mime: ['application/vnd.ms-powerpoint'], label: 'PowerPoint (.ppt)', magic: [[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]] },
  { ext: ['pptx'], mime: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], label: 'PowerPoint (.pptx)', magic: [[0x50, 0x4b, 0x03, 0x04]] },
  { ext: ['rtf'], mime: ['application/rtf', 'text/rtf'], label: 'Rich text (.rtf)', magic: [[0x7b, 0x5c, 0x72, 0x74, 0x66]] }, // {\rtf
  { ext: ['txt', 'csv'], mime: ['text/plain', 'text/csv', 'application/vnd.ms-excel'], label: 'Text / CSV', magic: null, text: true },
  { ext: ['png'], mime: ['image/png'], label: 'PNG image', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  { ext: ['jpg', 'jpeg'], mime: ['image/jpeg'], label: 'JPEG image', magic: [[0xff, 0xd8, 0xff]] },
  { ext: ['webp'], mime: ['image/webp'], label: 'WebP image', magic: [[0x52, 0x49, 0x46, 0x46]] }, // RIFF
  { ext: ['gif'], mime: ['image/gif'], label: 'GIF image', magic: [[0x47, 0x49, 0x46, 0x38]] },
];
export const ATTACHMENT_ACCEPT = '.pdf,.xls,.xlsx,.doc,.docx,.ppt,.pptx,.rtf,.txt,.csv,.png,.jpg,.jpeg,.gif,.webp,image/*';
export const ATTACHMENT_HELP = 'Images, PDF, Word, Excel, PowerPoint, RTF, text/CSV';
export const DOCUMENT_ACCEPT = '.pdf,.xls,.xlsx,.doc,.docx,.ppt,.pptx,.rtf,.txt,.csv';
export const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file (files are kept in IndexedDB in this demo); the backend limit is configurable

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);
const latin1 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };

/** Returns { ok, status, reason?, type? }. status: 'rejected' | 'checked-locally' | 'clean' (clean only via remote scanner). */
export async function validateFile(file, { allowImages = false } = {}) {
  const ext = extOf(file.name);
  const type = ALLOWED_TYPES.find((t) => t.ext.includes(ext) && (allowImages || !t.label.includes('image')));
  if (!type) return { ok: false, status: 'rejected', reason: `.${ext || '?'} files are not allowed. Allowed: PDF, XLS/XLSX, DOC/DOCX, TXT/CSV${allowImages ? ', PNG/JPG/GIF' : ''}.` };
  if (file.size === 0) return { ok: false, status: 'rejected', reason: 'The file is empty.' };
  if (file.size > MAX_BYTES) return { ok: false, status: 'rejected', reason: `File is larger than ${MAX_BYTES / 1024 / 1024} MB.` };
  if (file.type && !type.mime.includes(file.type) && file.type !== 'application/octet-stream') {
    return { ok: false, status: 'rejected', reason: `File type "${file.type}" does not match .${ext}.` };
  }

  const buf = new Uint8Array(await file.arrayBuffer());
  if (type.magic && !type.magic.some((sig) => startsWith(buf, sig))) {
    return { ok: false, status: 'rejected', reason: `The file content is not a real ${type.label} (signature mismatch).` };
  }
  if (type.text && buf.subarray(0, 4096).includes(0)) {
    return { ok: false, status: 'rejected', reason: 'Binary data found in a text file.' };
  }

  const text = latin1(buf);
  if (text.includes(EICAR)) return { ok: false, status: 'rejected', reason: 'Malware signature detected (EICAR test virus). File blocked.' };
  if (ext === 'pdf' && /\/(JavaScript|JS|Launch|EmbeddedFile|OpenAction)\b/.test(text)) {
    return { ok: false, status: 'rejected', reason: 'PDF contains active content (scripts / launch actions / embedded files). File blocked.' };
  }
  if ((ext === 'docx' || ext === 'xlsx') && /vbaProject\.bin/.test(text)) return { ok: false, status: 'rejected', reason: 'Spreadsheet contains macros. File blocked.' };
  if ((ext === 'xls' || ext === 'doc') && /_VBA_PROJECT|Macros\x00/.test(text)) return { ok: false, status: 'rejected', reason: 'Spreadsheet contains macros. File blocked.' };

  const remote = await scanRemote(file);
  if (remote && !remote.ok) return { ok: false, status: 'rejected', reason: remote.reason || 'The virus scanner rejected this file.' };
  return { ok: true, status: remote ? 'clean' : 'checked-locally', type };
}

const SCAN_URL = import.meta.env.VITE_SCAN_URL;
/** Backend ClamAV hook: POST multipart `file` -> { clean: boolean, signature?: string }. */
async function scanRemote(file) {
  if (!SCAN_URL) return null;
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(SCAN_URL, { method: 'POST', body: fd });
  if (!res.ok) return { ok: false, reason: 'Virus scan service unavailable - upload blocked.' };
  const out = await res.json();
  return out.clean ? { ok: true } : { ok: false, reason: `Virus detected${out.signature ? ` (${out.signature})` : ''}. File blocked.` };
}

export function fileToBase64Url(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
