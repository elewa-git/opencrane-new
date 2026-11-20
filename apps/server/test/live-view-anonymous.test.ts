import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { ViewSessions } from '../src/computers/view-sessions.ts';

import { encodeSession } from '@opencrane/auth';
import { history } from '@opencrane/models';
import { expect, it, vi } from 'vitest';

import { viewFixture } from './support/view-fixture.ts';

const viewUrl = '/api/conversations/chat/view';

function openDesktop(): Promise<never> {
  return Promise.reject(new Error('A refused request must not open a desktop'));
}

function isRefusalLog(line: string) {
  return line.includes('view.refused');
}

async function refuseInvalidSessions() {
  vi.stubEnv('LOG_LEVEL', 'info');
  const logLines: string[] = [];
  function writeLog(line: string) {
    logLines.push(line);
  }
  const fixture = await viewFixture(openDesktop, undefined, { write: writeLog });
  try {
    const { app, config, nats } = fixture;
    const wrongOrganisationArguments = {
      sub: 'alice', orgId: 'other-org', roles: [], authTime: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
    };
    const wrongOrganisation = encodeSession(config, wrongOrganisationArguments);
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
      const requestArguments = {
        method: 'POST' as const, url: viewUrl, headers,
        payload: { privateMarker: 'body-secret-value' },
      };
      const response = await app.inject(requestArguments);
      const body = response.json<{ status: string; attemptId: string }>();

      expect(response.statusCode, testCase.name).toBe(403);
      expect(body.status, testCase.name).toBe('refused');
      expect(typeof body.attemptId, testCase.name).toBe('string');
      expect(Object.keys(body).sort(), testCase.name).toEqual(['attemptId', 'status']);
      expect(await nats.store.head(), testCase.name).toBe(before);
      expect(logLines.join('\n'), testCase.name).toContain(body.attemptId);
    }

    const refusalLogs = logLines.filter(isRefusalLog);
    expect(refusalLogs).toHaveLength(cases.length);
    expect(refusalLogs.join('\n')).not.toContain('invalid-cookie-value');
    expect(refusalLogs.join('\n')).not.toContain(wrongOrganisation);
    expect(refusalLogs.join('\n')).not.toContain('body-secret-value');
  } finally {
    await fixture.close();
    vi.unstubAllEnvs();
  }
}

async function auditSignedInNonMember() {
  const fixture = await viewFixture(openDesktop);
  try {
    const { app, config, nats } = fixture;
    const sessionArguments = {
      sub: 'visitor', orgId: 'org-test', roles: [], authTime: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
    };
    const session = encodeSession(config, sessionArguments);
    const headers = {
      origin: new URL(config.redirectUri).origin,
      'x-opencrane-view': '1',
      cookie: `${config.cookieName}=${session}`,
    };
    const before = await nats.store.head();
    const requestArguments = { method: 'POST' as const, url: viewUrl, headers };
    const response = await app.inject(requestArguments);
    const body = response.json<{ status: string; attemptId: string }>();

    expect(response.statusCode).toBe(403);
    expect(body.status).toBe('refused');
    expect(typeof body.attemptId).toBe('string');
    expect(Object.keys(body).sort()).toEqual(['attemptId', 'status']);
    expect(await nats.store.head()).toBe(before + 1);
    const records = await history(nats.store, `view-${body.attemptId}`, 'test');
    expect(records).toHaveLength(1);
    expect(records[0]?.event.type).toBe('computer.view_refused');
    expect(records[0]?.event.data).toMatchObject({ reason: 'admission' });
  } finally {
    await fixture.close();
  }
}

function refusedUpgrade(address: string, headers: IncomingHttpHeaders): Promise<number> {
  function connect(resolve: (status: number) => void, reject: (error: Error) => void) {
    const requestArguments = {
      headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    };
    const request = httpRequest(`${address}/ws/conversations/chat/view`, requestArguments);
    function responded(response: IncomingMessage) {
      response.resume();
      resolve(response.statusCode ?? 0);
    }
    function upgraded(_response: unknown, socket: Duplex) {
      socket.destroy();
      reject(new Error('A refused viewer must not upgrade'));
    }
    request.on('response', responded);
    request.on('upgrade', upgraded);
    request.on('error', reject);
    request.end();
  }
  return new Promise(connect);
}

async function refuseAtCapacity(_start: () => Promise<void>, refuse: () => Promise<void>) {
  await refuse();
}

async function refuseAnonymousUpgrade() {
  const fixture = await viewFixture(openDesktop);
  try {
    const listenArguments = { host: '127.0.0.1', port: 0 };
    const address = await fixture.app.listen(listenArguments);
    const headers = { origin: new URL(fixture.config.redirectUri).origin };
    const before = await fixture.nats.store.head();
    expect(await refusedUpgrade(address, headers)).toBe(403);
    expect(await fixture.nats.store.head()).toBe(before);
  } finally {
    await fixture.close();
  }
}

async function refuseAnonymousCapacityUpgrade() {
  const capacity = vi.spyOn(ViewSessions.prototype, 'open');
  capacity.mockImplementation(refuseAtCapacity);
  try {
    await refuseAnonymousUpgrade();
    expect(capacity).toHaveBeenCalledOnce();
  } finally {
    capacity.mockRestore();
  }
}

async function checkOriginDecisions(route: 'admission' | 'upgrade') {
  const fixture = await viewFixture(openDesktop);
  try {
    const { app, config, nats } = fixture;
    const sessionArguments = {
      sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
    };
    const session = encodeSession(config, sessionArguments);
    const listenArguments = { host: '127.0.0.1', port: 0 };
    const address = await app.listen(listenArguments);
    const origins = [undefined, 'https://hostile.example.test'];
    const sessions = [
      { name: 'valid session', value: session, auditCount: 1 },
      { name: 'invalid session', value: 'invalid-cookie-value', auditCount: 0 },
    ];
    for (const identity of sessions) {
      for (const origin of origins) {
        const headers = {
          cookie: `${config.cookieName}=${identity.value}`, 'x-opencrane-view': '1',
          ...(origin ? { origin } : {}),
        };
        const before = await nats.store.head();
        if (route === 'admission') {
          const requestArguments = { method: 'POST' as const, url: viewUrl, headers };
          const response = await app.inject(requestArguments);
          expect(response.statusCode, identity.name).toBe(403);
        } else {
          expect(await refusedUpgrade(address, headers), identity.name).toBe(403);
        }
        expect(await nats.store.head(), identity.name).toBe(before + identity.auditCount);
        if (identity.auditCount) {
          for await (const record of nats.store.subscribe(before + 1)) {
            expect(record.event.type).toBe('computer.view_refused');
            break;
          }
        }
      }
    }
  } finally {
    await fixture.close();
  }
}

async function auditAdmissionOriginDecisions() {
  await checkOriginDecisions('admission');
}

async function auditUpgradeOriginDecisions() {
  await checkOriginDecisions('upgrade');
}

async function auditCapacityOriginDecisions() {
  const capacity = vi.spyOn(ViewSessions.prototype, 'open');
  capacity.mockImplementation(refuseAtCapacity);
  try {
    await checkOriginDecisions('upgrade');
    expect(capacity).toHaveBeenCalledTimes(4);
  } finally {
    capacity.mockRestore();
  }
}

it('refuses missing, invalid and wrong-organisation sessions without adding an event',
  refuseInvalidSessions, 120_000);
it('saves a refusal for a signed-in person who is not a member',
  auditSignedInNonMember, 120_000);
it('refuses an anonymous WebSocket upgrade without adding an event',
  refuseAnonymousUpgrade, 120_000);
it('refuses an anonymous WebSocket upgrade at capacity without adding an event',
  refuseAnonymousCapacityUpgrade, 120_000);
it('audits admission for valid sessions with missing or hostile Origins and ignores invalid sessions',
  auditAdmissionOriginDecisions, 120_000);
it('audits upgrades for valid sessions with missing or hostile Origins and ignores invalid sessions',
  auditUpgradeOriginDecisions, 120_000);
it('audits valid sessions at capacity with missing or hostile Origins and ignores invalid sessions',
  auditCapacityOriginDecisions, 120_000);
