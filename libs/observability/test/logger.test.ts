import { record as asRecord } from './record.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../src/logger.ts';
import { runWithContext } from '../src/context.ts';
import { memorySink } from './memory-sink.ts';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A logger writing to memory, for tests that look at what pino really produced. */
function testLogger(opts: Parameters<typeof createLogger>[1] = {}) {
  const sink = memorySink();
  return { ...sink, logger: createLogger('test', { destination: sink.stream, level: 'info', ...opts }) };
}

describe('createLogger', () => {
  it('writes one JSON line per record with the name, level and message, and turns an err field into {type, message, stack}', () => {
    const { logger, lines } = testLogger();

    logger.info({ example: 1 }, 'hello');
    logger.error({ err: new TypeError('boom') }, 'handler.failed');

    const [first, second] = lines();
    expect(first).toMatchObject({ name: 'test', level: 30, msg: 'hello', example: 1 });
    const err = asRecord(second?.['err']);
    expect(err).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect(err['stack']).toContain('boom');
  });

  describe('redaction on the finished line', () => {
    it('redacts headers, password/token/apiKey, api_key, x-api-key and proxy-authorization wherever a call puts them', () => {
      const { logger, text } = testLogger();

      logger.info(
        {
          req: { headers: { authorization: 'Bearer SECRET_AUTH', cookie: 'session=SECRET_COOKIE' } },
          user: { password: 'SECRET_PW', apiKey: 'SECRET_AK' },
          api_key: 'SECRET_API_KEY',
          headers: { 'x-api-key': 'SECRET_X_API_KEY', 'proxy-authorization': 'Basic SECRET_PROXY' },
        },
        'k',
      );

      expect(text()).not.toMatch(/SECRET_/u);
      expect(text()).toContain('"authorization":"[Redacted]"');
    });

    it('redacts a secret carried on an Error as a property, which a formatter-based redactor never saw (found leaking from runHandler)', () => {
      const { logger, lines, text } = testLogger();
      const err = Object.assign(new Error('openfga write failed'), {
        config: { headers: { authorization: 'Bearer SECRET_RUNHANDLER' } },
        apiKey: 'SECRET_RH_APIKEY',
        statusCode: 502,
      });

      logger.error({ err }, 'handler.failed');

      expect(text()).not.toMatch(/SECRET_/u);
      // The rest of the error still comes through: this is redaction, not a black hole.
      expect(lines()[0]?.['err']).toMatchObject({ message: 'openfga write failed', statusCode: 502 });
    });

    it('redacts a secret given to logger.child() (also a child of a child) and to setBindings: pino skips formatters for child bindings', () => {
      const { logger, text } = testLogger();

      const child = logger.child({ token: 'SECRET_BINDING', 'x-api-key': 'SECRET_CHILD_KEY' });
      child.info('child event');
      child.child({ clientSecret: 'SECRET_GRANDCHILD' }).info('grandchild event');
      const other = logger.child({ a: 1 });
      other.setBindings({ password: 'SECRET_SETBINDINGS' });
      other.info('after setBindings');

      expect(text()).not.toMatch(/SECRET_/u);
    });

    it('redacts class instances, objects with toJSON and custom serializer output, and keeps usage counts and secret references', () => {
      const { logger, lines, text } = testLogger({
        serializers: { req: () => ({ headers: { authorization: 'Bearer SECRET_SER' }, url: '/x?token=SECRET_SER_URL' }) },
      });
      class Credentials {
        password = 'SECRET_CLASS';
        user = 'alice';
      }

      logger.info(
        {
          creds: new Credentials(),
          view: { toJSON: () => ({ token: 'SECRET_TOJSON', visible: 1 }) },
          req: {},
          input_tokens: 120,
          secretRef: 'secrets/acme-odoo',
          code: 404,
        },
        'k',
      );

      expect(text()).not.toMatch(/SECRET_/u);
      expect(lines()[0]).toMatchObject({ creds: { user: 'alice' }, view: { visible: 1 }, input_tokens: 120, secretRef: 'secrets/acme-odoo', code: 404 });
    });

    it('redacts query-string secrets in the message, in printf-style arguments, and in an error message and stack', () => {
      const { logger, text } = testLogger();

      logger.info('Route GET:/nope?token=SECRET_B404&code=SECRET_CODE not found');
      logger.info('callback %s', '/cb?access_token=SECRET_FMT');
      logger.error(new Error('fetch failed for https://x.test/y?refresh_token=SECRET_ERR'));

      expect(text()).not.toMatch(/SECRET_/u);
      expect(text()).toContain('Route GET:/nope not found');
    });
  });

  it('merges the active request context into every line written inside its scope', () => {
    const { logger, lines } = testLogger();

    runWithContext({ requestId: 'req_9', extra: { silo: 'acme' } }, () => {
      logger.info({}, 'inside scope');
    });
    logger.info({}, 'outside scope');

    const [insideLine, outsideLine] = lines();
    expect(insideLine).toMatchObject({ request_id: 'req_9', silo: 'acme' });
    expect(outsideLine?.['request_id']).toBeUndefined();
  });

  it('defaults the level to LOG_LEVEL, then to info, and lets a caller override it explicitly', () => {
    const sink = memorySink();
    vi.stubEnv('LOG_LEVEL', 'warn');
    const fromEnv = createLogger('test', { destination: sink.stream });
    expect(fromEnv.level).toBe('warn');
    fromEnv.info('should be dropped');
    fromEnv.warn('should appear');
    expect(sink.lines().map((line) => line['msg'])).toEqual(['should appear']);

    expect(createLogger('test', { destination: sink.stream, level: 'debug' }).level).toBe('debug');

    vi.stubEnv('LOG_LEVEL', undefined);
    expect(createLogger('test', { destination: sink.stream }).level).toBe('info');
  });
});
