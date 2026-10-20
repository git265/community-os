// The authenticated principal + schema cache, set synchronously by AppProvider
// on every render (so child effects that run before the provider's own
// effects still see who is calling). Think of it as the JWT claims a Spring
// Boot filter would put on the request: { roleId, role, name, unit }.
let principal = null;
let schemaCache = [];

// SERVER ONLY: per-request context (AsyncLocalStorage) instead of module globals, so concurrent requests never see each other's principal.
let resolver = null;
export const setContextResolver = (fn) => { resolver = fn; };
export function setPrincipal(p) { principal = p; }
export function getPrincipal() { return resolver ? (resolver()?.principal ?? null) : principal; }
export function setSchemaCache(s) { schemaCache = s || []; }
export function getSchema(collection) { return (resolver ? (resolver()?.schemas || []) : schemaCache).find((s) => s.id === collection); }
