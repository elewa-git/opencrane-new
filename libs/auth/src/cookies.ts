// Small Set-Cookie / Cookie helpers. Written by hand instead of pulling in a
// cookie library, since Fastify has no built-in cookie support and this is
// only a few lines either way.

export interface CookieAttributes {
  /** Defaults to true. Set false only for a cookie JavaScript must read. */
  httpOnly?: boolean;
  /** Defaults to true. Set false only for local http:// development. */
  secure?: boolean;
  path?: string;
  /** Omit for a session-only cookie; 0 clears it. */
  maxAgeSeconds?: number;
}

/** Builds one Set-Cookie header value. Always SameSite=Lax. */
export function serializeCookie(name: string, value: string, attrs: CookieAttributes = {}): string {
  const parts = [`${name}=${value}`, `Path=${attrs.path ?? '/'}`];
  if (attrs.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${attrs.maxAgeSeconds}`);
  }
  if (attrs.httpOnly !== false) {
    parts.push('HttpOnly');
  }
  if (attrs.secure !== false) {
    parts.push('Secure');
  }
  parts.push('SameSite=Lax');
  return parts.join('; ');
}

/** Builds a Set-Cookie header value that deletes the named cookie. */
export function clearCookie(name: string, attrs: Pick<CookieAttributes, 'path' | 'secure' | 'httpOnly'> = {}): string {
  return serializeCookie(name, '', { ...attrs, maxAgeSeconds: 0 });
}

/** Parses a request's `Cookie` header into a name -> value map. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    if (!name) continue;
    cookies[name] = safeDecode(rawValue);
  }
  return cookies;
}

// A tampered-with cookie can contain a stray "%" that is not a valid escape
// sequence; fall back to the raw value rather than let that crash parsing.
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
