import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact.ts';

describe('redactUrl', () => {
  it('redacts a bare ?token= query string on a relative URL (the exact shape a previous review found logged verbatim)', () => {
    const redacted = redactUrl('/callback?token=SECRET123');
    expect(redacted).not.toContain('SECRET123');
    expect(redacted).toBe('/callback?token=%5BRedacted%5D');
  });

  it('redacts token, code, state, access_token and id_token, case-insensitively, and leaves other parameters alone', () => {
    const redacted = redactUrl('/cb?Token=abc&code=def&STATE=ghi&access_token=jkl&id_token=mno&keep=me');
    expect(redacted).not.toMatch(/abc|def|ghi|jkl|mno/u);
    expect(redacted).toContain('keep=me');
  });

  it('leaves a URL with no sensitive parameters unchanged', () => {
    const url = '/conversations/123?page=2&sort=asc';
    expect(redactUrl(url)).toBe(url);
  });

  it('redacts an absolute URL while keeping its origin and path', () => {
    const redacted = redactUrl('https://api.opencrane.test/oauth/callback?token=SECRET123');
    expect(redacted).not.toContain('SECRET123');
    expect(redacted.startsWith('https://api.opencrane.test/oauth/callback')).toBe(true);
  });

  it('returns a malformed absolute URL unchanged, rather than throwing', () => {
    expect(redactUrl('https:// bad host/path')).toBe('https:// bad host/path');
  });

  it('redacts every occurrence of a repeated sensitive parameter', () => {
    const redacted = redactUrl('/cb?token=first&token=second');
    expect(redacted).not.toMatch(/first|second/u);
  });
});
