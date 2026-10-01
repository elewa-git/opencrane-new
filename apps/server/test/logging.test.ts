import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogDestination } from '@opencrane/observability';
import type { FastifyRequest } from 'fastify';
import { createServerLogger, redactedRequestSerializer } from '../src/logging.ts';

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
    } as unknown as FastifyRequest;

    expect(redactedRequestSerializer(request)).toEqual({
      method: 'GET',
      url: '/healthz?token=[Redacted]&keep=1',
      host: 'localhost:8080',
      remotePort: 51234,
    });
  });

  it('does not throw for a request with no socket (a throwing serializer takes the process down)', () => {
    expect(redactedRequestSerializer({ method: 'GET', url: '/x', host: 'h' } as unknown as FastifyRequest)).toMatchObject({ method: 'GET', url: '/x' });
  });
});

describe('createServerLogger', () => {
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
