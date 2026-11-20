import { encodeSession } from '@opencrane/auth';
import { history } from '@opencrane/models';
import { expect, it } from 'vitest';

import { viewFixture } from './support/view-fixture.ts';

const viewUrl = '/api/conversations/chat/view';

function openDesktop() {
  throw new Error('A refused request must not open a desktop');
}

it('refuses missing, invalid and wrong-organisation sessions without adding an event', async () => {
  const logLines: string[] = [];
  function writeLog(line: string) {
    logLines.push(line);
  }
  const fixture = await viewFixture(openDesktop, undefined, { write: writeLog });
  try {
    const { app, config, nats } = fixture;
    const wrongOrganisation = encodeSession(config, {
      sub: 'alice', orgId: 'other-org', roles: [], authTime: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
    });
    const cases = [
      { name: 'missing cookie', cookie: undefined },
      { name: 'invalid cookie', cookie: `${config.cookieName}=invalid-cookie-value` },
      { name: 'wrong organisation', cookie: `${config.cookieName}=${wrongOrganisation}` },
    ];
    for (const testCase of cases) {
      const headers = {
        origin: new URL(config.redirectUri).origin,
        'x-opencrane-view': '1',
        ...(testCase.cookie ? { cookie: testCase.cookie } : {}),
      };
      const before = await nats.store.head();
      const response = await app.inject({ method: 'POST', url: viewUrl, headers });
      const body = response.json<{ status: string; attemptId: string }>();

      expect(response.statusCode, testCase.name).toBe(403);
      expect(body, testCase.name).toEqual({ status: 'refused', attemptId: expect.any(String) });
      expect(await nats.store.head(), testCase.name).toBe(before);
      expect(logLines.some(line => line.includes(body.attemptId)), testCase.name).toBe(true);
    }

    const refusalLogs = logLines.filter(line => line.includes('view.refused'));
    expect(refusalLogs).toHaveLength(cases.length);
    expect(refusalLogs.join('\n')).not.toContain('invalid-cookie-value');
    expect(refusalLogs.join('\n')).not.toContain(wrongOrganisation);
  } finally {
    await fixture.close();
  }
}, 120_000);

it('saves a refusal for a signed-in person who is not a member', async () => {
  const fixture = await viewFixture(openDesktop);
  try {
    const { app, config, nats } = fixture;
    const session = encodeSession(config, {
      sub: 'visitor', orgId: 'org-test', roles: [], authTime: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
    });
    const headers = {
      origin: new URL(config.redirectUri).origin,
      'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${session}`,
    };
    const before = await nats.store.head();
    const response = await app.inject({ method: 'POST', url: viewUrl, headers });
    const body = response.json<{ status: string; attemptId: string }>();

    expect(response.statusCode).toBe(403);
    expect(body).toEqual({ status: 'refused', attemptId: expect.any(String) });
    expect(await nats.store.head()).toBe(before + 1);
    const records = await history(nats.store, `view-${body.attemptId}`, 'test');
    expect(records).toHaveLength(1);
    expect(records[0]?.event.type).toBe('computer.view_refused');
    expect(records[0]?.event.data).toMatchObject({ reason: 'admission' });
  } finally {
    await fixture.close();
  }
}, 120_000);
