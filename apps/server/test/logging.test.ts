import { request } from 'node:http';
import { record } from './record.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogDestination } from '@opencrane/observability';
import { createServerLogger, redactedRequestSerializer } from '../src/logging.ts';
import { buildServer } from '../src/server.ts';
import { testAuthConfig } from './support/test-auth-config.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('redactedRequestSerializer', () => {
  it('keeps the method, host and port, and drops the entire URL query', () => {
    const request = {
      method: 'GET',
      url: '/healthz?token=SECRET_REQ&keep=1',
      host: 'localhost:8080',
      socket: { remotePort: 51234 },
      headers: { authorization: 'Bearer SECRET_HEADER' },
    };

    expect(redactedRequestSerializer(request)).toEqual({
      method: 'GET',
      url: '/healthz',
      host: 'localhost:8080',
      remotePort: 51234,
    });
  });

  it('does not throw for a request with no socket (a throwing serializer takes the process down)', () => {
    expect(redactedRequestSerializer({ method: 'GET', url: '/x', host: 'h' })).toMatchObject({ method: 'GET', url: '/x' });
  });
});

describe('createServerLogger', () => {
  const queries = [
    "?requestId=prefix'private-request-canary",
    '?requestId=prefix"private-request-canary',
    '?%72equestId=prefix%27private-request-canary%22',
    '?requestId=prefix#private-request-canary',
    '?requestId=prefix?unknown=private-request-canary',
    '?unknown=private-filter-canary&turnId=private-turn-canary',
  ];
  it.each(['GET', 'POST', 'OPTIONS'].flatMap(method => queries.map(query => ({ method, query }))))(
    'logs paths only over real HTTP for $method $query, including fallbacks and trailing slashes', async ({ method, query }) => {
      vi.stubEnv('LOG_LEVEL', 'info');
      const chunks: string[] = [];
      const app = buildServer(testAuthConfig(), { logDestination: { write: (line: string) => void chunks.push(line) } });
      try {
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (address === null || typeof address === 'string') throw new Error('expected a network address');
        for (const [path, loggedPath] of [
          ['/api/org/history', '/api/org/history'],
          ['/healthz', '/healthz'],
          ['/nope', '/nope'],
          ['/api/conversations/private-conversation-canary/history', '/api/conversations/:conversationId/history'],
        ] as const) {
          for (const slash of ['', '/', '//']) {
            chunks.length = 0;
            const status = await new Promise<number | undefined>((resolve, reject) => {
              const req = request({ host: '127.0.0.1', port: address.port, method, path: `${path}${slash}${query}` }, res => {
                res.resume();
                res.on('end', () => resolve(res.statusCode));
              });
              req.on('error', reject);
              req.end();
            });
            const expectedStatus = method === 'GET' && slash === '' && path !== '/nope'
              ? path === '/healthz' ? 200 : 401
              : 404;
            expect(status).toBe(expectedStatus);
            const lines = chunks.flatMap(chunk => chunk.trim().split('\n')).map(line => record(JSON.parse(line)));
            const incoming = lines.find(line => line['msg'] === 'incoming request');
            expect.soft(record(incoming?.['req'])['url']).toBe(`${loggedPath}${slash}`);
            if (status === 404) {
              expect.soft(lines.map(line => line['msg'])).toContain(`Route ${method}:${loggedPath}${slash} not found`);
            }
            expect.soft(chunks.join('')).not.toMatch(/canary|requestId=|unknown=|turnId=|%72equestId=/u);
          }
        }
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

  it('redacts member change ids in the actual server logger output', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    const chunks: string[] = [];
    const destination: LogDestination = { write: (line: string) => void chunks.push(line) };
    const logger = createServerLogger(destination);
    const requestPath = '/api/members/private-member-canary/changes/private-command-canary';

    logger.info({
      req: { method: 'GET', url: requestPath, host: 'localhost:8080' },
    }, 'incoming request');

    const output = chunks.join('');

    expect(output).not.toContain('private-member-canary');
    expect(output).not.toContain('private-command-canary');
    expect(JSON.parse(output) as unknown).toMatchObject({
      req: {
        url: '/api/members/:memberId/changes/:commandId',
      },
    });
  });
});
