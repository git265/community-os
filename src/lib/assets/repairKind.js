// Which maintenance categories an asset belongs to. An asset has ONE main kind of repair (repairCategory) and may be filed under
// more categories (alsoCategories) when more than one kind of team looks after it, e.g. a CCTV camera: Security and Electrical.

/** Which maintenance category usually fixes this kind of asset (a guess from its type, used when none is recorded). */
export function categoryFor(type, cats) {
  const t = String(type || '').toLowerCase();
  const want = /light|feeder|transformer|cable|panel|ups|motor|sensor/.test(t) ? ['Electrical', 'MEP']
    : /camera|nvr|network|fire/.test(t) ? ['Security', 'MEP']
      : /pipe|water|sewer|drain|valve|tank|manhole|pump|blower/.test(t) ? ['Plumbing', 'MEP']
        : /garden|park|landscape/.test(t) ? ['Landscape', 'Gardening'] : ['MEP', 'General'];
  return want.find((w) => cats.includes(w)) || cats[0] || '';
}

/** The main maintenance category for an asset: the one recorded on it, else a guess from its type. */
export const repairKindOf = (asset, cats) => (asset?.repairCategory && cats.includes(asset.repairCategory) ? asset.repairCategory : categoryFor(asset?.type, cats));

/** Every category the asset is offered under when a task is raised. */
export const assetCategories = (asset, cats) => [...new Set([repairKindOf(asset, cats), ...(Array.isArray(asset?.alsoCategories) ? asset.alsoCategories : [])].filter(Boolean))];
