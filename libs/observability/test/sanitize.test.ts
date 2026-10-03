import { record as asRecord } from './record.ts';
import { describe, expect, it } from 'vitest';
import { sanitizeLogFields, sanitizeLogLine } from '../src/sanitize.ts';

describe('sanitizeLogFields', () => {
  it('redacts the Authorization, Cookie, Set-Cookie and Proxy-Authorization headers and the api_key / x-api-key spellings, wherever they are nested', () => {
    const out = sanitizeLogFields({
      req: { headers: { authorization: 'Bearer secret-value', cookie: 'session=abc', accept: 'json', 'x-api-key': 'c' } },
      res: { headers: { 'set-cookie': 'session=abc; HttpOnly', 'proxy-authorization': 'Basic abc' } },
      api_key: 'a',
      apiKey: 'b',
    });
    expect(out).toEqual({
      req: { headers: { authorization: '[Redacted]', cookie: '[Redacted]', accept: 'json', 'x-api-key': '[Redacted]' } },
      res: { headers: { 'set-cookie': '[Redacted]', 'proxy-authorization': '[Redacted]' } },
      api_key: '[Redacted]',
      apiKey: '[Redacted]',
    });
  });

  it('redacts fields named like secret/password/token at any depth, case-insensitively, and keeps their harmless siblings', () => {
    const out = sanitizeLogFields({
      password: 'hunter2',
      clientSecret: 'cs_abc',
      nested: { deeper: { refreshToken: 'rt_abc', PASSWORD: 'HUNTER3', masterKey: 'mk', DATABASE_URL: 'postgres://u:p@h/db' } },
      harmless: 'left alone',
    });
    expect(out).toEqual({
      password: '[Redacted]',
      clientSecret: '[Redacted]',
      nested: { deeper: { refreshToken: '[Redacted]', PASSWORD: '[Redacted]', masterKey: '[Redacted]', DATABASE_URL: '[Redacted]' } },
      harmless: 'left alone',
    });
  });

  it('keeps usage counts and secret references, but still redacts a string, list or object under a sensitive name', () => {
    const kept = { input_tokens: 120, output_tokens: 45, maxOutputTokens: 4096, tokenCount: 3, secretRef: 'secrets/acme-odoo', secret_id: 's_1' };
    expect(sanitizeLogFields(kept)).toEqual(kept);
    expect(sanitizeLogFields({ input_tokens: 'abc123', tokens: ['abc'], token: { value: 'abc' } })).toEqual({
      input_tokens: '[Redacted]',
      tokens: '[Redacted]',
      token: '[Redacted]',
    });
  });

  it('drops entire queries in any string, and walks every element of an array, at any depth', () => {
    const out = sanitizeLogFields({
      msg: 'Route GET:/nope?token=SECRET_A&code=SECRET_B not found',
      nested: { list: ['/cb?access_token=SECRET_C&keep=1', { token: 'b' }, { safe: 'c' }] },
    });
    expect(out).toEqual({
      msg: 'Route GET:/nope not found',
      nested: { list: ['/cb', { token: '[Redacted]' }, { safe: 'c' }] },
    });
  });

  it('keeps a field literally named __proto__ as a field, and still redacts inside it', () => {
    const out = sanitizeLogFields(asRecord(JSON.parse('{"__proto__":{"token":"SECRET_PROTO","ok":1}}')));
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"token":"[Redacted]","ok":1}}');
  });

  it('truncates rather than recursing past a bounded depth', () => {
    const deep = Array.from({ length: 20 }).reduce<Record<string, unknown>>((inner) => ({ child: inner }), { leaf: 'bottom' });
    const out = JSON.stringify(sanitizeLogFields({ deep }));
    expect(out).toContain('[Truncated]');
    expect(out).not.toContain('bottom');
  });

  it('fails closed to a single redacted marker if walking the value throws', () => {
    const hostile = {
      get poison(): string {
        throw new Error('boom');
      },
    };
    expect(sanitizeLogFields(hostile)).toEqual({ logFields: '[Redacted]' });
  });
});

describe('sanitizeLogLine', () => {
  it('sanitises a finished JSON line, keeps every other field, and still ends with a newline', () => {
    const line = JSON.stringify({ level: 30, msg: 'hi', headers: { authorization: 'Bearer SECRET_L' }, url: '/x?token=SECRET_U&ok=1' });

    const out = sanitizeLogLine(`${line}\n`);

    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({ level: 30, msg: 'hi', headers: { authorization: '[Redacted]' }, url: '/x' });
  });

  it('drops a line that is not valid JSON and never writes its text', () => {
    const out = sanitizeLogLine('not json, token=SECRET_RAW password=SECRET_PW');

    expect(out).not.toContain('SECRET_');
    expect(JSON.parse(out)).toMatchObject({ level: 50, msg: 'log line dropped: it could not be sanitised' });
  });
});
