import { PassThrough, type Duplex } from 'node:stream';
import type { AppendCommand } from '@opencrane/event-store';
import { parseEventByType } from '@opencrane/events';
import { WebSocket } from 'ws';
import { grantStream } from '@opencrane/authz';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

import { encodeSession } from '@opencrane/auth';
import { history } from '@opencrane/models';
import { expect, it, vi } from 'vitest';

import { viewFixture } from './support/view-fixture.ts';

const viewUrl = '/api/conversations/chat/view';

function openDesktop(): Promise<never> {
  return Promise.reject(new Error('A refused request must not open a desktop'));
}

function openAvailableDesktop() {
  return Promise.resolve(new PassThrough());
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
  const logDestination = { write: writeLog };
  const fixture = await viewFixture(openDesktop, undefined, logDestination);
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

type BaseViewFixture = Awaited<ReturnType<typeof viewFixture>>;

async function grantDesktopToAlice(fixture: BaseViewFixture) {
  const grant = {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
    granteeKind: 'member', grantedBy: 'owner',
  };
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
}

function aliceViewHeaders(config: BaseViewFixture['config']) {
  const sessionArguments = {
    sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const session = encodeSession(config, sessionArguments);
  return {
    origin: new URL(config.redirectUri).origin, 'x-opencrane-view': '1',
    cookie: `${config.cookieName}=${session}`,
  };
}

async function issueTicket(fixture: BaseViewFixture, headers: IncomingHttpHeaders) {
  const requestArguments = { method: 'POST' as const, url: viewUrl, headers };
  const admission = await fixture.app.inject(requestArguments);
  expect(admission.statusCode).toBe(200);
  const body = admission.json<{ ticket: string }>();
  expect(body.ticket).toBeTruthy();
  return body.ticket;
}

async function capacityTickets(fixture: BaseViewFixture) {
  await grantDesktopToAlice(fixture);
  const headers = aliceViewHeaders(fixture.config);
  const tickets: string[] = [];
  for (let index = 0; index < 16; index++) {
    const ticket = await issueTicket(fixture, headers);
    tickets.push(ticket);
  }
  return { headers, tickets };
}

async function fillViewerCapacity(
  fixture: BaseViewFixture, address: string, sockets: WebSocket[],
) {
  const { headers, tickets } = await capacityTickets(fixture);
  const store = fixture.nats.store;
  const persist = store.append.bind(store);
  const release = Promise.withResolvers<void>();
  const filled = Promise.withResolvers<void>();
  let started = 0;
  let closing = false;
  // Save each start, then hold its reply to keep every upgrade in progress.
  async function holdStartResponse(command: AppendCommand) {
    const result = await persist(command);
    const parsed = parseEventByType(command.event);
    if (parsed.success && parsed.event.type === 'computer.view_started') {
      started++;
      if (started === 16) filled.resolve();
      await release.promise;
    }
    return result;
  }
  const audit = vi.spyOn(store, 'append');
  audit.mockImplementation(holdStartResponse);
  function upgradeFailed(error: Error) {
    if (!closing) filled.reject(error);
  }
  function upgradeRefused(_request: unknown, response: IncomingMessage) {
    filled.reject(new Error(`Opening viewer returned ${response.statusCode}`));
  }
  async function releaseCapacity() {
    closing = true;
    const before = await store.head();
    for (const socket of sockets) socket.terminate();
    release.resolve();
    let stopped = 0;
    for await (const record of store.subscribe(before + 1)) {
      if (record.event.type === 'computer.view_stopped') stopped++;
      if (stopped === 16) break;
    }
    audit.mockRestore();
  }
  try {
    const upgradeUrl = `${address.replace('http:', 'ws:')}/ws/conversations/chat/view`;
    const socketArguments = { headers };
    for (const ticket of tickets) {
      const protocols = ['binary', ticket];
      const socket = new WebSocket(upgradeUrl, protocols, socketArguments);
      socket.on('error', upgradeFailed);
      socket.on('unexpected-response', upgradeRefused);
      sockets.push(socket);
    }
    await filled.promise;
    const before = await store.head();
    expect(await refusedUpgrade(address, headers)).toBe(403);
    expect(await store.head()).toBe(before + 1);
    const expectedRefusal = { reason: 'capacity' };
    for await (const record of store.subscribe(before + 1)) {
      expect(record.event.type).toBe('computer.view_refused');
      expect(record.event.data).toMatchObject(expectedRefusal);
      break;
    }
    return releaseCapacity;
  } catch (error) {
    closing = true;
    release.resolve();
    audit.mockRestore();
    throw error;
  }
}

function noCapacityToRelease() {
  return Promise.resolve();
}

async function upgradeFixture(
  atCapacity: boolean, open: Parameters<typeof viewFixture>[0] = openDesktop,
) {
  const fixture = await viewFixture(open);
  let releaseCapacity = noCapacityToRelease;
  const sockets: WebSocket[] = [];
  async function close() {
    await releaseCapacity();
    for (const socket of sockets) socket.terminate();
    await fixture.close();
  }
  try {
    const listenArguments = { host: '127.0.0.1', port: 0 };
    const address = await fixture.app.listen(listenArguments);
    if (atCapacity) {
      releaseCapacity = await fillViewerCapacity(fixture, address, sockets);
    }
    return { ...fixture, address, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function checkAnonymousUpgrade(atCapacity: boolean) {
  const fixture = await upgradeFixture(atCapacity);
  try {
    const headers = { origin: new URL(fixture.config.redirectUri).origin };
    const before = await fixture.nats.store.head();
    expect(await refusedUpgrade(fixture.address, headers)).toBe(403);
    expect(await fixture.nats.store.head()).toBe(before);
  } finally {
    await fixture.close();
  }
}

async function refuseAnonymousUpgrade() {
  await checkAnonymousUpgrade(false);
}

async function refuseAnonymousCapacityUpgrade() {
  await checkAnonymousUpgrade(true);
}

type ViewRoute = 'admission' | 'upgrade';
type UpgradeFixture = Awaited<ReturnType<typeof upgradeFixture>>;

async function expectOriginRefusal(
  fixture: UpgradeFixture, route: ViewRoute, headers: IncomingHttpHeaders,
  testName: string, expectedEvents: number,
) {
  const { app, nats, address } = fixture;
  const before = await nats.store.head();
  if (route === 'admission') {
    const requestArguments = { method: 'POST' as const, url: viewUrl, headers };
    const response = await app.inject(requestArguments);
    expect(response.statusCode, testName).toBe(403);
  } else {
    expect(await refusedUpgrade(address, headers), testName).toBe(403);
  }
  expect(await nats.store.head(), testName).toBe(before + expectedEvents);
  if (expectedEvents) {
    for await (const record of nats.store.subscribe(before + 1)) {
      expect(record.event.type).toBe('computer.view_refused');
      break;
    }
  }
}

async function checkOriginDecisions(route: ViewRoute, atCapacity = false) {
  const open = atCapacity ? openDesktop : openAvailableDesktop;
  const fixture = await upgradeFixture(atCapacity, open);
  try {
    if (!atCapacity) await grantDesktopToAlice(fixture);
    const aliceHeaders = aliceViewHeaders(fixture.config);
    const origins = ['https://hostile.example.test', undefined];
    const sessions = [
      { name: 'valid session', cookie: aliceHeaders.cookie, auditCount: 1 },
      {
        name: 'invalid session', cookie: `${fixture.config.cookieName}=invalid-cookie-value`,
        auditCount: 0,
      },
    ];
    for (const identity of sessions) {
      for (const origin of origins) {
        const headers: IncomingHttpHeaders = {
          cookie: identity.cookie, 'x-opencrane-view': aliceHeaders['x-opencrane-view'],
        };
        if (origin) headers.origin = origin;
        if (route === 'upgrade' && !atCapacity) {
          const ticket = await issueTicket(fixture, aliceHeaders);
          headers['sec-websocket-protocol'] = `binary, ${ticket}`;
        }
        const testName = `${identity.name}, ${origin ? 'hostile' : 'missing'} Origin`;
        await expectOriginRefusal(fixture, route, headers, testName, identity.auditCount);
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
  await checkOriginDecisions('upgrade', true);
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
