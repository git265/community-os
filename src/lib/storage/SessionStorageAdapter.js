// Implements StorageAdapter on top of window.sessionStorage.
// Data lives only for the browser tab's session - refresh keeps it, closing
// the tab clears it. That's intentional for this phase: it lets the whole
// app be demoed/used without any backend, while every read/write already
// goes through the same async, collection+record shaped API the real
// backend will use, so nothing else has to change when we swap adapters.
//
// MULTI-COMMUNITY: keys are  communityos:<community>:<collection>  so each community is an isolated data set.
// The platform's own registry (communities) uses  communityos:platform:<collection>.

import { runQuery } from './queryEngine.js';
import { getCommunity, PLATFORM } from '../community.js';
import { spillLoad, spillSave, spillRemove } from './spillStore.js';
import { blobStoreAvailable, blobList, blobGet, blobPut, blobRemove, blobClear } from './fileBlobStore.js';

const isBlob = (collection) => collection === 'files' && blobStoreAvailable();

const KEY_PREFIX = 'communityos:';
/** Collections that belong to the platform, not to any one community. */
export const PLATFORM_COLLECTIONS = new Set(['communities']);

function keyFor(slug, collection) {
  return `${KEY_PREFIX}${PLATFORM_COLLECTIONS.has(collection) ? PLATFORM : slug}:${collection}`;
}

// sessionStorage holds about 5 MB for the whole tab. A very large community (thousands of units x months of dues) does not
// fit, so a collection that no longer fits is kept in MEMORY instead (it lives until the tab closes or reloads) and the app is
// told once through the 'communityos:storage-overflow' event. This only matters for the browser-only demo adapter: the real
// back end (Spring Boot + PostgreSQL) has no such limit.
const spilled = new Map(); // storage key -> records
let overflowAnnounced = false;

function readCollection(slug, collection) {
  const key = keyFor(slug, collection);
  if (spilled.has(key)) return spilled.get(key).slice();
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error(`[SessionStorageAdapter] failed to read ${collection}`, err);
    return [];
  }
}

function writeCollection(slug, collection, records) {
  const key = keyFor(slug, collection);
  if (spilled.has(key)) { spilled.set(key, records); spillSave(key, () => spilled.get(key)); return; }
  try {
    sessionStorage.setItem(key, JSON.stringify(records));
  } catch (err) {
    spilled.set(key, records); spillSave(key, () => spilled.get(key));
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
    if (!overflowAnnounced) { overflowAnnounced = true; try { window.dispatchEvent(new CustomEvent('communityos:storage-overflow', { detail: { collection } })); } catch { /* ignore */ } }
  }
}

export const storageOverflowed = () => spilled.size > 0;
/** Call once before the app starts: bring back the big collections this tab spilled before a reload. */
export async function hydrateSpill() {
  const saved = await spillLoad();
  Object.entries(saved).forEach(([k, v]) => spilled.set(k, v));
  if (spilled.size) { overflowAnnounced = true; setTimeout(() => window.dispatchEvent(new CustomEvent('communityos:storage-overflow', { detail: {} })), 0); }
}

/** The adapter bound to one community; `slug` is a function so the default one follows the tab's community. */
function make(slugOf) {
  return {
    async list(collection) {
      if (isBlob(collection)) return blobList(slugOf());
      return readCollection(slugOf(), collection);
    },

    async query(collection, params) {
      if (isBlob(collection)) return runQuery(await blobList(slugOf()), params);
      return runQuery(readCollection(slugOf(), collection), params);
    },

    async get(collection, id) {
      if (isBlob(collection)) return blobGet(slugOf(), id);
      return readCollection(slugOf(), collection).find((r) => r.id === id) ?? null;
    },

    async put(collection, record) {
      const slug = slugOf();
      if (isBlob(collection)) {
        const old = await blobGet(slug, record.id);
        const stamped = { ...(old || {}), ...record, updatedAt: new Date().toISOString() };
        await blobPut(slug, stamped);
        return stamped;
      }
      const records = readCollection(slug, collection);
      const idx = records.findIndex((r) => r.id === record.id);
      const stamped = { ...record, updatedAt: new Date().toISOString() };
      if (idx === -1) {
        records.push(stamped);
      } else {
        records[idx] = { ...records[idx], ...stamped };
      }
      writeCollection(slug, collection, records);
      return stamped;
    },

    /** Upsert many records with ONE read and ONE write (a bill run for 2,000 units must not rewrite the whole collection 2,000 times). */
    async putMany(collection, list) {
      if (isBlob(collection)) { for (const r of list) await this.put(collection, r); return list; }
      const slug = slugOf(); const now = new Date().toISOString();
      const records = readCollection(slug, collection);
      const at = new Map(records.map((r, i) => [r.id, i]));
      const out = list.map((r) => ({ ...r, updatedAt: now }));
      for (const r of out) { const i = at.get(r.id); if (i === undefined) { at.set(r.id, records.length); records.push(r); } else records[i] = { ...records[i], ...r }; }
      writeCollection(slug, collection, records);
      return out;
    },

    async remove(collection, id) {
      const slug = slugOf();
      if (isBlob(collection)) { await blobRemove(slug, id); return; }
      writeCollection(slug, collection, readCollection(slug, collection).filter((r) => r.id !== id));
    },

    async replaceAll(collection, records) {
      if (isBlob(collection)) { await blobClear(slugOf()); for (const r of records) await blobPut(slugOf(), r); return; }
      writeCollection(slugOf(), collection, records);
    },
  };
}

/** @type {import('./StorageAdapter').StorageAdapter} */
export const SessionStorageAdapter = {
  ...make(getCommunity),

  /** The same API against ANOTHER community - for the platform console (provisioning, member lists) only. */
  forCommunity(slug) { return make(() => slug); },

  /** Remove every row of one community (demo reset). */
  clearCommunity(slug) {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(`${KEY_PREFIX}${slug}:`))
      .forEach((k) => sessionStorage.removeItem(k));
    const gone = [...spilled.keys()].filter((k) => k.startsWith(`${KEY_PREFIX}${slug}:`));
    gone.forEach((k) => spilled.delete(k)); spillRemove(gone);
    if (blobStoreAvailable()) blobClear(slug).catch(() => {});
  },
};
