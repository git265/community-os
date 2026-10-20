// Lets the server import the UI's pure policy modules (src/lib/security/authz.js and friends) UNCHANGED, so the rules the screens
// show and the rules the server enforces are one piece of code. Vite supplies `import.meta.env` in the browser; here it is empty.
// The UI imports its seed data as `import x from './file.json'` (Vite); Node wants `with { type: 'json' }`: added here for src/ files.
export async function load(url, context, next) {
  if (url.includes('/src/') && url.endsWith('.json')) return next(url, { ...context, importAttributes: { ...(context.importAttributes || {}), type: 'json' } });
  const r = await next(url, context);
  if (url.includes('/src/') && r.format === 'module' && r.source) {
    const text = String(r.source).replace(/import\.meta\.env/g, '({})');
    return { ...r, source: text };
  }
  return r;
}
