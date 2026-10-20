// Who loses service when an asset fails, and which valve isolates it. Nothing is guessed from the drawing: the team says, on the asset,
// which blocks or units it serves ("Serves") and which valve to close ("Close this valve first"). The map then shows the answer.
const norm = (s) => String(s || '').trim().toLowerCase();

/** Units served by a list of names: a block name means every unit in that block, anything else is read as one unit number. */
export function unitsFor(names, properties) {
  const set = new Set(); const blocks = new Set(); const direct = new Set();
  const want = (names || []).map(norm).filter(Boolean);
  for (const p of properties || []) {
    if (want.includes(norm(p.zone))) { set.add(p.unit); blocks.add(p.zone); }
    else if (want.includes(norm(p.unit))) { set.add(p.unit); direct.add(p.unit); }
  }
  return { units: [...set].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })), blocks: [...blocks], direct: [...direct] };
}

/**
 * impactOf(asset, assets, properties) -> { configured, units, blocks, valve, valveId, names }.
 * A valve with no list of its own serves whatever the pipes it closes serve.
 */
export function impactOf(asset, assets, properties) {
  const own = Array.isArray(asset?.serves) ? asset.serves.filter(Boolean) : [];
  let names = own;
  if (!names.length && asset?.type === 'Valve') names = [...new Set((assets || []).filter((a) => a.closeValve === asset.name).flatMap((a) => a.serves || []))];
  const valve = asset?.closeValve ? (assets || []).find((a) => a.name === asset.closeValve && a.id !== asset.id) || null : null;
  const r = unitsFor(names, properties);
  return { configured: names.length > 0, names, units: r.units, blocks: r.blocks, valve, valveId: valve?.id || '' };
}
