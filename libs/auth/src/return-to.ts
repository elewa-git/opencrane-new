import { URL } from 'node:url';

// Copied from OpenCrane 1 (10abd0ef6); checks return paths as browsers read them.

// Only used as the base a relative `returnTo` is resolved against.
const SANITIZE_BASE_ORIGIN = 'http://opencrane-auth.invalid';

/**
 * Keeps a safe same-origin path to use after login.
 *
 * Return `/` for an outside URL, a path that looks like another host, unsafe
 * characters or an empty value. Otherwise keep the path, query and fragment.
 * This stops a crafted `returnTo` value sending someone to another site.
 */
export function sanitizeReturnTo(returnTo: string | undefined): string {
  if (!returnTo) {
    return '/';
  }
  let resolved: URL;
  try {
    resolved = new URL(returnTo, SANITIZE_BASE_ORIGIN);
  } catch {
    return '/';
  }
  if (resolved.origin !== SANITIZE_BASE_ORIGIN) {
    return '/';
  }
  // Removing dot segments can turn `/.//evil.example` into `//evil.example`.
  // Browsers read that as another host, so reject it.
  if (resolved.pathname.startsWith('//')) {
    return '/';
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
