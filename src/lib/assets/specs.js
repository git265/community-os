// What to record about an asset depends on WHAT it is: a street light has wattage and pole height, a pump has HP and flow, a pipe has
// diameter and material. Each kind has a short list of spec names (built-in, and the community can change them per kind in
// Infrastructure -> Plans & layers). A kind with no list gets a generic few; any asset can also carry extra specs of its own.
export const SPEC_DEFAULTS = {
  'Street light': ['Wattage (W)', 'Pole height (m)', 'Lamp type', 'Poles in this group'],
  'Pump': ['Power (HP)', 'Flow (LPM)', 'Head (m)', 'Phase'],
  'Motor': ['Power (kW)', 'Speed (RPM)', 'Voltage (V)', 'Phase'],
  'Blower': ['Power (kW)', 'Air flow (m³/h)', 'Pressure (kPa)'],
  'Panel / starter': ['Current rating (A)', 'Type', 'Phase'],
  'Valve': ['Size (mm)', 'Type', 'Pressure rating'],
  'Sensor / meter': ['Measures', 'Range', 'Output'],
  'CCTV camera': ['Resolution (MP)', 'Lens (mm)', 'Night vision', 'Analog / IP'],
  'NVR / DVR': ['Channels', 'Storage (TB)', 'Retention (days)'],
  'UPS / battery': ['Capacity (kVA)', 'Batteries', 'Battery voltage (V)', 'Backup hours'],
  'Feeder pillar': ['Rating (A)', 'Ways', 'Phase'],
  'Transformer / HT': ['Capacity (kVA)', 'Primary / secondary voltage', 'Cooling'],
  'Water pipeline': ['Diameter (mm)', 'Material', 'Pressure class', 'Length (m)'],
  'Sewer line': ['Diameter (mm)', 'Material', 'Gradient'],
  'Storm drain': ['Width (mm)', 'Type'],
  'Electrical cable': ['Size (sq mm)', 'Cores', 'Voltage grade', 'Length (m)'],
  'Manhole / chamber': ['Depth (m)', 'Cover type'],
  'Water tank': ['Capacity (L)', 'Material', 'Level sensor'],
  'Air conditioner': ['Capacity (TR)', 'Star rating', 'Refrigerant'],
  'Lift': ['Capacity (persons)', 'Floors served', 'Speed (m/s)'],
  'Fire safety': ['Kind (extinguisher, hydrant …)', 'Capacity (kg)', 'Refill due'],
  'Network / Wi-Fi': ['Bandwidth (Mbps)', 'SSID', 'IP address'],
};
export const GENERIC_SPECS = ['Capacity / size', 'Material', 'Voltage / power'];

const tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
const parse = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/)).map((x) => String(x).trim()).filter(Boolean);

/**
 * The spec names for a kind. Order of preference: the community's own list for that kind -> the built-in list for the same kind ->
 * the built-in list of the closest kind by name ("Submersible pump" -> Pump) -> a generic few.
 * `layerRows` are rows of the map-layer collection ({ type, specs }).
 */
export function specNamesFor(type, layerRows = []) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return { names: GENERIC_SPECS, source: 'generic' };
  const own = layerRows.find((r) => String(r.type || '').trim().toLowerCase() === t && parse(r.specs).length);
  if (own) return { names: parse(own.specs), source: 'yours' };
  const exact = Object.keys(SPEC_DEFAULTS).find((k) => k.toLowerCase() === t);
  if (exact) return { names: SPEC_DEFAULTS[exact], source: 'built-in' };
  const mine = tokens(type);
  const near = Object.keys(SPEC_DEFAULTS).find((k) => tokens(k).some((w) => mine.includes(w)));
  if (near) return { names: SPEC_DEFAULTS[near], source: `like ${near}` };
  return { names: GENERIC_SPECS, source: 'generic' };
}
export const parseSpecs = (v) => { try { const o = typeof v === 'string' ? JSON.parse(v || '{}') : v || {}; return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
/** "Power 7.5 kW · Phase 3" for lists and the asset panel. */
export const specSummary = (asset, max = 4) => Object.entries(parseSpecs(asset?.specs)).filter(([, v]) => String(v).trim()).slice(0, max).map(([k, v]) => `${k.replace(/\s*\(.*\)$/, '')} ${v}`).join(' · ');
export const specNamesText = (names) => names.join(', ');
export const parseNames = parse;
