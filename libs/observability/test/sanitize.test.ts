import { describe, expect, it } from 'vitest';
import { sanitizeLogFields } from '../src/sanitize.ts';

describe('sanitizeLogFields', () => {
  it('redacts the Authorization, Cookie and Set-Cookie headers wherever they are nested', () => {
    const out = sanitizeLogFields({
      req: { headers: { authorization: 'Bearer secret-token-value', cookie: 'session=abc', accept: 'json' } },
      res: { headers: { 'set-cookie': 'session=abc; HttpOnly' } },
    });
    expect(out).toEqual({
      req: { headers: { authorization: '[Redacted]', cookie: '[Redacted]', accept: 'json' } },
      res: { headers: { 'set-cookie': '[Redacted]' } },
    });
  });

  it('redacts fields named like secret/password/apiKey/token at any depth, case-insensitively', () => {
    const out = sanitizeLogFields({
      password: 'hunter2',
      apiKey: 'sk_live_abc',
      token: 'tok_abc',
      accessToken: 'at_abc',
      clientSecret: 'cs_abc',
      nested: { deeper: { refreshToken: 'rt_abc', PASSWORD: 'HUNTER3' } },
      harmless: 'left alone',
    });
    expect(out).toEqual({
      password: '[Redacted]',
      apiKey: '[Redacted]',
      token: '[Redacted]',
      accessToken: '[Redacted]',
      clientSecret: '[Redacted]',
      nested: { deeper: { refreshToken: '[Redacted]', PASSWORD: '[Redacted]' } },
      harmless: 'left alone',
    });
  });

  it('sanitizes every element of an array', () => {
    const out = sanitizeLogFields({ list: [{ token: 'a' }, { token: 'b' }, { safe: 'c' }] });
    expect(out).toEqual({ list: [{ token: '[Redacted]' }, { token: '[Redacted]' }, { safe: 'c' }] });
  });

  it('leaves Error and Date instances untouched so their own serializers can handle them', () => {
    const err = new Error('boom');
    const date = new Date('2026-09-30T10:00:00.000Z');
    const out = sanitizeLogFields({ err, date });
    expect(out['err']).toBe(err);
    expect(out['date']).toBe(date);
  });

  it('replaces a circular reference instead of looping forever', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    const out = sanitizeLogFields({ circular });
    expect(out).toEqual({ circular: { name: 'loop', self: '[Circular]' } });
  });

  it('truncates rather than recursing past a bounded depth', () => {
    let deep: Record<string, unknown> = { leaf: 'bottom' };
    for (let i = 0; i < 20; i += 1) {
      deep = { child: deep };
    }
    const out = sanitizeLogFields({ deep });
    expect(JSON.stringify(out)).toContain('[Truncated]');
    expect(JSON.stringify(out)).not.toContain('bottom');
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
