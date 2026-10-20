// An event brochure as one self-contained printable HTML document (A4 pages). Pictures are inlined, so the file works anywhere:
// print to PDF, e-mail it, or share it. Pure: pass the data in, get a string out.
import { money } from '../locale.js';

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const d1 = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const wd = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' }) : '');
export const eventWhen = (ev) => `${d1(ev.startDate)}${ev.endDate && ev.endDate !== ev.startDate ? ` – ${d1(ev.endDate)}` : ''}${ev.startTime ? ` · ${ev.startTime}${ev.endTime ? `–${ev.endTime}` : ''}` : ''}`;

const CSS = `*{box-sizing:border-box}body{margin:0;background:#e9edf3;font:14px/1.5 'Helvetica Neue',Arial,sans-serif;color:#1f2937}
.pg{width:794px;max-width:100%;min-height:1000px;margin:14px auto;background:#fff;padding:44px 48px;box-shadow:0 1px 6px rgba(0,0,0,.12);page-break-after:always;position:relative}
.pg h2{margin:0 0 10px;font-size:26px;color:#1d3f7a}.pg p{margin:0 0 10px;white-space:pre-line}.pg img{max-width:100%;border-radius:10px;display:block}
.cover{padding:0;overflow:hidden}.cover .hero{width:100%;height:520px;object-fit:cover;border-radius:0}.cover .cv{padding:30px 48px}.cover h1{margin:0;font-size:40px;color:#1d3f7a;line-height:1.1}
.cover .when{color:#2f6fd6;font-weight:700;font-size:17px;margin-top:8px}.cover .tag{color:#6b7280;margin-top:12px;font-size:16px;white-space:pre-line}.cvplain{background:linear-gradient(135deg,#1d3f7a,#2f6fd6);height:300px}
.row{display:flex;gap:22px;align-items:flex-start}.row img{width:46%;flex:none}.row.right{flex-direction:row-reverse}
.day{margin:14px 0 4px;font-weight:700;color:#2f6fd6;font-size:15px;border-bottom:2px solid #dbe5f5;padding-bottom:3px}
.it{display:flex;gap:14px;padding:6px 0;border-bottom:1px solid #eef1f5}.it .t{width:110px;flex:none;color:#475569;font-variant-numeric:tabular-nums}.it small{color:#6b7280;display:block}
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-top:10px}.grid img{width:100%;height:200px;object-fit:cover}
.ft{position:absolute;left:48px;right:48px;bottom:18px;color:#9ca3af;font-size:11px;display:flex;justify-content:space-between}
@media print{body{background:#fff}.pg{margin:0;box-shadow:none;width:auto;min-height:0;height:100vh;padding:36px 40px}}`;

/**
 * pages: brochure rows in order. urls: { [fileId]: picture URL }. programs/offerings/photos: the event's own rows.
 * Auto pages (Programme, Offerings, Photos) fill themselves from the event, so they never go stale.
 */
export function brochureHtml({ lh, ev, pages = [], programs = [], offerings = [], photos = [], urls = {} }) {
  const img = (p, cls = '') => (p.fileId && urls[p.fileId] ? `<img class="${cls}" src="${esc(urls[p.fileId])}" alt="${esc(p.heading || p.imageName || '')}">` : '');
  const foot = `<div class="ft"><span>${esc(ev.name)}</span><span>${esc(lh?.name || '')}</span></div>`;
  const out = pages.map((p) => {
    if (p.kind === 'Cover') {
      return `<section class="pg cover">${img(p, 'hero') || '<div class="cvplain"></div>'}<div class="cv"><h1>${esc(p.heading || ev.name)}</h1><div class="when">${esc(eventWhen(ev))}${ev.venue ? ` · ${esc(ev.venue)}` : ''}</div>${p.body ? `<div class="tag">${esc(p.body)}</div>` : ''}</div></section>`;
    }
    if (p.kind === 'Programme') {
      const by = {}; programs.forEach((x) => { (by[x.date] = by[x.date] || []).push(x); });
      const days = Object.keys(by).sort().map((day) => `<div class="day">${esc(wd(day))}</div>${by[day].sort((a, b) => String(a.startTime).localeCompare(String(b.startTime))).map((x) => `<div class="it"><div class="t">${esc(x.startTime || '')}${x.endTime ? `–${esc(x.endTime)}` : ''}</div><div><b>${esc(x.title)}</b>${x.lead || x.venue ? `<small>${esc([x.lead, x.venue].filter(Boolean).join(' · '))}</small>` : ''}${x.notes ? `<small>${esc(x.notes)}</small>` : ''}</div></div>`).join('')}`).join('');
      return `<section class="pg"><h2>${esc(p.heading || 'Programme')}</h2>${p.body ? `<p>${esc(p.body)}</p>` : ''}${days || '<p>The programme will be announced soon.</p>'}${foot}</section>`;
    }
    if (p.kind === 'Offerings') {
      const items = offerings.map((o) => `<div class="it"><div class="t">${esc(o.day || '')}</div><div><b>${esc(o.title)}</b>${o.description ? `<small>${esc(o.description)}</small>` : ''}</div>${Number(o.pledgeValue) > 0 ? `<div style="margin-left:auto"><b>${esc(money(o.pledgeValue))}</b></div>` : ''}</div>`).join('');
      return `<section class="pg"><h2>${esc(p.heading || 'Seva offerings')}</h2>${p.body ? `<p>${esc(p.body)}</p>` : ''}${items || '<p>Offerings will be announced soon.</p>'}${foot}</section>`;
    }
    if (p.kind === 'Photos') {
      const shown = photos.slice(0, 6).map((x) => `<img src="${esc(urls[`photo:${x.id}`] || x.thumb)}" alt="${esc(x.caption || '')}">`).join('');
      return `<section class="pg"><h2>${esc(p.heading || 'Photos')}</h2>${p.body ? `<p>${esc(p.body)}</p>` : ''}<div class="grid">${shown || '<p>Photos will be added soon.</p>'}</div>${foot}</section>`;
    }
    if (p.kind === 'Contact') {
      return `<section class="pg"><h2>${esc(p.heading || 'Contact')}</h2>${p.body ? `<p>${esc(p.body)}</p>` : ''}${img(p)}<p style="margin-top:14px"><b>${esc(lh?.name || '')}</b>\n${esc([lh?.address, [lh?.phone, lh?.email].filter(Boolean).join(' · ')].filter(Boolean).join('\n'))}</p>${foot}</section>`;
    }
    const pic = img(p);
    const lay = p.layout === 'Picture left' ? 'row' : p.layout === 'Picture right' ? 'row right' : '';
    const text = `<div style="flex:1">${p.heading ? `<h2>${esc(p.heading)}</h2>` : ''}<p>${esc(p.body)}</p></div>`;
    return `<section class="pg">${lay ? `<div class="${lay}">${pic}${text}</div>` : `${pic ? `<div style="margin-bottom:14px">${pic}</div>` : ''}${text}`}${foot}</section>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ev.name)} - brochure</title><style>${CSS}</style></head><body>${out || '<section class="pg"><p>No pages yet.</p></section>'}</body></html>`;
}
