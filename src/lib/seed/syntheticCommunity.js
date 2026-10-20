// Synthetic data for a LARGE community (default: 5 blocks x 400 units = 2,000 units, 12 months of dues, thousands of tickets
// and bookings, several clubhouses / pools). Used by the platform console ("Load large test data") and the scale tests, so
// the app can be measured at the size of a real township before the database back end exists.
import { COLLECTIONS } from '../storage/StorageAdapter.js';

const FIRST = ['Aarav', 'Vihaan', 'Ananya', 'Diya', 'Rohan', 'Neha', 'Kavita', 'Vikram', 'Priya', 'Arjun', 'Meera', 'Sanjay', 'Lakshmi', 'Ravi', 'Sunita', 'Kiran', 'Deepa', 'Manoj', 'Pooja', 'Suresh'];
const LAST = ['Sharma', 'Iyer', 'Reddy', 'Nair', 'Mehta', 'Rao', 'Kapoor', 'Shah', 'Gupta', 'Das', 'Patel', 'Menon', 'Joshi', 'Singh', 'Kulkarni'];
const pad = (n, w) => String(n).padStart(w, '0');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function largeCommunityData({ blocks = 5, unitsPerBlock = 400, months = 12, today = new Date() } = {}) {
  const out = {};
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const blockRows = []; const props = []; const dues = []; const tickets = []; const bookings = [];
  let phone = 9000000000;
  const ym = (back) => { const d = new Date(today.getFullYear(), today.getMonth() - back, 1); return { y: d.getFullYear(), m: d.getMonth(), key: `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}` }; };
  for (let b = 0; b < blocks; b += 1) {
    const code = letters[b % 26]; const villa = b < Math.ceil(blocks / 2) - 1; // the first blocks are villa lanes, the rest towers
    blockRows.push({ id: `blk${b}`, name: villa ? `Lane ${code}` : `Tower ${code}`, code, kind: villa ? 'Villa lane / cluster' : 'Tower', plannedUnits: unitsPerBlock, active: true, notes: '' });
    const zone = blockRows[b].name;
    for (let i = 1; i <= unitsPerBlock; i += 1) {
      const unit = villa ? `${code}-${pad(i, 3)}` : `${code}-${pad(Math.ceil(i / 8), 2)}${pad(((i - 1) % 8) + 1, 2)}`;
      const k = b * unitsPerBlock + i;
      const owner = `${FIRST[k % FIRST.length]} ${LAST[(k * 7) % LAST.length]}`;
      const occ = k % 9 === 0 ? 'Vacant' : k % 4 === 0 ? 'Tenant occupied' : 'Owner occupied';
      props.push({ id: `p${k}`, unit, type: villa ? 'Villa' : 'Apartment', zone, owner, ownerPhone: `+91 ${phone + k * 37}`, occupancy: occ, tenant: occ === 'Tenant occupied' ? `${FIRST[(k + 3) % FIRST.length]} ${LAST[(k + 5) % LAST.length]}` : '', tenantPhone: occ === 'Tenant occupied' ? `+91 ${phone + k * 37 + 11}` : '', people: [], areaSqft: villa ? 2400 + (k % 5) * 200 : 1100 + (k % 4) * 150, bedrooms: villa ? 4 : 2 + (k % 3), parking: villa ? 2 : 1, residentsCount: occ === 'Vacant' ? 0 : 3, outstanding: 0 });
      for (let mm = 0; mm < months; mm += 1) {
        const t = ym(mm); const paid = mm > 0 ? (k + mm) % 11 !== 0 : (k % 3 === 0);
        dues.push({ id: `d${k}-${mm}`, unit, category: 'Maintenance', amount: villa ? 4200 : 2800, billedMonth: `${MONTHS[t.m]} ${t.y}`, billedKey: t.key, dueDate: `${t.key}-10`, status: paid ? 'Paid' : (mm > 1 ? 'Overdue' : 'Unpaid'), paymentMode: paid ? 'UPI' : '', period: `${MONTHS[t.m]} ${t.y}` });
      }
      if (k % 5 === 0) tickets.push({ id: `t${k}`, ticketNumber: `TKT-${2000 + k}`, taskType: 'Resident Maintenance', title: ['Leaking tap', 'Lift stuck', 'Street light out', 'Garden gate lock', 'Water pressure low'][k % 5], description: 'Reported by the resident.', unit, category: ['Plumbing', 'Electrical', 'Carpentry', 'Housekeeping'][k % 4], priority: ['Low', 'Medium', 'High'][k % 3], status: ['Open', 'Assigned', 'Closed', 'Closed'][k % 4], assignedTo: '', createdBy: owner, createdByRole: 'owner', createdAt: '01 Oct 2026', paymentStatus: 'Not Paid', materialsCost: 0 });
    }
  }
  // several clubhouses and pools: one of each per two blocks, plus shared courts
  const facilities = []; const amenityTypes = [];
  const fac = (name, kind, block, am) => { facilities.push({ id: `fac-${name}`, name, kind, block, active: true, notes: '' }); if (am) amenityTypes.push({ id: `amt-${name}`, name, icon: am.icon, facility: name, active: true, price: am.price, rate: am.rate, rateUnit: am.rateUnit, weekendRate: 0, gstApplicable: false, gstRate: 18, gstMode: 'Exclusive', depositAmount: 0, minNoticeHours: 2, maxAdvanceDays: 60, capacity: am.capacity, hours: am.hours, bookingMode: am.mode, rules: '', cancellationRules: [] }); };
  blockRows.forEach((bk, i) => {
    if (i % 2 === 0) { fac(`Clubhouse ${bk.code}`, 'Clubhouse', bk.name, { icon: '🏛', price: '₹2,500 per day', rate: 2500, rateUnit: 'Per day / event', capacity: 1, hours: '08:00–22:00', mode: 'Full day' }); fac(`Pool ${bk.code}`, 'Swimming pool', bk.name, { icon: '🏊', price: 'Free for residents', rate: 0, rateUnit: 'Free', capacity: 20, hours: '06:00–20:00', mode: 'Time slot' }); }
  });
  fac('Tennis court', 'Sports court', '', { icon: '🎾', price: '₹200 per hour', rate: 200, rateUnit: 'Per hour', capacity: 1, hours: '06:00–21:00', mode: 'Time slot' });
  fac('Main gate / security', 'Gate / security', '', null); fac('STP', 'STP', '', null); fac('WTP', 'WTP', '', null); fac('Common area', 'Common area', '', null);
  const slots = ['06:00–07:00', '07:00–08:00', '17:00–18:00', '18:00–19:00'];
  for (let n = 0; n < Math.min(props.length * 1.5, 3000); n += 1) {
    const a = amenityTypes[n % amenityTypes.length]; const u = props[(n * 13) % props.length];
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + ((n * 3) % 40) - 10);
    const date = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
    bookings.push({ id: `b${n}`, amenity: a.name, unit: u.unit, date, slot: a.bookingMode === 'Full day' ? 'Full day' : slots[n % slots.length], status: d < today ? 'Completed' : 'Confirmed', paymentMode: '', baseAmount: 0, feeTotal: 0, depositAmount: 0, totalPayable: 0, paymentStatus: 'Not required', paidAmount: 0, bookedBy: u.unit });
  }
  // one block-limited secretary per block (they sign in with the demo role picker as 'General Secretary' only for the first block)
  out[COLLECTIONS.USERS] = [{ id: 'u_gs_a', name: 'General Secretary', phone: '+91 9000099991', email: 'gs.a@big.test', status: 'Active', roleId: 'general_secretary', extraRoleIds: [], units: [], blocks: [blockRows[0].name] }];
  out[COLLECTIONS.BLOCKS] = blockRows; out[COLLECTIONS.PROPERTIES] = props; out[COLLECTIONS.DUES] = dues; out[COLLECTIONS.TICKETS] = tickets;
  out[COLLECTIONS.FACILITIES] = facilities; out[COLLECTIONS.AMENITY_TYPES] = amenityTypes; out[COLLECTIONS.AMENITIES] = bookings;
  return out;
}
