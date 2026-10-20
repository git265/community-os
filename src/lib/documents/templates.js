// Printable documents as self-contained HTML (A4). One stylesheet, one letterhead, used by every receipt and statement,
// so they all look like they came from the same office. Pure functions: pass data in, get a string out.
import { money } from '../locale.js';
import { region } from '../region/regions.js';

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const dmy = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
export const hm = (iso) => (iso && String(iso).length > 10 ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
export const dateTime = (iso) => (iso ? `${dmy(iso)}${hm(iso) ? `, ${hm(iso)}` : ''}` : '');

const CSS = `*{box-sizing:border-box}body{font:13px/1.45 'Helvetica Neue',Arial,sans-serif;color:#1f2937;margin:0;padding:28px;background:#fff}
.doc{max-width:720px;margin:auto}.lh{display:flex;justify-content:space-between;gap:16px;border-bottom:3px solid #2f6fd6;padding-bottom:12px;margin-bottom:16px}
.lh h1{margin:0;font-size:19px;color:#1d3f7a}.lh .sub{color:#6b7280;font-size:12px;white-space:pre-line}.title{text-align:right}.title b{display:block;font-size:20px;letter-spacing:.06em;color:#2f6fd6}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;margin:10px 0 14px}.meta div span{display:block;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
table{width:100%;border-collapse:collapse;margin:8px 0}th{background:#f1f5fb;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#475569}th,td{padding:7px 8px;border-bottom:1px solid #e5e7eb}
.r{text-align:right;white-space:nowrap}.tot td{font-weight:700;border-top:2px solid #1f2937;border-bottom:none}.sub-row td{color:#6b7280;font-size:12px}
.stamp{display:inline-block;border:2px solid #1f9d55;color:#1f9d55;font-weight:700;letter-spacing:.12em;padding:2px 10px;border-radius:6px;transform:rotate(-4deg);margin:6px 0}
.stamp.due{border-color:#c7364a;color:#c7364a}.box{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:8px 12px;margin:10px 0;font-size:12px}
.sign{display:flex;justify-content:space-between;margin-top:34px;font-size:12px;color:#6b7280}.sign div{border-top:1px solid #9ca3af;padding-top:4px;min-width:180px;text-align:center}
.foot{margin-top:18px;border-top:1px solid #e5e7eb;padding-top:8px;color:#6b7280;font-size:11px;text-align:center}
@media print{body{padding:0}.doc{max-width:none}}`;

const head = (lh, title, no) => `<div class="lh"><div><h1>${esc(lh.name)}</h1><div class="sub">${esc([lh.address, [lh.regNo && `Reg. no. ${lh.regNo}`, lh.pan && `PAN ${lh.pan}`, lh.taxId && `${lh.taxLabel} ${lh.taxId}`].filter(Boolean).join(' · '), [lh.phone, lh.email, lh.website].filter(Boolean).join(' · ')].filter(Boolean).join('\n'))}</div></div><div class="title"><b>${esc(title)}</b>${no ? `<span>No. ${esc(no)}</span>` : ''}</div></div>`;
const wrap = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="doc">${body}</div></body></html>`;
const how = (lh) => (lh.payHow ? `<div class="box"><b>How to pay</b><div style="white-space:pre-line">${esc(lh.payHow)}</div></div>` : '');
const foot = (lh) => `<div class="sign"><span>${esc(lh.thanks || 'Received with thanks')}</span><div>${esc(lh.signatory)}</div></div><div class="foot">${esc(lh.footer)}</div>`;

/**
 * Receipt. `lines`: [{label, amount, sub?}] (sub = indented tax rows), `total`, `paid` (false => "Invoice / payment due" stamp).
 * `taxLines` come from billText.taxBreakdown(). `payment`: {mode, ref, at (ISO), by}. `extra`: [{label, value}] shown in a box.
 */
export function receiptHtml({ lh, kind = 'Receipt', no, unit, payer, forWhat, issuedAt, lines = [], total, paid = true, payment = {}, taxNote = '', extra = [], note = '' }) {
  const rows = lines.map((l) => `<tr class="${l.sub ? 'sub-row' : ''}"><td>${l.sub ? '&nbsp;&nbsp;&nbsp;' : ''}${esc(l.label)}</td><td class="r">${l.amount == null ? '' : esc(money(l.amount))}</td></tr>`).join('');
  return wrap(`${kind} ${no || ''}`, `${head(lh, kind.toUpperCase(), no)}
<div class="meta"><div><span>${paid ? 'Received from' : 'Billed to'}</span><b>${esc(payer || '—')}</b></div><div><span>Unit</span><b>${esc(unit || '—')}</b></div>
<div><span>For</span><b>${esc(forWhat || '—')}</b></div><div><span>${paid ? 'Date & time' : 'Issued'}</span><b>${esc(dateTime(issuedAt))}</b></div></div>
<table><thead><tr><th>Description</th><th class="r">Amount (${esc(region().currency.code)})</th></tr></thead><tbody>${rows}<tr class="tot"><td>${paid ? 'Total received' : 'Total payable'}</td><td class="r">${esc(money(total))}</td></tr></tbody></table>
${taxNote ? `<div class="box">${esc(taxNote)}</div>` : ''}
${paid ? `<div class="box"><b>Payment</b> · ${esc(payment.mode || '—')}${payment.ref ? ` · Ref ${esc(payment.ref)}` : ''}${payment.at ? ` · ${esc(dateTime(payment.at))}` : ''}${payment.by ? ` · Recorded by ${esc(payment.by)}` : ''}</div>` : ''}
${extra.length ? `<div class="box">${extra.map((e) => `<div><span style="color:#6b7280">${esc(e.label)}:</span> ${esc(e.value)}</div>`).join('')}</div>` : ''}
<div class="stamp ${paid ? '' : 'due'}">${paid ? 'PAID' : 'PAYMENT DUE'}</div>${note ? `<div class="box">${esc(note)}</div>` : ''}${paid ? '' : how(lh)}${foot(lh)}`);
}

/** Statement of account for a unit: opening balance, dated entries with running balance, closing balance. */
export function statementHtml({ lh, unit, owner, from, to, opening, rows, closing, summary, generatedAt }) {
  const body = rows.map((r) => `<tr><td>${esc(dmy(r.date))}</td><td>${esc(r.ref || '')}</td><td>${esc(r.desc)}</td><td class="r">${r.debit ? esc(money(r.debit)) : ''}</td><td class="r">${r.credit ? esc(money(r.credit)) : ''}</td><td class="r">${esc(money(r.balance))}</td></tr>`).join('');
  return wrap(`Statement ${unit}`, `${head(lh, 'STATEMENT OF ACCOUNT')}
<div class="meta"><div><span>Unit</span><b>${esc(unit)}</b></div><div><span>Account holder</span><b>${esc(owner || '—')}</b></div><div><span>Period</span><b>${esc(dmy(from))} – ${esc(dmy(to))}</b></div><div><span>Generated</span><b>${esc(dateTime(generatedAt))}</b></div></div>
<table><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th class="r">Billed</th><th class="r">Paid / credit</th><th class="r">Balance</th></tr></thead><tbody>
<tr class="sub-row"><td colspan="5">Opening balance</td><td class="r">${esc(money(opening))}</td></tr>${body || '<tr><td colspan="6" style="text-align:center;color:#6b7280">No activity in this period.</td></tr>'}
<tr class="tot"><td colspan="5">Closing balance ${closing > 0 ? '(amount due)' : closing < 0 ? '(in credit)' : ''}</td><td class="r">${esc(money(closing))}</td></tr></tbody></table>
<div class="box">${summary.map((s) => `<span style="margin-right:18px"><span style="color:#6b7280">${esc(s.label)}:</span> <b>${esc(money(s.value))}</b></span>`).join('')}</div>
<div class="stamp ${closing > 0 ? 'due' : ''}">${closing > 0 ? 'BALANCE DUE' : 'NO BALANCE DUE'}</div>${lh.statementNote ? `<div class="box" style="white-space:pre-line">${esc(lh.statementNote)}</div>` : ''}${closing > 0 ? how(lh) : ''}${foot(lh)}`);
}
