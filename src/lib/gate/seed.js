// GateGuard demo data for La Paloma. Times are relative to "now" so the gate always looks live.
import { avatar } from './photo.js';
import { DEFAULT_SETTINGS } from './constants.js';

const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const ALL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const P = (id, name, personClass, extra = {}) => ({ id, name, personClass, photo: avatar(name, id.length + name.length), phone: `+91 98${Math.abs([...name].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 1e8}`.slice(0, 15), status: 'Active', idType: 'Aadhaar', idLast4: String(1000 + (name.length * 137) % 9000), idChecked: true, addressChecked: true, policeVerified: true, policeExpiry: day(240), referenceChecked: true, faceEnrolled: true, ...extra });

export function gateSeed(C) {
  const people = [
    P('gp1', 'Lakshmi Devi', 'Maid / cook'), P('gp2', 'Sunita Rao', 'Nanny / caretaker', { policeExpiry: day(20) }),
    P('gp3', 'Mohan Kumar', 'Driver', { licenceNo: 'KA03 20190045871', licenceExpiry: day(300), vehicleNo: 'KA 03 EF 5678' }),
    P('gp4', 'Raju Yadav', 'Delivery rider', { deliveryCompany: 'Amazon', vehicleNo: 'KA 51 AB 2210', policeVerified: false, policeExpiry: '' }),
    P('gp5', 'Imran Khan', 'Delivery rider', { deliveryCompany: 'Blinkit', vehicleNo: 'KA 05 HJ 7781', policeVerified: false, policeExpiry: '' }),
    ...['Anil Gowda', 'Basavaraj H', 'Pushpa Naik', 'Ramesh Naik', 'Suma Gowda', 'Kiran B'].map((n, i) => P(`gp${6 + i}`, n, 'Landscaper', { vendor: 'GreenRoot Gardens' })),
    P('gp12', 'Gopal Reddy', 'Vendor staff', { vendor: 'Sri Ganesh Electricals' }),
    P('gp13', 'Meena Kumari', 'Maid / cook', { status: 'Under review', invitedByUnit: 'Villa 135', policeVerified: false, policeExpiry: '', referenceChecked: false, faceEnrolled: false, submittedAt: iso(300) }),
    P('gp14', 'Dinesh Patil', 'Driver', { status: 'Documents pending', invitedByUnit: 'Villa 212', idChecked: false, addressChecked: false, policeVerified: false, policeExpiry: '', referenceChecked: false, faceEnrolled: false, licenceNo: '', licenceExpiry: '' }),
    P('gp15', 'Sanjay Pal', 'Driver', { status: 'Blocked', statusReason: 'Theft complaint from a villa, August 2026', licenceExpiry: day(100) }),
    P('gp16', 'Farida Begum', 'Maid / cook', { status: 'Suspended', statusReason: 'Police verification expired, needs re-validation', policeExpiry: day(-12) }),
  ];
  const L = (id, personId, personName, unit, days, fromTime, toTime) => ({ id, personId, personName, unit, days, fromTime, toTime, status: 'Active' });
  const links = [
    L('gl1', 'gp1', 'Lakshmi Devi', 'Villa 135', MS, '07:00', '13:00'), L('gl2', 'gp1', 'Lakshmi Devi', 'Villa 212', ['Mon', 'Wed', 'Fri'], '14:00', '17:00'),
    L('gl3', 'gp2', 'Sunita Rao', 'A-1204', MS, '08:00', '18:00'), L('gl4', 'gp3', 'Mohan Kumar', 'Villa 212', MS, '07:30', '20:00'),
  ];
  const passes = [
    { id: 'gps1', visitorName: 'Priya Menon', phone: '+91 98123 44556', unit: 'Villa 135', type: 'One-time', validFrom: day(0), validTo: day(0), vehicle: 'KA 05 AB 3344', code: '482913', usedCount: 1, status: 'Used', photo: avatar('Priya Menon', 2), hostName: 'Ananya Mehta', fromTime: '', toTime: '', days: [] },
    { id: 'gps2', visitorName: 'Rahul Sharma (maths tutor)', phone: '+91 98765 11002', unit: 'A-1204', type: 'Recurring', validFrom: day(-30), validTo: day(150), days: ['Mon', 'Wed', 'Fri'], fromTime: '17:00', toTime: '19:00', code: '731205', usedCount: 12, status: 'Active', photo: avatar('Rahul Sharma', 4), hostName: 'Vikram Shah' },
    { id: 'gps3', visitorName: 'Housewarming guests', phone: '', unit: 'Villa 212', type: 'Event', validFrom: day(0), validTo: day(3), guestCap: 40, usedCount: 0, code: '560984', status: 'Active', photo: '', hostName: 'Neha Kapoor', fromTime: '', toTime: '', days: [] },
    { id: 'gps4', visitorName: 'Anita Verma', phone: '+91 99001 22334', unit: 'Villa 135', type: 'One-time', validFrom: day(0), validTo: day(2), code: '318406', usedCount: 0, status: 'Active', photo: avatar('Anita Verma', 1), hostName: 'Rohan Mehta', fromTime: '', toTime: '', days: [] },
  ];
  const V = (id, o) => ({ id, gate: 'Main gate', phone: '', company: '', vehicle: '', purpose: '', ...o });
  const visits = [
    V('gv1', { name: 'Ananya Mehta', kind: 'Resident vehicle', unit: 'Villa 135', vehicle: 'KA 05 AB 1122', state: 'Inside', method: 'FASTag', inAt: iso(125), outAt: '', expectedUntil: '', photo: avatar('Ananya Mehta', 1), purpose: 'Resident vehicle' }),
    V('gv2', { name: 'Lakshmi Devi', kind: 'Maid / cook', unit: 'Villa 135', personId: 'gp1', state: 'Inside', method: 'Face', inAt: iso(70), outAt: '', expectedUntil: iso(-120), photo: people[0].photo, purpose: 'Maid / cook' }),
    V('gv3', { name: 'Priya Menon', kind: 'Guest', unit: 'Villa 135', passId: 'gps1', state: 'Inside', method: 'QR / OTP', inAt: iso(25), outAt: '', expectedUntil: iso(-215), photo: avatar('Priya Menon', 2), vehicle: 'KA 05 AB 3344', purpose: 'One-time pass' }),
    V('gv4', { name: 'Raju Yadav', kind: 'Delivery', unit: 'A-1204', company: 'Amazon', personId: 'gp4', state: 'Exited', method: 'Face', inAt: iso(48), outAt: iso(41), expectedUntil: '', photo: people[3].photo, purpose: 'Amazon delivery' }),
    ...[0, 1, 2].map((i) => V(`gv${5 + i}`, { name: people[5 + i].name, kind: 'Crew', unit: 'Common area', company: 'GreenRoot Gardens', personId: people[5 + i].id, workOrderId: 'gw1', state: 'Inside', method: 'Face', inAt: iso(180 - i * 5), outAt: '', expectedUntil: iso(-150), photo: people[5 + i].photo, purpose: 'Daily landscaping' })),
    V('gv8', { name: 'Ramesh Naik', kind: 'Crew', unit: 'Common area', company: 'GreenRoot Gardens', personId: 'gp9', workOrderId: 'gw1', state: 'Exited', method: 'Face', inAt: iso(178), outAt: iso(60), expectedUntil: '', photo: people[8].photo, purpose: 'Daily landscaping' }),
    V('gv9', { name: 'Sandeep Kulkarni', kind: 'Guest', unit: 'A-1204', state: 'Awaiting approval', method: 'Guard approval', inAt: iso(1), outAt: '', expectedUntil: '', photo: avatar('Sandeep Kulkarni', 6), purpose: 'Plumber called by resident', approvalId: 'gap1' }),
    V('gv10', { name: 'Unknown caller', kind: 'Guest', unit: 'Villa 212', state: 'Denied', method: 'Guard approval', inAt: iso(1500), outAt: iso(1498), expectedUntil: '', photo: avatar('Unknown caller', 7), purpose: 'Sales visit' }),
  ];
  const approvals = [
    { id: 'gap1', visitId: 'gv9', kind: 'Guest', name: 'Sandeep Kulkarni', unit: 'A-1204', purpose: 'Plumber called by resident', gate: 'Main gate', photo: avatar('Sandeep Kulkarni', 6), status: 'Pending', requestedAt: iso(1), expiresAt: new Date(Date.now() + 45 * 60000).toISOString(), fallback: 'Hold at gate' },
    { id: 'gap2', visitId: 'gv10', kind: 'Guest', name: 'Unknown caller', unit: 'Villa 212', purpose: 'Sales visit', gate: 'Main gate', photo: avatar('Unknown caller', 7), status: 'Denied', requestedAt: iso(1500), expiresAt: iso(1499), answeredAt: iso(1498), answeredBy: 'Neha Kapoor', fallback: 'Hold at gate' },
  ];
  const flags = [
    { id: 'gf1', type: 'Unrecorded entry', state: 'Open', gate: 'Gate 3', personName: 'Unknown person', detail: 'A camera saw a person walking inside Block C with no open entry record.', raisedAt: iso(14), photo: avatar('Unknown', 6) },
    { id: 'gf2', type: 'Tailgate', state: 'Closed', gate: 'Main gate', personName: 'Unrecorded vehicle', detail: 'The barrier sensor counted 2 vehicles in this cycle; the register has 1.', raisedAt: iso(1700), photo: avatar('Vehicle', 5), resolution: 'False alarm', resolutionNote: 'Guard verified: second car was a resident exiting', resolvedBy: 'Arvind (Guard)', resolvedAt: iso(1680) },
  ];
  const vehicles = [
    { id: 'gvh1', plate: 'KA 05 AB 1122', fastag: '34161FA820', unit: 'Villa 135', owner: 'Ananya Mehta', vehicleClass: 'Resident', status: 'Active' },
    { id: 'gvh2', plate: 'KA 01 MC 4455', fastag: '', unit: 'A-1204', owner: 'Vikram Shah', vehicleClass: 'Resident', status: 'Active' },
    { id: 'gvh3', plate: 'KA 53 ZZ 9090', fastag: '34161FA977', unit: 'Villa 212', owner: 'Neha Kapoor', vehicleClass: 'Resident', status: 'Active' },
    { id: 'gvh4', plate: 'KA 03 EF 5678', fastag: '', unit: 'Villa 212', owner: 'Mohan Kumar (driver)', vehicleClass: 'Driver', status: 'Active' },
    { id: 'gvh5', plate: 'KA 09 XX 0001', fastag: '', unit: 'Villa 212', owner: 'Sanjay Pal', vehicleClass: 'Driver', status: 'Blocked' },
  ];
  const orders = [
    { id: 'gw1', title: 'Daily landscaping: gardens and lanes', vendor: 'GreenRoot Gardens', area: 'Gardens, Block C roads', days: MS, fromTime: '07:00', toTime: '16:00', expectedHeadcount: 6, rosterIds: ['gp6', 'gp7', 'gp8', 'gp9', 'gp10', 'gp11'], equipment: 'Mower, hedge trimmer, tractor KA 03 MN 7788', status: 'Active' },
    { id: 'gw2', title: 'Pump room repair (STP)', vendor: 'Sri Ganesh Electricals', area: 'STP pump room', days: ALL, fromTime: '09:00', toTime: '18:00', expectedHeadcount: 1, rosterIds: ['gp12'], equipment: 'Tool kit', status: 'Active' },
  ];
  vehicles.push({ id: 'gvh6', plate: 'KA 01 TK 7788', fastag: '', unit: '', owner: 'Cauvery Water Tankers', vehicleClass: 'Vendor', status: 'Active', recurringGoods: true, usualPeople: 2, material: 'Water tanker' });
  const checkpoints = [
    ['Main gate booth', 'Main gate', 1], ['Clubhouse', 'Clubhouse front', 2], ['STP / WTP', 'Plant area', 3], ['HT yard & DG', 'Electrical yard', 4], ['Block C road end', 'Boundary wall', 5], ['Service gate', 'Service gate', 6],
  ].map(([name, area, order], i) => ({ id: `gcp${i + 1}`, name, area, order, active: true, code: `cp${i + 1}-${(9173 * (i + 3)) % 10000}` }));
  const rounds = [
    { id: 'grd1', name: 'Evening round', time: '20:00', windowMin: 60, checkpointIds: ['gcp1', 'gcp2', 'gcp3', 'gcp4', 'gcp5', 'gcp6'], days: [], active: true },
    { id: 'grd2', name: 'Midnight round', time: '00:00', windowMin: 60, checkpointIds: ['gcp1', 'gcp2', 'gcp3', 'gcp4', 'gcp5', 'gcp6'], days: [], active: true },
    { id: 'grd3', name: 'Early-morning round', time: '04:00', windowMin: 60, checkpointIds: ['gcp1', 'gcp3', 'gcp4', 'gcp5'], days: [], active: true },
  ];
  const templates = [
    { id: 'gtp1', name: 'Moving truck (move in)', unit: '', passType: 'Goods', goodsKind: 'Move in', validityDays: 1, fromTime: '08:00', toTime: '18:00', peopleCount: 5, material: 'Household goods', carryingOut: false },
    { id: 'gtp2', name: 'Moving truck (move out)', unit: '', passType: 'Goods', goodsKind: 'Move out', validityDays: 1, fromTime: '08:00', toTime: '18:00', peopleCount: 5, material: 'Household goods', carryingOut: true },
    { id: 'gtp3', name: 'Contractor with materials', unit: '', passType: 'Goods', goodsKind: 'Contractor / materials', validityDays: 7, fromTime: '09:00', toTime: '18:00', peopleCount: 3, material: 'Building materials', carryingOut: false },
    { id: 'gtp4', name: 'Cook, every morning', unit: 'Villa 135', passType: 'Recurring', visitorName: 'Savitri (cook)', validityDays: 90, fromTime: '07:00', toTime: '10:00', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
    { id: 'gtp5', name: 'Birthday party, 30 guests', unit: 'Villa 135', passType: 'Event', validityDays: 1, fromTime: '16:00', toTime: '22:00', guestCap: 30 },
  ];
  const rules = [
    { id: 'gr1', unit: 'Villa 135', deliveryMode: 'Allow listed', companies: ['Amazon', 'Flipkart', 'Swiggy'], awayMode: false, fallback: 'Community default', tellGuestExit: false, tellStaff: true, tellDelivery: true },
    { id: 'gr2', unit: 'A-1204', deliveryMode: 'Ask me each time', companies: [], awayMode: false, fallback: 'Community default', tellGuestExit: true, tellStaff: false, tellDelivery: true },
    { id: 'gr3', unit: 'Villa 212', deliveryMode: 'Allow all', companies: [], awayMode: false, fallback: 'Community default', tellGuestExit: false, tellStaff: true, tellDelivery: true },
    { id: 'gr4', unit: 'C-0807', deliveryMode: 'Leave at gate', companies: [], awayMode: true, fallback: 'Deny', tellGuestExit: false, tellStaff: false, tellDelivery: true },
  ];
  return {
    [C.GATE_PEOPLE]: people, [C.GATE_LINKS]: links, [C.GATE_PASSES]: passes, [C.GATE_VISITS]: visits, [C.GATE_APPROVALS]: approvals, [C.GATE_FLAGS]: flags,
    [C.GATE_VEHICLES]: vehicles, [C.GATE_WORKORDERS]: orders, [C.GATE_VILLA_RULES]: rules, [C.GATE_SETTINGS]: [{ ...DEFAULT_SETTINGS }], [C.GATE_CHECKPOINTS]: checkpoints, [C.GATE_ROUNDS]: rounds, [C.GATE_PASS_TEMPLATES]: templates,
  };
}
