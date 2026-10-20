// Reference data for La Paloma: the real places, plants and equipment of the community, the maintenance categories (with sub-categories)
// that fit them, a starting inventory and the important phone numbers. Merged into the demo seed; a new community starts from the same lists
// (facilities, categories) and edits them in Community setup. Phone numbers marked "demo" are placeholders to be replaced by the committee.

const d = (y, m, day) => `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const VENDOR = 'ARC Facility Management';

export const NEW_CATEGORIES = ['Civil & Painting', 'Water & Sewage', 'Fire safety'];

/** Maintenance category -> sub-categories. A sub-category appears under ONE category only. */
export const CATEGORY_TREE = [
  ['Plumbing', ['Leakage', 'Tap / fixture', 'Drain blockage', 'Toilet / bathroom', 'Water heater', 'Overhead tank'], 'Optional', ['facility_manager', 'handyman_mep']],
  ['Electrical', ['Lighting', 'Switches / wiring', 'Power outage', 'Street lights', 'HT yard & transformers', 'DG sets', 'Panels / APFC / stabilizer', 'UPS / inverter'], 'Optional', ['facility_manager', 'handyman_mep']],
  ['MEP', ['Pumps / motors', 'Lifts', 'Air conditioning', 'Sensors / automation', 'Gas pipeline'], 'Optional', ['handyman_mep']],
  ['Water & Sewage', ['Water treatment plant (WTP)', 'Sewage treatment plant (STP)', 'Rainwater harvesting (RHP)', 'Borewells', 'Water tanks / sumps', 'Pipelines / valves', 'Manholes / drains'], 'Optional', ['handyman_mep', 'facility_manager']],
  ['Civil & Painting', ['Roads / pavements', 'Compound wall / gates', 'Roof / waterproofing', 'Painting', 'Tiles / flooring', 'Signage'], 'Optional', ['facility_manager']],
  ['Carpentry', ['Doors / windows', 'Furniture', 'Locks / hardware'], 'Optional', ['facility_manager']],
  ['Housekeeping', ['Common area cleaning', 'Garbage / waste', 'Pest control', 'Toilet cleaning'], 'Hidden', ['facility_manager']],
  ['Gardening', ['Lawn & plants', 'Irrigation / sprinklers', 'Tree trimming'], 'Optional', ['facility_manager']],
  ['Landscape', ['Park / play area', 'Water features', 'Paving / hardscape', 'Garden lights'], 'Optional', ['facility_manager']],
  ['Security', ['Gate / access', 'Patrolling', 'CCTV / NVR', 'Boom barrier / turnstile', 'Guard room'], 'Optional', ['facility_manager']],
  ['Fire safety', ['Extinguishers', 'Hydrants / sprinklers', 'Alarm / detection', 'Fire pump'], 'Optional', ['facility_manager', 'handyman_mep']],
  ['Amenities', ['Clubhouse rooms', 'Gym / yoga room', 'Swimming pool', 'Sports courts', "Children's park", 'Indoor games'], 'Optional', ['facility_manager']],
  ['Cultural', ['Event set-up', 'Sound & lights', 'Stage & decor'], 'Hidden', ['facility_manager']],
];

const FACILITIES = [
  ['Clubhouse', 'Clubhouse', 'Yoga room, party halls (banquet 1 and 2), gym, sports room, badminton and squash courts, bathrooms, FM room'],
  ['Sports courts', 'Sports court', 'Tennis, baseball, pickleball, cricket box and sand volleyball. No reservation needed'],
  ["Children's park", 'Park', 'Play area. No reservation needed'],
  ['HT yard', 'HT yard', '3 transformers (2 × 500 kVA, 1 × 160 kVA), HT / LT panels, APFC, stabilizers'],
  ['RHP', 'RHP', 'Rainwater harvesting pits and recharge wells'],
  ['Fire safety', 'Fire safety', 'Extinguishers, hydrants, sprinklers, fire pump, alarm panels'],
  ['CCTV & NVR room', 'Gate / security', 'NVRs, network switches and UPS for the cameras'],
  ['Reception & lobby', 'Common area', ''],
  ['Pump room', 'Pump room', 'Domestic water and fire pumps'],
  ['Main store', 'Store', 'Spares and consumables'],
  ['Tower A', 'Tower', 'Lifts, staircases, lobbies'],
  ['Tower C', 'Tower', 'Lifts, staircases, lobbies'],
  ['Villas (212)', 'Villa', 'Individual villas are managed in Unit Directory'],
];

const A = (id, name, area, type, repairCategory, location, extra = {}) => ({ id, name, area, type, repairCategory, location, quantity: 1, status: 'Working', amcVendor: VENDOR, installDate: d(2022, 6, 1), lastService: d(2026, 8, 20), nextService: d(2027, 2, 20), ...extra });
const EQUIPMENT = [
  // HT yard
  A('rq1', 'Transformer T1 (500 kVA)', 'HT yard', 'Transformer / HT', 'Electrical', 'HT yard, bay 1', { rating: '500 kVA', make: 'Voltamp', specs: JSON.stringify({ 'Capacity (kVA)': '500', 'Primary / secondary voltage': '11 kV / 433 V', Cooling: 'ONAN' }) }),
  A('rq2', 'Transformer T2 (500 kVA)', 'HT yard', 'Transformer / HT', 'Electrical', 'HT yard, bay 2', { rating: '500 kVA', make: 'Voltamp', specs: JSON.stringify({ 'Capacity (kVA)': '500', 'Primary / secondary voltage': '11 kV / 433 V', Cooling: 'ONAN' }) }),
  A('rq3', 'Transformer T3 (160 kVA)', 'HT yard', 'Transformer / HT', 'Electrical', 'HT yard, bay 3', { rating: '160 kVA', make: 'Voltamp', specs: JSON.stringify({ 'Capacity (kVA)': '160', 'Primary / secondary voltage': '11 kV / 433 V', Cooling: 'ONAN' }) }),
  A('rq4', 'DG 1 (Cummins 500 kVA)', 'HT yard', 'DG set', 'Electrical', 'DG room, bay 1', { rating: '500 kVA', make: 'Cummins', model: 'C500D5' }),
  A('rq5', 'DG 2 (Cummins 500 kVA)', 'HT yard', 'DG set', 'Electrical', 'DG room, bay 2', { rating: '500 kVA', make: 'Cummins', model: 'C500D5' }),
  A('rq6', 'DG 3 (Cummins 125 kVA)', 'HT yard', 'DG set', 'Electrical', 'DG room, bay 3', { rating: '125 kVA', make: 'Cummins', model: 'C125D5' }),
  A('rq7', 'Servo voltage stabilizer', 'HT yard', 'Stabilizer', 'Electrical', 'LT room', { rating: '500 kVA', make: 'Servomax' }),
  A('rq8', 'HT panel (VCB)', 'HT yard', 'Panel / starter', 'Electrical', 'HT room', { rating: '11 kV' }),
  A('rq9', 'LT main panel (PCC)', 'HT yard', 'Panel / starter', 'Electrical', 'LT room', { rating: '2000 A' }),
  A('rq10', 'APFC panel', 'HT yard', 'Panel / starter', 'Electrical', 'LT room', { rating: '300 kVAr', make: 'Schneider' }),
  A('rq11', 'DG synchronising / AMF panel', 'HT yard', 'Panel / starter', 'Electrical', 'DG room', {}),
  A('rq12', 'Earthing pits (HT yard)', 'HT yard', 'Earthing', 'Electrical', 'HT yard fence', { quantity: 6, lastService: d(2026, 5, 10), nextService: d(2026, 11, 10) }),
  // Borewells
  A('rq13', 'Borewell 1 submersible', 'Borewell', 'Motor', 'Water & Sewage', 'Borewell 1', { rating: '5.5 kW', make: 'Texmo' }),
  A('rq14', 'Borewell 3 submersible', 'Borewell', 'Motor', 'Water & Sewage', 'Borewell 3', { rating: '5.5 kW', make: 'Texmo' }),
  A('rq15', 'Borewell 4 submersible', 'Borewell', 'Motor', 'Water & Sewage', 'Borewell 4', { rating: '5.5 kW', make: 'Texmo' }),
  A('rq16', 'Borewell starter panels', 'Borewell', 'Panel / starter', 'Electrical', 'At each borewell', { quantity: 4 }),
  A('rq17', 'Borewell flow meters', 'Borewell', 'Sensor / meter', 'Water & Sewage', 'At each borewell', { quantity: 4 }),
  // WTP
  A('rq18', 'WTP raw water tank', 'WTP', 'Water tank', 'Water & Sewage', 'WTP', { rating: '100 KL' }),
  A('rq19', 'WTP pressure sand filter', 'WTP', 'Filter', 'Water & Sewage', 'WTP', { quantity: 2 }),
  A('rq20', 'WTP activated carbon filter', 'WTP', 'Filter', 'Water & Sewage', 'WTP', { quantity: 2 }),
  A('rq21', 'WTP softener', 'WTP', 'Filter', 'Water & Sewage', 'WTP', {}),
  A('rq22', 'WTP chlorine dosing pump', 'WTP', 'Pump', 'Water & Sewage', 'WTP', { rating: '0.25 HP' }),
  A('rq23', 'WTP treated water sump', 'WTP', 'Water tank', 'Water & Sewage', 'WTP', { rating: '150 KL' }),
  A('rq24', 'WTP control panel', 'WTP', 'Panel / starter', 'Electrical', 'WTP', {}),
  A('rq25', 'Treated water supply pumps', 'WTP', 'Pump', 'Water & Sewage', 'WTP pump room', { quantity: 3, rating: '7.5 HP' }),
  // STP
  A('rq26', 'STP equalisation tank', 'STP', 'Water tank', 'Water & Sewage', 'STP', {}),
  A('rq27', 'STP aeration tank & diffusers', 'STP', 'Water tank', 'Water & Sewage', 'STP', {}),
  A('rq28', 'STP clarifier', 'STP', 'Water tank', 'Water & Sewage', 'STP', {}),
  A('rq29', 'STP tertiary filters (PSF / ACF)', 'STP', 'Filter', 'Water & Sewage', 'STP', { quantity: 2 }),
  A('rq30', 'STP sludge pumps', 'STP', 'Pump', 'Water & Sewage', 'STP', { quantity: 2 }),
  A('rq31', 'STP control panel', 'STP', 'Panel / starter', 'Electrical', 'STP', {}),
  A('rq32', 'STP treated water tank', 'STP', 'Water tank', 'Water & Sewage', 'STP', {}),
  // RHP
  A('rq33', 'Rainwater harvesting pits', 'RHP', 'Recharge pit', 'Water & Sewage', 'Roads and open areas', { quantity: 12, lastService: d(2026, 6, 5), nextService: d(2027, 5, 15), lastInspected: d(2026, 6, 5) }),
  A('rq34', 'RHP silt trap chambers', 'RHP', 'Manhole / chamber', 'Water & Sewage', 'Before each pit', { quantity: 12, lastService: d(2026, 6, 5), nextService: d(2027, 5, 15) }),
  // Clubhouse
  A('rq35', 'Gym treadmills', 'Clubhouse', 'Gym equipment', 'Amenities', 'Gym', { quantity: 4 }),
  A('rq36', 'Gym cross trainers & cycles', 'Clubhouse', 'Gym equipment', 'Amenities', 'Gym', { quantity: 5 }),
  A('rq37', 'Gym weights & benches', 'Clubhouse', 'Gym equipment', 'Amenities', 'Gym', {}),
  A('rq38', 'Banquet 1 sound & AV system', 'Clubhouse', 'Audio / visual', 'Cultural', 'Banquet 1', {}),
  A('rq39', 'Banquet 2 sound & AV system', 'Clubhouse', 'Audio / visual', 'Cultural', 'Banquet 2', {}),
  A('rq40', 'Banquet 1 air conditioners', 'Clubhouse', 'Air conditioner', 'MEP', 'Banquet 1', { quantity: 3 }),
  A('rq41', 'Banquet 2 air conditioners', 'Clubhouse', 'Air conditioner', 'MEP', 'Banquet 2', { quantity: 3 }),
  A('rq42', 'Yoga room air conditioner', 'Clubhouse', 'Air conditioner', 'MEP', 'Yoga room', { quantity: 2 }),
  A('rq43', 'Badminton court lights & flooring', 'Clubhouse', 'Court lighting', 'Amenities', 'Badminton courts', { quantity: 2 }),
  A('rq44', 'Squash court (glass wall, lights)', 'Clubhouse', 'Court lighting', 'Amenities', 'Squash court', {}),
  A('rq45', 'Sports room tables (TT, carrom)', 'Clubhouse', 'Sports equipment', 'Amenities', 'Sports room', { quantity: 3 }),
  A('rq46', 'Pool filtration plant', 'Clubhouse', 'Filter', 'Amenities', 'Pool plant room', {}),
  A('rq47', 'Pool underwater lights', 'Clubhouse', 'Court lighting', 'Amenities', 'Swimming pool', { quantity: 12 }),
  A('rq48', 'Changing room water heaters', 'Clubhouse', 'Water heater', 'Plumbing', 'Bathrooms', { quantity: 6 }),
  A('rq49', 'Clubhouse kitchen / pantry equipment', 'Clubhouse', 'Kitchen equipment', 'General', 'Pantry', {}),
  A('rq50', 'FM room computer & network', 'Clubhouse', 'Network / Wi-Fi', 'Security', 'FM room', {}),
  A('rq51', 'Clubhouse sprinkler & alarm panel', 'Clubhouse', 'Fire safety', 'Fire safety', 'Clubhouse', {}),
  // Open courts and park
  A('rq52', 'Tennis court floodlights', 'Sports courts', 'Court lighting', 'Amenities', 'Tennis court', { quantity: 8 }),
  A('rq53', 'Baseball court (nets, backstop)', 'Sports courts', 'Sports equipment', 'Amenities', 'Baseball court', {}),
  A('rq54', 'Pickleball courts (nets, lights)', 'Sports courts', 'Court lighting', 'Amenities', 'Pickleball courts', { quantity: 2 }),
  A('rq55', 'Cricket box (nets, lights)', 'Sports courts', 'Court lighting', 'Amenities', 'Cricket box', {}),
  A('rq56', 'Sand volleyball court', 'Sports courts', 'Sports equipment', 'Amenities', 'Sand volleyball court', {}),
  A('rq57', "Children's play equipment", "Children's park", 'Play equipment', 'Landscape', "Children's park", { quantity: 10 }),
  // Security and CCTV
  A('rq58', 'NVR (64 channel)', 'CCTV & NVR room', 'NVR / DVR', 'Security', 'Security room rack', { make: 'Hikvision', specs: JSON.stringify({ Channels: '64', 'Storage (TB)': '48', 'Retention (days)': '30' }) }),
  A('rq59', 'Camera network switches', 'CCTV & NVR room', 'Network / Wi-Fi', 'Security', 'Poles and security room', { quantity: 10 }),
  A('rq60', 'Boom barriers', 'Main gate / security', 'Boom barrier', 'Security', 'Main gate and service gate', { quantity: 4 }),
  A('rq61', 'Street light control panels', 'Street / roads', 'Panel / starter', 'Electrical', 'Along main road', { quantity: 6 }),
  // Fire and lifts
  A('rq62', 'Fire extinguishers', 'Fire safety', 'Fire safety', 'Fire safety', 'All buildings', { quantity: 90, nextService: d(2026, 12, 1) }),
  A('rq63', 'Fire hydrant & sprinkler network', 'Fire safety', 'Fire safety', 'Fire safety', 'Tower A, Tower C', {}),
  A('rq64', 'Fire pump set (main, jockey, diesel)', 'Fire safety', 'Pump', 'Fire safety', 'Pump room', { quantity: 3 }),
  A('rq65', 'Tower A lifts', 'Tower A', 'Lift', 'MEP', 'Tower A', { quantity: 2 }),
  A('rq66', 'Tower C lifts', 'Tower C', 'Lift', 'MEP', 'Tower C', { quantity: 2 }),
];

const IV = (id, item, category, location, quantity, uom, minStock, vendor = '') => ({ id, item, category, location, quantity, uom, minStock, stockStatus: quantity <= 0 ? 'Out of stock' : quantity < minStock ? 'Low' : 'In stock', vendor, lastRestocked: d(2026, 9, 10), notes: '', attachments: [] });
const INVENTORY = [
  IV('rv1', 'Transformer oil (spare)', 'Electrical', 'HT yard', 40, 'Litres', 20),
  IV('rv2', 'DG engine oil 15W-40', 'Electrical', 'HT yard', 90, 'Litres', 60),
  IV('rv3', 'DG oil & fuel filters (set)', 'Electrical', 'HT yard', 3, 'Sets', 2),
  IV('rv4', 'DG coolant', 'Electrical', 'HT yard', 40, 'Litres', 20),
  IV('rv5', 'HRC fuses (assorted)', 'Electrical', 'HT yard', 15, 'Nos', 10),
  IV('rv6', 'Capacitor (APFC) spare', 'Electrical', 'HT yard', 2, 'Nos', 2),
  IV('rv7', 'Street light LED 30 W', 'Electrical', 'Main store', 25, 'Nos', 20),
  IV('rv8', 'Street light LED 60 W', 'Electrical', 'Main store', 10, 'Nos', 8),
  IV('rv9', 'Photocell / timer for street lights', 'Electrical', 'Main store', 6, 'Nos', 4),
  IV('rv10', 'Badminton court lamps', 'Amenities', 'Clubhouse', 10, 'Nos', 6),
  IV('rv11', 'Submersible pump cable (3 core)', 'Water & Sewage', 'Main store', 60, 'Metres', 50),
  IV('rv12', 'Borewell starter contactor', 'Water & Sewage', 'Main store', 3, 'Nos', 2),
  IV('rv13', 'Sand filter media (sand)', 'Water & Sewage', 'WTP', 6, 'Boxes', 4),
  IV('rv14', 'Activated carbon', 'Water & Sewage', 'WTP', 8, 'Boxes', 4),
  IV('rv15', 'Softener resin', 'Water & Sewage', 'WTP', 6, 'Boxes', 4),
  IV('rv16', 'Water treatment salt', 'Water & Sewage', 'WTP', 400, 'Kg', 300),
  IV('rv17', 'Sodium hypochlorite (WTP)', 'Water & Sewage', 'WTP', 60, 'Litres', 40),
  IV('rv18', 'Alum / PAC (coagulant)', 'Water & Sewage', 'WTP', 50, 'Kg', 40),
  IV('rv19', 'STP air diffuser membranes', 'Water & Sewage', 'STP', 8, 'Nos', 6),
  IV('rv20', 'STP polymer (dewatering)', 'Water & Sewage', 'STP', 25, 'Kg', 20),
  IV('rv21', 'STP sludge pump impeller', 'Water & Sewage', 'STP', 1, 'Nos', 1),
  IV('rv22', 'Silt trap cleaning bags', 'Water & Sewage', 'Main store', 50, 'Nos', 30),
  IV('rv23', 'Pool test kit reagents', 'Amenities', 'Clubhouse', 4, 'Boxes', 2),
  IV('rv24', 'Pool acid (pH minus)', 'Amenities', 'Clubhouse', 40, 'Litres', 25),
  IV('rv25', 'Pool algaecide', 'Amenities', 'Clubhouse', 20, 'Litres', 10),
  IV('rv26', 'Tennis / pickleball balls', 'Amenities', 'Clubhouse', 8, 'Boxes', 4),
  IV('rv27', 'Badminton rackets (spare)', 'Amenities', 'Clubhouse', 6, 'Nos', 4),
  IV('rv28', 'Squash balls', 'Amenities', 'Clubhouse', 4, 'Boxes', 2),
  IV('rv29', 'Yoga mats', 'Amenities', 'Clubhouse', 20, 'Nos', 15),
  IV('rv30', 'Fire extinguisher refill (ABC 4 kg)', 'Fire safety', 'Main store', 6, 'Nos', 6),
  IV('rv31', 'Fire hose pipe 15 m', 'Fire safety', 'Pump room', 4, 'Nos', 2),
  IV('rv32', 'Smoke detector heads', 'Fire safety', 'Main store', 10, 'Nos', 6),
  IV('rv33', 'Exterior paint (20 L)', 'Civil & Painting', 'Main store', 8, 'Nos', 4),
  IV('rv34', 'Waterproofing compound', 'Civil & Painting', 'Main store', 10, 'Kg', 10),
  IV('rv35', 'Cement bags', 'Civil & Painting', 'Main store', 20, 'Nos', 10),
  IV('rv36', 'Garbage bags (large)', 'Housekeeping', 'Main store', 600, 'Nos', 300),
  IV('rv37', 'Pest control spray (concentrate)', 'Housekeeping', 'Main store', 10, 'Litres', 5),
  IV('rv38', 'Drip irrigation lateral pipe', 'Gardening', 'Main store', 200, 'Metres', 100),
  IV('rv39', 'Lawn fertiliser (NPK)', 'Gardening', 'Main store', 100, 'Kg', 50),
  IV('rv40', 'Play equipment nuts / bolts kit', 'Landscape', 'Main store', 4, 'Sets', 2),
  IV('rv41', 'CCTV camera (spare 4 MP)', 'Security', 'Main store', 3, 'Nos', 3),
  IV('rv42', 'CAT6 cable box', 'Security', 'Main store', 2, 'Boxes', 1),
  IV('rv43', 'Boom barrier arm (spare)', 'Security', 'Main store', 2, 'Nos', 1),
  IV('rv44', 'UPS battery 12 V 42 Ah', 'Electrical', 'Main store', 8, 'Nos', 4),
  IV('rv45', 'Door lock set', 'Carpentry', 'Main store', 6, 'Nos', 4),
  IV('rv46', 'Plumbing fittings kit (CPVC)', 'Plumbing', 'Main store', 5, 'Sets', 3),
  IV('rv47', 'Lift door roller set', 'MEP', 'Main store', 2, 'Sets', 1),
  IV('rv48', 'AC gas (R32) cylinder', 'MEP', 'Main store', 1, 'Nos', 1),
];

const N = (id, group, name, phone, note = '', order = 0, hours = '24 × 7') => ({ id, group, name, phone, note, available: hours, sortOrder: order, active: true });
const IMPORTANT_NUMBERS = [
  N('in-1', 'Emergency', 'Police', '100', 'National emergency 112 also works', 1),
  N('in-2', 'Emergency', 'Fire brigade', '101', '', 2),
  N('in-3', 'Emergency', 'Ambulance', '108', '', 3),
  N('in-4', 'Emergency', 'Women helpline', '1091', '', 4),
  N('in-5', 'Emergency', 'Child helpline', '1098', '', 5),
  N('in-6', 'Emergency', 'Gas leak', '1906', 'LPG emergency', 6),
  N('in-7', 'Community office', 'Main gate security desk', '+91 98220 10020', 'Demo number, replace with the real desk', 10),
  N('in-8', 'Community office', 'Security supervisor', '+91 98220 10021', 'Demo number', 11),
  N('in-9', 'Community office', 'Facility Manager', '+91 98220 10010', 'Demo number', 12, '08:00–20:00'),
  N('in-10', 'Community office', 'Clubhouse reception', '+91 98220 10022', 'Demo number', 13, '06:00–22:00'),
  N('in-11', 'Community office', 'Association office', '+91 98220 10023', 'Demo number', 14, '10:00–18:00'),
  N('in-12', 'On-call technicians', 'Electrician on call', '+91 98220 10031', 'Demo number', 20),
  N('in-13', 'On-call technicians', 'Plumber on call', '+91 98220 10032', 'Demo number', 21),
  N('in-14', 'On-call technicians', 'Plant operator (WTP / STP)', '+91 98220 10033', 'Demo number', 22),
  N('in-15', 'On-call technicians', 'Lift service', '+91 98220 10034', 'Demo number, lift AMC vendor', 23),
  N('in-16', 'On-call technicians', 'DG set service (Cummins)', '+91 98220 10035', 'Demo number', 24),
  N('in-17', 'Utilities & services', 'Electricity complaints (TSSPDCL)', '1912', 'Replace with your electricity board', 30),
  N('in-18', 'Utilities & services', 'Water board', '155313', 'Replace with your water board', 31),
  N('in-19', 'Medical', 'Nearest hospital (casualty)', '+91 98220 10040', 'Committee to set the real hospital', 40),
  N('in-20', 'Medical', 'Nearest 24-hour pharmacy', '+91 98220 10041', 'Committee to set', 41),
];

/** Fold the reference data into the demo seed. Existing rows win (same id or same name), so nothing already seeded is duplicated or lost. */
export function mergeReferenceData(SEED, C) {
  const add = (col, rows, key = 'name') => { const have = new Set((SEED[col] || []).map((r) => String(r[key] ?? r.item).toLowerCase())); SEED[col] = [...(SEED[col] || []), ...rows.filter((r) => !have.has(String(r[key] ?? r.item).toLowerCase()))]; };
  add(C.FACILITIES, FACILITIES.map(([name, kind, notes], i) => ({ id: `facr${i + 1}`, name, kind, block: '', active: true, notes })));
  add(C.EQUIPMENT, EQUIPMENT, 'name');
  add(C.INVENTORY, INVENTORY, 'item');
  // every already-seeded asset gets its kind of repair, so "assets for this category" works from day one
  const kindOf = (a) => {
    const t = String(a.type || '').toLowerCase(); const ar = String(a.area || '').toLowerCase();
    if (/water pipeline|sewer|storm|manhole|water tank/.test(t)) return 'Water & Sewage';
    if (/zone|building/.test(t)) return /clubhouse/.test(ar) ? 'Amenities' : 'Civil & Painting';
    if (/camera|nvr|dvr/.test(t)) return 'Security';
    if (/street light|feeder|transformer|ups|panel|cable/.test(t)) return 'Electrical';
    if (/air conditioner/.test(t)) return 'MEP';
    if (/clubhouse/.test(ar)) return 'Amenities';
    if (/stp|wtp|borewell|rhp/.test(ar)) return 'Water & Sewage';
    return '';
  };
  SEED[C.EQUIPMENT] = SEED[C.EQUIPMENT].map((a) => (a.repairCategory ? a : { ...a, repairCategory: kindOf(a) || undefined }));
  SEED[C.IMPORTANT_NUMBERS] = IMPORTANT_NUMBERS;
  SEED[C.NUMBER_SECTIONS] = [['Emergency', '🚨'], ['Community office', '🏢'], ['On-call technicians', '🛠'], ['Utilities & services', '💡'], ['Medical', '🏥'], ['Other', '☎']].map(([name, icon], i) => ({ id: `ns${i + 1}`, name, icon, sortOrder: i + 1, active: true }));
  // coverage: one row per category with its sub-categories, keeping the vendor and coordinators already seeded
  const old = SEED[C.CATEGORY_MAP] || [];
  SEED[C.CATEGORY_MAP] = CATEGORY_TREE.map(([category, subCategories, assetLink, coordinator], i) => {
    const prev = old.find((r) => r.category === category) || {};
    return { id: prev.id || `cmr${i + 1}`, category, subCategories, assetLink: assetLink === 'Optional' ? undefined : assetLink, vendor: prev.vendor || (category === 'Security' ? 'SecureFirst' : VENDOR), coordinator: prev.coordinator || coordinator, notes: prev.notes || '' };
  }).concat(old.filter((r) => !CATEGORY_TREE.some(([c]) => c === r.category)));
  SEED[C.CATEGORY_MAP].forEach((r) => { if (r.assetLink === undefined) delete r.assetLink; });
}
