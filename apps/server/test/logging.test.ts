import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogDestination } from '@opencrane/observability';
import { createServerLogger, redactedRequestSerializer } from '../src/logging.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('redactedRequestSerializer', () => {
  it('keeps the method, host and port, drops everything else, and redacts the url by itself (the logger would redact it too, so this is checked here, not through the logger)', () => {
    const request = {
      method: 'GET',
      url: '/healthz?token=SECRET_REQ&keep=1',
      host: 'localhost:8080',
      socket: { remotePort: 51234 },
      headers: { authorization: 'Bearer SECRET_HEADER' },
    };

    expect(redactedRequestSerializer(request)).toEqual({
      method: 'GET',
      url: '/healthz?token=[Redacted]&keep=1',
      host: 'localhost:8080',
      remotePort: 51234,
    });
  });

  it('does not throw for a request with no socket (a throwing serializer takes the process down)', () => {
    expect(redactedRequestSerializer({ method: 'GET', url: '/x', host: 'h' })).toMatchObject({ method: 'GET', url: '/x' });
  });
});

describe('createServerLogger', () => {
  it('withholds history paths and every query filter in all HTTP log lines, including fallback methods and trailing slashes', async () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    const chunks: string[] = [];
    const app = buildServer(testAuthConfig(), { logDestination: { write: (line: string) => void chunks.push(line) } });
    try {
      for (const path of ['/api/org/history', '/api/conversations/private-conversation-canary/history']) {
        for (const suffix of ['', '/']) {
          for (const method of ['GET', 'POST', 'OPTIONS'] as const) {
            const response = await app.inject({ method,
              url: `${path}${suffix}?requestId=private-request-canary&turnId=private-turn-canary&unknown=private-filter-canary` });
            expect(response.statusCode).toBe(method === 'GET' && suffix === '' ? 401 : 404);
          }
        }
      }
      expect(chunks.length).toBeGreaterThan(12);
      for (const line of chunks) expect(line).not.toContain('canary');
    } finally { await app.close(); }
  });

  it('takes its level from LOG_LEVEL, and falls back to info', () => {
    vi.stubEnv('LOG_LEVEL', 'warn');
    expect(createServerLogger().level).toBe('warn');

    vi.stubEnv('LOG_LEVEL', undefined);
    expect(createServerLogger().level).toBe('info');
  });

  it('uses the request serializer for a logged req field', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    const chunks: string[] = [];
    const destination: LogDestination = { write: (msg: string) => void chunks.push(msg) };

    createServerLogger(destination).info({ req: { method: 'GET', url: '/x', host: 'h', headers: { cookie: 'a=b' } } }, 'incoming request');

    expect(JSON.parse(chunks.join('')) as unknown).toMatchObject({ req: { method: 'GET', url: '/x', host: 'h' } });
    expect(chunks.join('')).not.toContain('cookie');
  });
});
