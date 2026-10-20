import React, { useState } from 'react';
import { useApp, useCollection } from '../../context/AppContext.jsx';
import { COLLECTIONS } from '../../lib/storage/index.js';

const BLANK = { name: '', amenity: '', stock: '', price: '', perLabel: '', maxPerBooking: '', active: true };

/** Add-on items with a stock count: chairs, tables, a tent, a sound system... Add any item here and it appears on the booking form with its price and what is left. */
export default function AmenityItems() {
  const { roleId, hasPermission } = useApp();
  const can = roleId === 'super_admin' || hasPermission('MANAGE_AMENITIES') || hasPermission('MANAGE_AMENITY_RATES');
  const { records: items, save, remove } = useCollection(COLLECTIONS.AMENITY_ITEMS, 'Amenity add-on items');
  const { records: catalog } = useCollection(COLLECTIONS.AMENITY_TYPES, 'Amenity Catalog');
  const [draft, setDraft] = useState(null);
  const [err, setErr] = useState('');
  const set = (k, v) => setDraft((d) => ({ ...d, [k]: v }));
  async function commit() {
    if (!String(draft.name || '').trim()) return setErr('Give the item a name');
    if (!(Number(draft.stock) > 0)) return setErr('Enter how many you own');
    if (Number(draft.price) < 0) return setErr('The price cannot be negative');
    if (items.some((i) => i.id !== draft.id && i.name.trim().toLowerCase() === draft.name.trim().toLowerCase() && (i.amenity || '') === (draft.amenity || ''))) return setErr('This item already exists for that amenity');
    const out = await save({ ...draft, name: draft.name.trim(), stock: Number(draft.stock), price: Number(draft.price) || 0, maxPerBooking: Number(draft.maxPerBooking) || 0 });
    if (out) { setDraft(null); setErr(''); }
  }
  return (
    <div className="card" data-testid="amenity-items">
      <h3 style={{ marginTop: 0 }}>Add-on items (chairs, tables…)</h3>
      <p className="muted" style={{ marginTop: 0 }}>Things a booking can take in any quantity. Add an item here and it shows on the booking form with its price and how many are left. No code change needed.</p>
      {items.length === 0 && <div className="empty">No items yet.</div>}
      {items.map((i) => (
        <div key={i.id} className="pr-row" data-testid="item-row" style={{ gap: 8, alignItems: 'center' }}>
          <span><b>{i.name}</b>{i.active === false && <span className="tag"> off</span>}<br /><small className="muted">{i.amenity || 'Every amenity'} · {i.stock} owned · {Number(i.price) > 0 ? `₹${i.price} ${i.perLabel || 'each'}` : 'free'}{Number(i.maxPerBooking) > 0 ? ` · max ${i.maxPerBooking} per booking` : ''}</small></span>
          {can && <span style={{ display: 'flex', gap: 6 }}><button type="button" className="btn secondary sm" data-testid="item-edit" onClick={() => { setDraft({ ...i }); setErr(''); }}>Edit</button><button type="button" className="btn secondary sm" data-testid="item-del" onClick={async () => { if (window.confirm(`Remove ${i.name}? Past bookings keep what they took.`)) await remove(i.id); }}>Remove</button></span>}
        </div>
      ))}
      {can && !draft && <button type="button" className="btn secondary sm" style={{ marginTop: 8 }} data-testid="item-add" onClick={() => { setDraft({ ...BLANK }); setErr(''); }}>+ Add an item</button>}
      {draft && (
        <div className="ro-block" style={{ marginTop: 10 }} data-testid="item-form">
          <div className="form-grid">
            <div className="field"><label>Item *</label><input data-testid="item-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Plastic chairs" /></div>
            <div className="field"><label>Only for</label><select data-testid="item-amenity" value={draft.amenity || ''} onChange={(e) => set('amenity', e.target.value)}><option value="">Every amenity</option>{catalog.map((a) => <option key={a.id}>{a.name}</option>)}</select></div>
            <div className="field"><label>Quantity owned *</label><input type="number" min="1" data-testid="item-stock" value={draft.stock} onChange={(e) => set('stock', e.target.value)} /></div>
            <div className="field"><label>Charge per item (₹)</label><input type="number" min="0" data-testid="item-price" value={draft.price} onChange={(e) => set('price', e.target.value)} /></div>
            <div className="field"><label>Price label</label><input data-testid="item-label" value={draft.perLabel || ''} onChange={(e) => set('perLabel', e.target.value)} placeholder="per chair" /></div>
            <div className="field"><label>Most per booking</label><input type="number" min="0" data-testid="item-max" value={draft.maxPerBooking} onChange={(e) => set('maxPerBooking', e.target.value)} /></div>
          </div>
          <label className="check" style={{ display: 'flex', gap: 6 }}><input type="checkbox" checked={draft.active !== false} onChange={(e) => set('active', e.target.checked)} /> Available to book</label>
          {err && <div className="field-error" data-testid="item-error">{err}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}><button type="button" className="btn" data-testid="item-save" onClick={commit}>Save item</button><button type="button" className="btn secondary" onClick={() => setDraft(null)}>Cancel</button></div>
        </div>
      )}
    </div>
  );
}
