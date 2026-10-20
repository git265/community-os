// Which community (tenant) this browser tab is looking at, taken from the WEB ADDRESS:
//
//   lapaloma.communityos.app            sub-domain  (production; also  lapaloma.localhost  in development)
//   host/c/lapaloma                     path        (single-host installs and this demo)
//   host/platform  or  platform.host    the Platform Admin console (not a community)
//   plain host / localhost              the default community (VITE_DEFAULT_COMMUNITY, 'la-paloma')
//
// Every storage key and (later) every API call carries this id, so one community can never read another's rows.
// The platform administrator and a person's list of communities live outside any community (see lib/platform).

export const PLATFORM = 'platform';
export const DEFAULT_COMMUNITY = import.meta.env.VITE_DEFAULT_COMMUNITY || 'la-paloma';
export const RESERVED_SLUGS = ['platform', 'www', 'app', 'api', 'admin', 'c', 'static', 'assets', 'login'];
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$/;

const IP_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const labels = (host) => host.split('.');

/** Sub-domains name a community only on a real domain (a.b.c) or on *.localhost; IPs and plain localhost use the path. */
export function usesSubdomains(loc = window.location) {
  const h = loc.hostname;
  if (IP_RE.test(h) || h === 'localhost' || !h.includes('.')) return false;
  return labels(h).length >= 3 || h.endsWith('.localhost');
}

export function resolveSlug(loc = window.location) {
  const h = loc.hostname;
  if (usesSubdomains(loc)) {
    const first = labels(h)[0];
    if (first === PLATFORM) return PLATFORM;
    if (!['www', 'app'].includes(first)) return first;
  }
  const path = loc.pathname.replace(/\/+$/, '');
  if (path === '/platform' || path.startsWith('/platform/')) return PLATFORM;
  const m = /^\/c\/([^/]+)/.exec(loc.pathname);
  if (m) return decodeURIComponent(m[1]).toLowerCase();
  return DEFAULT_COMMUNITY;
}

/** The address people use to reach a community (or the platform console). */
export function communityUrl(slug, loc = window.location) {
  if (usesSubdomains(loc)) {
    const l = labels(loc.hostname);
    l[0] = slug;
    return `${loc.protocol}//${l.join('.')}${loc.port ? `:${loc.port}` : ''}/`;
  }
  const base = `${loc.protocol}//${loc.host}`;
  if (slug === PLATFORM) return `${base}/platform`;
  if (slug === DEFAULT_COMMUNITY && !/^\/c\//.test(loc.pathname)) return `${base}/`;
  return `${base}/c/${encodeURIComponent(slug)}`;
}

let current = resolveSlug();
let communityResolver = null;
/** SERVER ONLY: the community of the request being served. */
export const setCommunityResolver = (fn) => { communityResolver = fn; };
export const getCommunity = () => (communityResolver ? communityResolver() : current);
/** Tests / tools only: the tab is normally bound to one community for its whole life. */
export const setCommunity = (slug) => { current = slug; };
