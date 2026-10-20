import React, { useMemo, useState } from 'react';
import { useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import { buildGstReport, fyOptions, fyLabel } from '../../lib/finance/gstReport.js';
import { downloadCsv } from '../../lib/finance/csv.js';
import { inr } from '../../lib/finance/rules.js';
import { Kpi } from '../gate/gateUi.jsx';
import { communityTaxId } from '../../lib/locale.js';

const mlabel = (k) => new Date(`${k}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

/** Reports → GST report: tax collected on what the community sells, tax paid to vendors that can be claimed back, and the net, month by month. */
export default function GstReport() {
  const { records: ledger } = useCollection(C.LEDGER, 'Payments Cross-check');
  const { records: vendors } = useCollection(C.VENDORS, 'Vendors');
  const { records: tax } = useCollection(C.TAX_SETTINGS, 'Tax split settings');
  const years = useMemo(() => fyOptions(ledger), [ledger]);
  const [fy, setFy] = useState(null);
  const year = fy ?? years[0];
  const rep = useMemo(() => buildGstReport({ ledger, vendors, fy: year }), [ledger, vendors, year]);
  const t = rep.totals; const registered = tax[0]?.registered === 'Yes';
  const name = `gst-${fyLabel(year)}`;
  const monthRows = rep.months.map((x) => [mlabel(x.month), x.outTaxable, x.outGst / 2, x.outGst / 2, x.inGst, x.inClaimable, x.inAtRisk, x.net]);
  return (
    <div data-testid="gst-report">
      <div className="notice" style={{ marginBottom: 10 }}>
        {registered ? `GSTIN ${communityTaxId() || '(add it in Community setup)'}.` : <b>The society is set as not registered for GST, so nothing here is payable or claimable. The figures show what would apply.</b>} A working report from the ledger for your treasurer and CA. It is not a return filing.
      </div>
      <div className="gg-row" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <label className="field" style={{ margin: 0 }}><span className="muted">Financial year</span>
          <select data-testid="gst-fy" value={year} onChange={(e) => setFy(Number(e.target.value))}>{years.map((y) => <option key={y} value={y}>{fyLabel(y)}</option>)}</select></label>
        <button type="button" className="btn secondary sm" data-testid="gst-csv-summary" onClick={() => downloadCsv(`${name}-summary`, ['Month', 'Taxable sales', 'CGST collected', 'SGST collected', 'GST paid to vendors', 'Claimable (verified)', 'At risk', 'Net payable'], monthRows)}>Download summary</button>
        <button type="button" className="btn secondary sm" data-testid="gst-csv-out" onClick={() => downloadCsv(`${name}-outward`, ['Date', 'Ref', 'Description', 'Unit', 'Taxable', 'Rate %', 'CGST', 'SGST', 'IGST', 'Invoice total'], rep.outward.map((x) => [x.date, x.ref, x.description, x.unit, x.taxable, x.rate, x.cgst, x.sgst, x.igst, x.total]))}>Sales (GSTR-1 style)</button>
        <button type="button" className="btn secondary sm" data-testid="gst-csv-in" onClick={() => downloadCsv(`${name}-inward`, ['Date', 'Ref', 'Vendor', 'Vendor GSTIN', 'Invoice no.', 'Taxable', 'GST', 'Credit check', 'Claimable'], rep.inward.map((x) => [x.date, x.ref, x.vendor, x.gstin, x.invoiceNo, x.taxable, x.gst, x.status, x.claimable ? 'Yes' : 'No']))}>Purchases and credit</button>
      </div>
      <div className="gg-kpis">
        <Kpi label="GST collected" short="Collected" value={inr(t.outGst)} sub={`on ${inr(t.outTaxable)} sales`} />
        <Kpi label="Credit claimable" short="Claimable" value={inr(t.inClaimable)} sub="vendor filing verified" />
        <Kpi label="Credit at risk" short="At risk" value={inr(t.inAtRisk)} warn={t.inAtRisk > 0} sub={t.inUnchecked ? `${inr(t.inUnchecked)} not checked` : ''} />
        <Kpi label="Net payable" short="Net" value={inr(t.net)} sub={t.net < 0 ? 'credit carried forward' : 'collected less claimable'} />
      </div>
      {rep.months.length === 0 ? <div className="empty" data-testid="gst-empty">No GST in the ledger for {fyLabel(year)}.</div> : (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="resp-table" data-testid="gst-months"><thead><tr><th>Month</th><th>Taxable sales</th><th>CGST</th><th>SGST</th><th>Paid to vendors</th><th>Claimable</th><th>At risk</th><th>Net payable</th></tr></thead>
            <tbody>{rep.months.map((x) => <tr key={x.month} data-testid="gst-month"><td data-label="Month">{mlabel(x.month)}</td><td data-label="Taxable sales">{inr(x.outTaxable)}</td><td data-label="CGST">{inr(x.outGst / 2)}</td><td data-label="SGST">{inr(x.outGst / 2)}</td><td data-label="Paid to vendors">{inr(x.inGst)}</td><td data-label="Claimable">{inr(x.inClaimable)}</td><td data-label="At risk">{inr(x.inAtRisk)}</td><td data-label="Net payable"><b>{inr(x.net)}</b></td></tr>)}</tbody></table>
        </div>
      )}
      <details style={{ marginTop: 10 }}><summary>Sales with GST ({rep.outward.length})</summary>
        {rep.outward.length === 0 ? <p className="muted">None.</p> : <ul className="list" style={{ display: 'block' }}>{rep.outward.map((x, i) => <li key={i} style={{ display: 'block', padding: '6px 0' }}><b>{x.description}</b><br /><small className="muted">{x.date} · {x.unit || 'no unit'} · taxable {inr(x.taxable)} · GST {x.rate}% = {inr(x.cgst + x.sgst)}</small></li>)}</ul>}
      </details>
      <details style={{ marginTop: 6 }}><summary>Purchases with GST ({rep.inward.length})</summary>
        {rep.inward.length === 0 ? <p className="muted">None.</p> : <ul className="list" style={{ display: 'block' }}>{rep.inward.map((x, i) => <li key={i} style={{ display: 'block', padding: '6px 0' }}><b>{x.vendor || 'No vendor'}</b> <span className="tag">{x.status}</span><br /><small className="muted">{x.date} · {x.invoiceNo || 'no invoice no.'} · GST {inr(x.gst)}{x.gstin ? ` · ${x.gstin}` : ''}</small></li>)}</ul>}
      </details>
    </div>
  );
}
