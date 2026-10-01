import { URL } from 'node:url';

// Copied from OpenCrane 1 (10abd0ef6)
// libs/backend/server/infra/auth/src/sessions/session.ts (`_sanitizeReturnTo`);
// changed: the old version only looked at the raw string for a leading "/"
// and "//". Browsers read "\" as "/" and ignore tabs and newlines, so
// "/\evil.example" and "/<tab>/evil.example" got through. This version
// resolves the value the way a browser would (`new URL`), keeps it only if
// it stays on our own origin, and then checks the resolved path itself.

// Only used as the base a relative `returnTo` is resolved against.
const SANITIZE_BASE_ORIGIN = 'http://opencrane-auth.invalid';

/**
 * Reduces a post-login return target to something safe to redirect to.
 *
 * Only a same-origin path is kept (as `pathname + search + hash`). Anything
 * else becomes `/`: an absolute URL, `//evil.example`, a backslash or
 * control-character trick, or nothing at all. Without this, a crafted
 * `returnTo` could send a person to another site right after a real login.
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
  // Tidying dot-segments can leave a path that starts with "//": "/.//evil.example"
  // resolves to the path "//evil.example", which a browser then reads as a
  // different host. Refuse it.
  if (resolved.pathname.startsWith('//')) {
    return '/';
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
