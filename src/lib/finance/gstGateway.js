import { backendFetch } from '../storage/dataSource.js';
import { resolveSlug } from '../community.js';
// Where GST questions are answered. The app asks through this one interface, so a real GST service provider (GSP) can replace the
// simulator without touching any screen. The browser never holds GSP credentials or the taxpayer's GST session: it talks to YOUR
// Spring Boot service (same pattern as the payment gateway), which holds them and calls the GSP.
//
//   lookupInvoice({ gstin, invoiceNo, date, gstAmount }) -> { found, filedOn?, amountMatches?, source }
//   lookupGstin(gstin)                                    -> { valid, legalName?, tradeName?, status?, state?, source }
//   ping()                                                -> { ok, label, detail? }
//
// Server contract (see docs/GST_API.md):
//   GET  {base}/gst/health
//   GET  {base}/gst/gstin/{gstin}
//   POST {base}/gst/inward/lookup    { gstin, invoiceNo, date, gstAmount, source: 'GSTR-2B' | 'GSTR-2A' }
export const simulatedGst = {
  id: 'simulated',
  label: 'Demo GST portal (simulated)',
  /** Demo rule: an invoice number ending in 0 or X was "not filed by the vendor". Everything else is found. */
  async lookupInvoice({ invoiceNo }) {
    const n = String(invoiceNo || '').trim();
    return { found: !!n && !/[0xX]$/.test(n), source: 'simulated' };
  },
  async lookupGstin(gstin) { return { valid: true, legalName: '(demo) name not looked up', status: 'Active', source: 'simulated' }; },
  async ping() { return { ok: true, label: this.label, detail: 'Demo mode: answers are made up by a simple rule.' }; },
};

/** The production adapter: your server answers; nothing secret lives in the browser. */
export function httpGstGateway({ base = '/api', source = 'GSTR-2B' } = {}) {
  const call = async (path, init) => {
    const r = await backendFetch(path, init, resolveSlug(), base);
    if (!r.ok) throw new Error(`GST service ${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`.trim());
    if (!/json/i.test(r.headers.get('content-type') || '')) throw new Error('That address did not answer like a GST service. Check the address.');
    return r.json();
  };
  return {
    id: 'http',
    label: `GST service at ${base} (${source})`,
    lookupInvoice: (q) => call('/gst/inward/lookup', { method: 'POST', body: JSON.stringify({ ...q, source }) }).then((x) => ({ source, ...x })),
    lookupGstin: (g) => call(`/gst/gstin/${encodeURIComponent(g)}`).then((x) => ({ source, ...x })),
    async ping() { const x = await call('/gst/health'); return { ok: x.ok !== false, label: x.provider || 'GST service', detail: x.detail || '' }; },
  };
}

let active = simulatedGst;
export const registerGstGateway = (g) => { active = g; };
export const gstGateway = () => active;
/** Apply the Super Admin's choice in Tax split / Input credit: Simulated, or Live (your server). */
export function applyGstSettings(s = {}) {
  if (s.gstApiMode === 'Live' && String(s.gstApiUrl || '').trim()) registerGstGateway(httpGstGateway({ base: String(s.gstApiUrl).trim().replace(/\/$/, ''), source: s.gstApiSource || 'GSTR-2B' }));
  else registerGstGateway(simulatedGst);
  return active;
}
