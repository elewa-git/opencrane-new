import { describe, expect, it } from 'vitest';
import type { DestinationStream } from 'pino';
import { createLogger } from '../src/logger.ts';
import { runWithContext } from '../src/context.ts';

/** An in-memory pino destination that keeps every line written to it, so a test can inspect the JSON pino actually produced. */
function memorySink(): { stream: DestinationStream; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream: DestinationStream = {
    write(msg: string) {
      chunks.push(msg);
    },
  };
  return {
    stream,
    lines: () => chunks.flatMap((chunk) => chunk.split('\n').filter((line) => line.length > 0).map((line) => JSON.parse(line) as Record<string, unknown>)),
  };
}

describe('createLogger', () => {
  it('writes one JSON line per record, carrying the given name and level', () => {
    const { stream, lines } = memorySink();
    const logger = createLogger('opencrane-server', { destination: stream, level: 'info' });

    logger.info({ example: 1 }, 'hello');

    const [line] = lines();
    expect(line?.['name']).toBe('opencrane-server');
    expect(line?.['msg']).toBe('hello');
    expect(line?.['example']).toBe(1);
  });

  it('redacts a header object logged wholesale, closing the gap a raw console.log would leave open', () => {
    const { stream, lines } = memorySink();
    const logger = createLogger('test', { destination: stream, level: 'info' });

    logger.info({ req: { headers: { authorization: 'Bearer SECRET123', cookie: 'session=abc' } } }, 'incoming request');

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain('SECRET123');
    expect(raw).not.toContain('session=abc');
  });

  it('redacts password/secret/apiKey/token fields wherever a log call puts them', () => {
    const { stream, lines } = memorySink();
    const logger = createLogger('test', { destination: stream, level: 'info' });

    logger.info({ user: { password: 'hunter2', apiKey: 'sk_live_abc' } }, 'created user');

    const raw = JSON.stringify(lines());
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('sk_live_abc');
  });

  it('turns a logged err field into a plain object with a message, instead of a dropped Error instance', () => {
    const { stream, lines } = memorySink();
    const logger = createLogger('test', { destination: stream, level: 'info' });

    logger.error({ err: new Error('boom') }, 'handler.failed');

    const [line] = lines();
    expect((line?.['err'] as { message?: string } | undefined)?.message).toBe('boom');
  });

  it('merges the active request context into every line written inside its scope', () => {
    const { stream, lines } = memorySink();
    const logger = createLogger('test', { destination: stream, level: 'info' });

    runWithContext({ requestId: 'req_9', extra: { silo: 'acme' } }, () => {
      logger.info({}, 'inside scope');
    });
    logger.info({}, 'outside scope');

    const [insideLine, outsideLine] = lines();
    expect(insideLine?.['request_id']).toBe('req_9');
    expect(insideLine?.['silo']).toBe('acme');
    expect(outsideLine?.['request_id']).toBeUndefined();
  });

  it('defaults the level to LOG_LEVEL, and lets a caller override it explicitly', () => {
    const previous = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'warn';
    try {
      const { stream, lines } = memorySink();
      const logger = createLogger('test', { destination: stream });
      logger.info({}, 'should be dropped');
      logger.warn({}, 'should appear');
      expect(lines()).toHaveLength(1);
      expect(lines()[0]?.['msg']).toBe('should appear');

      const { stream: stream2, lines: lines2 } = memorySink();
      const overridden = createLogger('test', { destination: stream2, level: 'debug' });
      overridden.debug({}, 'now visible');
      expect(lines2()).toHaveLength(1);
    } finally {
      if (previous === undefined) {
        delete process.env['LOG_LEVEL'];
      } else {
        process.env['LOG_LEVEL'] = previous;
      }
    }
  });
});
