import React, { useMemo, useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS as C } from '../../lib/storage/index.js';
import Modal from '../../components/Modal.jsx';
import Combobox from '../../components/Combobox.jsx';
import RichText from '../../components/RichText.jsx';
import RichTextEditor from '../../components/RichTextEditor.jsx';
import { isEmptyHtml } from '../../lib/richtext/sanitize.js';

const DEFAULT_CATS = ['Plumber', 'Electrician', 'Carpenter', 'AC technician', 'Painter', 'Driver', 'Cook', 'Maid / housekeeping', 'Pest control', 'Appliance repair', 'Gardener', 'Tutor', 'Other'];
const dmy = (s) => (s ? new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
const plain = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const digits = (s) => String(s || '').replace(/\D/g, '');

export function Stars({ value, size = 16, onPick, testid }) {
  return (
    <span data-testid={testid} aria-label={`${(Number(value) || 0).toFixed(1)} out of 5`} style={{ whiteSpace: 'nowrap', fontSize: size }}>
      {[1, 2, 3, 4, 5].map((n) => {
        const on = Number(value) >= n - 0.25;
        return onPick
          ? <button key={n} type="button" aria-label={`${n} star${n > 1 ? 's' : ''}`} data-testid={`star-${n}`} onClick={() => onPick(n)} style={{ background: 'none', border: 0, padding: '0 2px', fontSize: size + 6, minHeight: 0, color: Number(value) >= n ? '#f59e0b' : '#cbd5e1', cursor: 'pointer' }}>★</button>
          : <span key={n} style={{ color: on ? '#f59e0b' : '#cbd5e1' }}>★</span>;
      })}
    </span>
  );
}

function ContactForm({ record, cats, onClose, onSaved, contacts }) {
  const { currentUser } = useApp();
  const { save } = useCollection(C.SERVICE_CONTACTS, 'Service Directory');
  const [f, setF] = useState(() => ({ name: '', category: '', phone: '', area: '', rate: '', notes: '', ...(record || {}) }));
  const [err, setErr] = useState('');
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const dup = !record && digits(f.phone).length >= 8 ? contacts.find((c) => digits(c.phone).slice(-10) === digits(f.phone).slice(-10)) : null;
  async function submit() {
    if (!f.name.trim()) return setErr('Enter their name');
    if (!String(f.category).trim()) return setErr('Say what they do');
    if (digits(f.phone).length < 8) return setErr('Enter a phone number');
    if (dup) return setErr(`${dup.name} is already listed with this number - open them and add your review instead`);
    const out = await save({ ...(record || {}), ...f, name: f.name.trim(), category: String(f.category).trim(), phone: f.phone.trim(), status: record?.status || 'Active', addedBy: record?.addedBy || currentUser?.name, addedByUnit: record?.addedByUnit ?? (currentUser?.unit || '') });
    if (out) onSaved(out);
  }
  return (
    <Modal title={record ? 'Edit contact' : 'Recommend someone'} subtitle="Share a good technician, driver, cook or helper with your neighbours." onClose={onClose} wide>
      {err && <div className="notice error" data-testid="contact-error">{err}</div>}
      <div data-testid="contact-form" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))', gap: '8px 12px' }}>
        <div className="field"><label>Name *</label><input aria-label="Name" value={f.name} onChange={(e) => set('name', e.target.value)} /></div>
        <div className="field"><label>What they do *</label><Combobox value={f.category} onChange={(v) => set('category', v)} options={cats.map((c) => ({ value: c, label: c }))} allowCustom placeholder="Plumber, cook, driver…" /></div>
        <div className="field"><label>Phone *</label><input aria-label="Phone" inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91 …" /></div>
        <div className="field"><label>Works in / lives near</label><input aria-label="Area" value={f.area} onChange={(e) => set('area', e.target.value)} /></div>
        <div className="field"><label>Typical charges</label><input aria-label="Charges" value={f.rate} onChange={(e) => set('rate', e.target.value)} placeholder="e.g. ₹400 per visit" /></div>
        <div className="field" style={{ gridColumn: '1 / -1' }}><label>About them</label><textarea rows={2} aria-label="About" value={f.notes} onChange={(e) => set('notes', e.target.value)} placeholder="Speciality, timings, languages…" /></div>
      </div>
      {dup && <div className="notice">Already listed: <b>{dup.name}</b> ({dup.category}).</div>}
      <div className="form-actions"><button className="btn" data-testid="contact-save" onClick={submit}>Save</button><button className="btn secondary" onClick={onClose}>Cancel</button></div>
    </Modal>
  );
}

function ContactDetail({ contact, reviews, mod, mine, cats, contacts, onClose, onEdit, onChanged }) {
  const { currentUser } = useApp();
  const { save: saveReview, remove: removeReview } = useCollection(C.CONTACT_REVIEWS, 'Contact Reviews');
  const { save: saveContact, remove: removeContact } = useCollection(C.SERVICE_CONTACTS, 'Service Directory');
  const myReview = reviews.find((r) => r.author === currentUser?.name);
  const [rating, setRating] = useState(myReview?.rating || 0);
  const [comment, setComment] = useState(myReview?.comment || '');
  const [rec, setRec] = useState(myReview?.recommend || 'Yes');
  const [err, setErr] = useState('');
  const avg = reviews.length ? reviews.reduce((n, r) => n + Number(r.rating), 0) / reviews.length : 0;
  async function post() {
    if (!(rating >= 1)) return setErr('Tap the stars to rate');
    const out = await saveReview({ ...(myReview || {}), contactId: contact.id, rating, comment: isEmptyHtml(comment) ? '' : comment, recommend: rec, author: currentUser?.name, unit: currentUser?.unit || '', createdAt: new Date().toISOString() });
    if (out) { setErr(''); onChanged(); }
  }
  const phone = digits(contact.phone);
  return (
    <Modal title={contact.name} subtitle={`${contact.category}${contact.area ? ' · ' + contact.area : ''}`} onClose={onClose}>
      <div data-testid="contact-detail">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Stars value={avg} size={22} testid="detail-stars" /><b>{reviews.length ? avg.toFixed(1) : 'No ratings yet'}</b><small className="muted">{reviews.length} review{reviews.length === 1 ? '' : 's'}{reviews.length ? ` · ${Math.round((reviews.filter((r) => r.recommend !== 'No').length / reviews.length) * 100)}% would use again` : ''}</small>
          {contact.status === 'Hidden' && <span className="tag red">Hidden</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, margin: '10px 0', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><a className="call-btn" href={`tel:${contact.phone}`} aria-label={`Call ${contact.phone}`} title={`Call ${contact.phone}`}>📞</a><span className="mono">{contact.phone}</span></span>
          <a className="btn secondary" href={`https://wa.me/${phone.length === 10 ? '91' + phone : phone}`} target="_blank" rel="noreferrer">WhatsApp</a>
        </div>
        <div data-testid="detail-facts" style={{ display: 'grid', gap: 2 }}>
          <div><b>What they do:</b> {contact.category}</div>
          {contact.area && <div><b>Works in:</b> {contact.area}</div>}
          {contact.rate && <div><b>Charges:</b> {contact.rate}</div>}
          {contact.notes && <div><b>About:</b> {contact.notes}</div>}
        </div>
        <small className="muted">Recommended by {contact.addedBy}{contact.addedByUnit ? ` (${contact.addedByUnit})` : ''}</small>
        {(mine || mod) && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            <button className="btn secondary sm" onClick={onEdit}>Edit details</button>
            {mod && <button className="btn secondary sm" data-testid="hide-contact" onClick={async () => { await saveContact({ ...contact, status: contact.status === 'Hidden' ? 'Active' : 'Hidden' }); onChanged(); onClose(); }}>{contact.status === 'Hidden' ? 'Show again' : 'Hide from directory'}</button>}
            <button className="btn secondary danger sm" data-testid="delete-contact" onClick={async () => { if (window.confirm('Remove this contact and its reviews?')) { for (const r of reviews) await removeReview(r.id); await removeContact(contact.id); onChanged(); onClose(); } }}>Delete</button>
          </div>
        )}
        <h4 style={{ margin: '14px 0 6px' }}>{myReview ? 'Your review' : 'Rate this person'}</h4>
        <div data-testid="review-form">
          {err && <div className="notice error">{err}</div>}
          <Stars value={rating} size={20} onPick={setRating} testid="review-stars" />
          <div style={{ marginTop: 6 }} data-testid="review-editor"><RichTextEditor value={comment} onChange={setComment} placeholder="How was the work? Punctual, fair price, clean… (you can add photos)" minHeight={70} /></div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <select aria-label="Would use again" value={rec} onChange={(e) => setRec(e.target.value)} style={{ width: 'auto' }}><option value="Yes">Would use again</option><option value="No">Would not use again</option></select>
            <button className="btn" data-testid="post-review" onClick={post}>{myReview ? 'Update review' : 'Post review'}</button>
            {myReview && <button className="btn secondary" onClick={async () => { await removeReview(myReview.id); setRating(0); setComment(''); onChanged(); }}>Delete mine</button>}
          </div>
        </div>
        <h4 style={{ margin: '14px 0 6px' }}>What neighbours say</h4>
        {reviews.length === 0 ? <div className="empty">No reviews yet - be the first.</div> : (
          <ul className="list" data-testid="review-list">{[...reviews].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => (
            <li key={r.id} style={{ display: 'block' }}><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Stars value={r.rating} /><b>{r.author}</b><small className="muted">{r.unit ? `${r.unit} · ` : ''}{dmy(r.createdAt)}</small>{mod && r.author !== currentUser?.name && <button className="btn secondary danger sm" onClick={async () => { await removeReview(r.id); onChanged(); }}>Remove</button>}</div>{r.comment && <RichText html={r.comment} />}</li>
          ))}</ul>
        )}
      </div>
    </Modal>
  );
}

export default function DirectoryModule() {
  const { currentUser, role, hasPermission } = useApp();
  const { records: contacts, refresh: refC } = useCollection(C.SERVICE_CONTACTS, 'Service Directory');
  const { records: gatePeople } = useCollection(C.GATE_PEOPLE, 'Registry');
  const vetted = useMemo(() => new Set(gatePeople.filter((x) => x.status === 'Active').map((x) => x.id)), [gatePeople]);
  const { records: reviews, refresh: refR } = useCollection(C.CONTACT_REVIEWS, 'Contact Reviews');
  const mod = role?.category === 'EC' || hasPermission('MODERATE_FORUM') || role?.id === 'super_admin';
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [sort, setSort] = useState('rating');
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState(null);
  const refresh = () => { refC?.(); refR?.(); };
  const cats = useMemo(() => [...new Set([...DEFAULT_CATS, ...contacts.map((c) => c.category)])], [contacts]);
  const stats = useMemo(() => {
    const m = new Map(); reviews.forEach((r) => { const k = m.get(r.contactId) || { n: 0, sum: 0, yes: 0 }; k.n += 1; k.sum += Number(r.rating); if (r.recommend !== 'No') k.yes += 1; m.set(r.contactId, k); });
    return m;
  }, [reviews]);
  const reviewText = useMemo(() => { const m = new Map(); reviews.forEach((r) => m.set(r.contactId, `${m.get(r.contactId) || ''} ${plain(r.comment)}`)); return m; }, [reviews]);
  const used = [...new Set(contacts.filter((c) => mod || c.status !== 'Hidden').map((c) => c.category))].sort();
  const list = contacts.filter((c) => (mod || c.status !== 'Hidden') && (!cat || c.category === cat) && (!q || `${c.name} ${c.category} ${c.area} ${c.notes} ${reviewText.get(c.id) || ''}`.toLowerCase().includes(q.toLowerCase())))
    .map((c) => ({ c, s: stats.get(c.id) })).sort((a, b) => (sort === 'name' ? a.c.name.localeCompare(b.c.name) : ((b.s ? b.s.sum / b.s.n : 0) - (a.s ? a.s.sum / a.s.n : 0)) || ((b.s?.n || 0) - (a.s?.n || 0))));
  const openContact = open && contacts.find((c) => c.id === open);
  return (
    <div data-testid="directory-page">
      <div className="page-head"><div><h1>Service directory</h1><p>Plumbers, electricians, drivers, cooks and other helpers recommended by neighbours - with ratings from the people who used them.</p></div>
        <button className="btn" data-testid="add-contact" onClick={() => setForm({ record: null })}>+ Recommend someone</button></div>
      <div className="card" style={{ marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input className="search" aria-label="Search" placeholder="Search name, trade, area, about, reviews…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
          <select aria-label="Sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 'auto' }}><option value="rating">Top rated</option><option value="name">Name A-Z</option></select>
        </div>
        <div className="chips" role="group" aria-label="Category" style={{ marginTop: 8 }}>
          <button type="button" className={`chip${!cat ? ' on' : ''}`} aria-pressed={!cat} onClick={() => setCat('')}>All</button>
          {used.map((u) => <button key={u} type="button" className={`chip${cat === u ? ' on' : ''}`} aria-pressed={cat === u} data-testid={`cat-${u}`} onClick={() => setCat(cat === u ? '' : u)}>{u}</button>)}
        </div>
      </div>
      <div className="stable-count-line" data-testid="row-count">{list.length} {list.length === 1 ? 'contact' : 'contacts'}</div>
      {list.length === 0 ? <div className="empty">Nobody listed yet. Recommend someone you trust.</div> : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table className="resp-table" data-testid="contact-table">
            <thead><tr><th>Name</th><th>What they do</th><th>Works in</th><th>About</th><th>Rating</th><th>Charges</th><th></th></tr></thead>
            <tbody>
              {list.map(({ c, s }) => (
                <tr key={c.id} style={{ cursor: 'pointer', opacity: c.status === 'Hidden' ? 0.6 : 1 }} data-testid="contact-card" onClick={() => setOpen(c.id)}>
                  <td data-label="Name"><b>{c.name}</b>{c.registryId && vetted.has(c.registryId) && <span className="tag green" style={{ marginLeft: 6 }} data-testid="vetted-tag" title="Police-verified and registered with the gate">✔ Vetted at gate</span>}{c.status === 'Hidden' && <span className="tag red" style={{ marginLeft: 6 }}>Hidden</span>}</td>
                  <td data-label="What they do"><span className="tag">{c.category}</span></td>
                  <td data-label="Works in">{c.area || <span className="muted">—</span>}</td>
                  <td data-label="About" style={{ maxWidth: 280 }}><span className="muted" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.notes || '—'}</span></td>
                  <td data-label="Rating" style={{ whiteSpace: 'nowrap' }}><Stars value={s ? s.sum / s.n : 0} size={14} /> <small className="muted">{s ? `${(s.sum / s.n).toFixed(1)} (${s.n})` : 'none yet'}</small></td>
                  <td data-label="Charges">{c.rate || <span className="muted">—</span>}</td>
                  <td data-label="" onClick={(e) => e.stopPropagation()}><a className="call-btn" href={`tel:${c.phone}`} aria-label={`Call ${c.name || c.phone}`} title="Call">📞</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {openContact && <ContactDetail contact={openContact} reviews={reviews.filter((r) => r.contactId === openContact.id)} mod={mod} mine={openContact.addedBy === currentUser?.name} cats={cats} contacts={contacts} onClose={() => setOpen(null)} onEdit={() => { setForm({ record: openContact }); setOpen(null); }} onChanged={refresh} />}
      {form && <ContactForm record={form.record} cats={cats} contacts={contacts} onClose={() => setForm(null)} onSaved={() => { setForm(null); refresh(); }} />}
    </div>
  );
}
