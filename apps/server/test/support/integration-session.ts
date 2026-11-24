import { encodeSession, type AuthConfig } from '@opencrane/auth';

export function integrationSessionHeaders(config: AuthConfig) {
  function headers(sub: string, orgId = 'org-acme') {
    const now = Math.floor(Date.now() / 1000);
    const session = { sub, orgId, roles: ['owner'], authTime: now, exp: now + 60 };
    const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
    return { cookie };
  }
  return headers;
}
