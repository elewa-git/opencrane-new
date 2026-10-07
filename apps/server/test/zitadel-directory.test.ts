import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { zitadelDirectory } from '../src/members/zitadel.ts';

async function refusesForeignProviderData() {
  const directory = await mkdtemp(`${tmpdir()}/directory-key-`);
  const keyFile = `${directory}/key`;
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = pair.privateKey.export({ type: 'pkcs1', format: 'pem' });
  await writeFile(keyFile, JSON.stringify({ keyId: 'key', userId: 'machine', key }));
  let foreign = false;
  function provider(input: string | URL | Request, options?: RequestInit) {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.endsWith('/oauth/v2/token')) return Promise.resolve(Response.json({ access_token: 'short-lived' }));
    expect(options?.headers).toMatchObject({ 'x-zitadel-orgid': '393311211338337681' });
    if (url.endsWith('/orgs/me')) {
      const org = { id: '393311211338337681', name: 'OpenCrane 2 Dev' };
      return Promise.resolve(Response.json({ org }));
    }
    const user = { id: 'test-person', state: 'USER_STATE_ACTIVE',
      details: { resourceOwner: foreign ? 'another-org' : '393311211338337681' } };
    if (url.endsWith('/_search')) {
      expect(JSON.parse(typeof options?.body === 'string' ? options.body : '')).toEqual({ query: { limit: '2' }, queries: [
        { emailQuery: { emailAddress: 'test@example.test', method: 'TEXT_QUERY_METHOD_EQUALS' } },
      ] });
      return Promise.resolve(Response.json({ result: [user] }));
    }
    expect(options?.method).toBe('GET');
    return Promise.resolve(Response.json({ user }));
  }
  try {
    const client = zitadelDirectory('https://idp.test', '393311211338337681', keyFile, provider);
    const signal = AbortSignal.timeout(10_000);
    expect((await client.search('test@example.test', signal))[0]?.id).toBe('test-person');
    expect((await client.get('test-person', signal)).id).toBe('test-person');
    foreign = true;
    await expect(client.search('test@example.test', signal)).rejects.toThrow();
    await expect(client.get('test-person', signal)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
it('the read-only client bounds exact searches and rejects foreign users from search and get',
  refusesForeignProviderData);
