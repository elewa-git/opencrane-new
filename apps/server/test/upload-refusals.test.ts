import { encodeSession } from '@opencrane/auth';
import { expect, it } from 'vitest';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

it('refuses an upload over 20 MiB with HTTP 413 and a clear size message', async () => {
  const config = { ...testAuthConfig(), expectedOrgId: 'org' };
  const app = buildServer(config);
  const now = Math.floor(Date.now() / 1000);
  const session = {
    sub: 'alice',
    orgId: config.expectedOrgId,
    roles: [],
    authTime: now,
    exp: now + 300,
  };
  const cookie = encodeSession(config, session);
  const headers = {
    origin: new URL(config.redirectUri).origin,
    'content-type': 'application/octet-stream',
    'x-file-name': 'notes.txt',
    'idempotency-key': 'oversize',
    cookie: `${config.cookieName}=${cookie}`,
  };
  const request = {
    method: 'POST' as const,
    url: '/api/conversations/conversation/files',
    headers,
    payload: Buffer.alloc(20 * 1024 * 1024 + 1),
  };

  try {
    const response = await app.inject(request);

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({
      status: 'refused',
      error: 'File too large. Maximum size is 20 MiB.',
    });
  } finally {
    await app.close();
  }
});
