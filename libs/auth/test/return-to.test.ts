import { describe, expect, it } from 'vitest';
import { sanitizeReturnTo } from '../src/return-to.ts';

describe('sanitizeReturnTo', () => {
  it('keeps a local path with its query and fragment', () => {
    expect(sanitizeReturnTo('/dashboard?tab=2#top')).toBe('/dashboard?tab=2#top');
  });

  it('replaces an absolute URL with /', () => {
    expect(sanitizeReturnTo('https://evil.example/phish')).toBe('/');
  });

  it('replaces a protocol-relative URL with /', () => {
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
  });

  it('replaces a missing or empty value with /', () => {
    expect(sanitizeReturnTo(undefined)).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
  });

  it('replaces a script URL with /', () => {
    expect(sanitizeReturnTo('javascript:alert(1)')).toBe('/');
  });

  // A browser reads "\" as "/" in an http(s) URL, so these point at evil.example.
  it.each(['/\\evil.example/phish', '/\\/evil.example', '/./\\evil.example'])('replaces the backslash trick %j with /', (value) => {
    expect(sanitizeReturnTo(value)).toBe('/');
  });

  // A browser drops tabs and newlines before it parses a URL.
  it.each(['/\t/evil.example', '/\n/evil.example', '/\r/evil.example'])('replaces the control-character trick %j with /', (value) => {
    expect(sanitizeReturnTo(value)).toBe('/');
  });

  // Dot-segments collapse, leaving a path that starts with "//".
  it.each(['/.//evil.example', '/..//evil.example', '/a/..//evil.example'])('replaces the dot-segment trick %j with /', (value) => {
    expect(sanitizeReturnTo(value)).toBe('/');
  });

  it('never returns something a browser would resolve to another origin', () => {
    const attempts = ['/\\evil.example', '/\t/evil.example', '/.//evil.example', '//evil.example', 'https://evil.example', '/%2F/evil.example', '/ok'];
    for (const attempt of attempts) {
      const result = sanitizeReturnTo(attempt);
      expect(new URL(result, 'https://app.example.test').origin).toBe('https://app.example.test');
    }
  });
});
