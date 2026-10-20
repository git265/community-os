// Document repository folders: a tree stored flat ({id, name, parentId}). Documents point at one folder with `folderId`.
export const NONE = '__none__'; // pseudo-folder: documents not filed in any folder
export const childrenOf = (folders, parentId = '') => folders.filter((f) => (f.parentId || '') === parentId).sort((a, b) => a.name.localeCompare(b.name));
export function descendantIds(folders, id) {
  const out = [id];
  for (const c of childrenOf(folders, id)) out.push(...descendantIds(folders, c.id));
  return out;
}
export function pathOf(folders, id) {
  const parts = []; let cur = folders.find((f) => f.id === id); let n = 0;
  while (cur && n++ < 20) { parts.unshift(cur.name); cur = folders.find((f) => f.id === cur.parentId); }
  return parts;
}
/** Flat list for pickers: [{id, label:'Legal / Contracts', depth}] in tree order. */
export function flatTree(folders, parentId = '', depth = 0, trail = []) {
  return childrenOf(folders, parentId).flatMap((f) => [{ id: f.id, label: [...trail, f.name].join(' / '), depth }, ...flatTree(folders, f.id, depth + 1, [...trail, f.name])]);
}
export const STARTER_FOLDERS = ['Governance & minutes', 'Legal', 'Vendor contracts', 'Finance & audits', 'Villa documents'];
