// How unit numbers are written - the same rules as the server (backend/api property/domain/UnitNaming.java), so a form or an import can say
// what is wrong before anything is saved. On the back end the server checks again; in the browser demo these checks are the only ones.
//
// Every unit number: no spaces at either end, single spaces inside, 1-40 characters of letters, digits, space, '.', '/' and '-', starting and
// ending with a letter or digit. Numbers that differ only in case (or spacing) are the same unit.
//
// A naming pattern (the community's, or a block's own) adds a shape:
//   {n}  a number of any length      {n:3}  exactly 3 digits, zero-padded      {floor} / {floor:2}  a floor number
//   {letter}  one letter             {block}  the block's code (or its name)
// e.g. "Villa {n}" -> Villa 7, Villa 135;  "{block}-{floor}{n:2}" -> A-1204 (block A, floor 12, flat 04).
// A community with villas and towers can allow both: "Villa {n} or {block}-{floor}{n:2}" (alternatives joined by "or" or "|"); a number
// follows the pattern when it fits any of them. A block's own pattern still wins for the units in that block.
import { getDataSource } from './storage/dataSource.js';

export const MAX = 40;
const CHARS = /^[A-Za-z0-9]([A-Za-z0-9 ./-]*[A-Za-z0-9])?$/;
const TOKEN = /\{(n|floor|letter|block)(?::([1-6]))?\}/g;
const quote = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

/** The number as it is stored: trimmed, single spaces. */
export const normalize = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
/** The key two numbers (or two names) are compared by: case and spacing ignored. */
export const key = (s) => normalize(s).toLowerCase();
export const sameName = (a, b) => key(a) === key(b);

/** The alternatives of a pattern: "Villa {n} or {block}-{floor}{n:2}" -> ['Villa {n}', '{block}-{floor}{n:2}']. */
export const alternatives = (pattern) => String(pattern ?? '').split(/\s+or\s+|\s*\|\s*/i).map((x) => x.trim()).filter(Boolean);
/** What is wrong with a pattern someone wants to save, or '' (a blank pattern is fine: only the character rules then). */
export function patternProblem(pattern) {
  const all = String(pattern ?? '').trim();
  if (!all) return '';
  if (all.length > 120) return 'A naming pattern is at most 120 characters';
  const alts = alternatives(all);
  if (alts.length > 4) return 'Up to 4 alternatives in a naming pattern';
  if (new Set(alts.map((a) => a.toLowerCase())).size !== alts.length) return 'The same alternative appears twice in the naming pattern';
  for (const a of alts) { const why = onePatternProblem(a); if (why) return alts.length > 1 ? `“${a}”: ${why}` : why; }
  return '';
}
function onePatternProblem(p) {
  if (p.length > 60) return 'A naming pattern is at most 60 characters';
  // alternatives written with a comma or "and" ("A-{n}, B-{n}"): they are joined with "or"
  if (/\}[^{}]*(\sand\s|[,;])[^{}]*\{/i.test(p)) return 'Join alternative patterns with “or”, e.g. Villa {n} or {block}-{floor}{n:2}';
  const rest = p.replace(TOKEN, '');
  if (/[{}]/.test(rest)) return 'Use only {n}, {n:3}, {floor}, {floor:2}, {letter} and {block} in a naming pattern';
  if (rest && !/^[A-Za-z0-9 ./-]*$/.test(rest)) return "A naming pattern may contain letters, digits, space, '.', '/' and '-' around its parts";
  const seen = []; let varies = false;
  for (const m of p.matchAll(TOKEN)) {
    if (seen.includes(m[1])) return `{${m[1]}} appears twice in the naming pattern`;
    seen.push(m[1]); if (m[1] !== 'block') varies = true;
  }
  if (!varies) return 'A naming pattern needs {n}, {floor} or {letter} - otherwise every unit would have the same number';
  return '';
}
/** The alternatives of a pattern that can be used in this block ({block} needs a block code). */
export const usableAlternatives = (pattern, block) => alternatives(pattern).filter((a) => !a.includes('{block}') || !!block);

function regex(pattern, block) {
  let out = ''; let at = 0;
  for (const m of pattern.matchAll(TOKEN)) {
    out += quote(pattern.slice(at, m.index));
    const w = m[2];
    out += m[1] === 'n' || m[1] === 'floor' ? (w ? `[0-9]{${w}}` : '[0-9]+') : m[1] === 'letter' ? '[A-Za-z]' : quote(block || '');
    at = m.index + m[0].length;
  }
  return new RegExp(`^${out}${quote(pattern.slice(at))}$`, 'i');
}

/** The number for {n} = n (and {floor} = floor); null when the pattern needs a part that is not given ({letter}, or {block} without a block). */
export function make(pattern, block, floor, n) {
  const alts = alternatives(pattern);
  if (alts.length > 1) { for (const a of alts) { const x = make(a, block, floor, n); if (x != null) return x; } return null; }
  pattern = alts[0] || '';
  let out = ''; let at = 0;
  const pad = (v, w) => (w ? String(v).padStart(Number(w), '0') : String(v));
  for (const m of pattern.matchAll(TOKEN)) {
    out += pattern.slice(at, m.index);
    if (m[1] === 'n') out += pad(n, m[2]);
    else if (m[1] === 'floor') { if (floor == null || floor === '') return null; out += pad(floor, m[2]); }
    else if (m[1] === 'letter') return null;
    else { if (!block) return null; out += block; }
    at = m.index + m[0].length;
  }
  return normalize(out + pattern.slice(at));
}
export const example = (pattern, block) => make(pattern, block || 'A', 1, 1) || make(String(pattern).replace('{letter}', 'B'), block || 'A', 1, 1);
export const usesFloor = (pattern) => /\{floor(:\d)?\}/.test(alternatives(pattern)[0] || '');

/** What is wrong with a number, or ''. `pattern` may be blank; `block` is the block's code (or name) for {block}. */
export function unitProblem(unitNo, pattern, block) {
  const u = normalize(unitNo);
  if (!u) return 'Enter the unit number';
  if (u.length > MAX) return `A unit number is at most ${MAX} characters`;
  if (!CHARS.test(u)) return "Use letters, digits, space, '.', '/' and '-' in a unit number, starting and ending with a letter or digit";
  const p = String(pattern ?? '').trim();
  if (p) {
    const alts = alternatives(p);
    if (alts.some((a) => regex(a, block).test(u) && (!a.includes('{block}') || block))) return '';
    if (alts.every((a) => a.includes('{block}')) && !block) return 'This naming pattern uses {block}: put the unit in a block first';
    const ex = alts.map((a) => example(a, block)).filter(Boolean);
    return `“${u}” does not follow the naming pattern “${p}”${ex.length ? ` (for example ${ex.join(' or ')})` : ''}`;
  }
  return '';
}

/** The pattern a unit in this block follows: the block's own, else the community's. `blocks` are rows with name, code, unitPattern. */
export function ruleFor(blockName, blocks, communityPattern) {
  const b = (blocks || []).find((x) => sameName(x.name, blockName));
  return { pattern: (b?.unitPattern && String(b.unitPattern).trim()) || communityPattern || '', block: b ? (b.code || b.name) : '' };
}

/**
 * Checks units about to be saved (one, a bulk range or an import) against the rules and against `existing` (and each other). Returns
 * { rows (numbers tidied), problems: [{ unit, message }], duplicates: [unit] }; a row whose id is an existing unit's is that unit being changed.
 */
export function checkUnits(rows, { existing = [], blocks = [], communityPattern = '' } = {}) {
  const taken = new Map(existing.map((u) => [key(u.unit), u.id]));
  const out = []; const problems = []; const duplicates = [];
  for (const r of rows) {
    const unit = normalize(r.unit);
    const old = r.id ? existing.find((u) => u.id === r.id) : null;
    if (!old || old.unit !== unit) {                                   // new, or its number changed (a change in case too)
      const rule = ruleFor(r.zone, blocks, communityPattern);
      const why = unitProblem(unit, rule.pattern, rule.block);
      if (why) { problems.push({ unit: unit || '—', message: why }); continue; }
      const other = taken.get(key(unit));
      if (other && other !== r.id) { duplicates.push(unit); continue; }
    }
    taken.set(key(unit), r.id || `new:${unit}`);
    out.push({ ...r, unit });
  }
  return { rows: out, problems, duplicates };
}

// ---- the community's pattern: the browser demo keeps it in the community settings, the back end in its own setting --------------------------------
/** { pattern, version } */
export async function loadCommunityPattern() {
  if (getDataSource().mode === 'v2') { const { v2Naming } = await import('./storage/v2/V2ApiAdapter.js'); return v2Naming(); }
  const { storage, COLLECTIONS } = await import('./storage/index.js');
  const row = (await storage.list(COLLECTIONS.COMMUNITY_CONFIG))[0];
  return { pattern: row?.unitPattern || '', version: row?.recVersion ?? 0 };
}
export async function saveCommunityPattern(pattern, version) {
  const p = String(pattern ?? '').trim();
  const why = patternProblem(p); if (why) throw new Error(why);
  if (getDataSource().mode === 'v2') { const { v2SetNaming } = await import('./storage/v2/V2ApiAdapter.js'); return v2SetNaming(p, version); }
  const { secureStorage } = await import('./storage/secureStorage.js');
  const { storage, COLLECTIONS } = await import('./storage/index.js');
  const row = (await storage.list(COLLECTIONS.COMMUNITY_CONFIG))[0] || {};
  const saved = await secureStorage.put(COLLECTIONS.COMMUNITY_CONFIG, { ...row, unitPattern: p }, { label: 'Community setup', summaryOf: () => (p ? `Unit naming pattern: ${p}` : 'Removed the unit naming pattern') });
  return { pattern: saved?.unitPattern ?? p, version: saved?.recVersion ?? 0 };
}
