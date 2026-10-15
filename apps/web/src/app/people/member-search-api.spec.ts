import { afterEach, expect, it, vi } from 'vitest';
import { searchMembers } from './member-search-api';

afterEach(() => vi.unstubAllGlobals());

it('sends a bounded name search and checks status before reading the body', async () => {
  let bodyRead = false;
  const denied = { ok: false, status: 403,
    json: (): Promise<unknown> => { bodyRead = true; return Promise.resolve({}); } };
  const fetcher = vi.fn().mockResolvedValue(denied);
  vi.stubGlobal('fetch', fetcher);
  const query = 'x'.repeat(120);
  const result = await searchMembers(query, '', new AbortController().signal);
  expect(result).toEqual({ kind: 'access_changed', status: 403 });
  expect(bodyRead).toBe(false);
  const input: unknown = fetcher.mock.calls[0]?.[0];
  if (typeof input !== 'string') throw new Error('Expected a member search URL');
  const url = new URL(input, 'https://example.test');
  expect(url.searchParams.get('q')).toHaveLength(100);
  expect(url.searchParams.get('after')).toBe('');
  expect(url.searchParams.get('limit')).toBe('20');
});
