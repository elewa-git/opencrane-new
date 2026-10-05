import { nextBinaryMessage, recordLeaseNotices, expectUnavailablePause } from './support/rfb-viewer.ts';
import { IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { encodeSession } from '@opencrane/auth';
import { grantStream } from '@opencrane/authz';
import { history } from '@opencrane/models';
import { afterEach, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import * as access from '../src/computers/view-access.ts';
import { viewFixture } from './support/view-fixture.ts';
import { until } from '@opencrane/authz/testing';

const realAccess = access.viewAccess;
type Mode = 'real' | 'unavailable' | 'deny';
function restoreMocks() {
  vi.restoreAllMocks();
}
afterEach(restoreMocks);

async function admissionFixture() {
  let mode: Mode = 'real';
  let unavailableCalls = 0;
  let calls = 0;
  let opened = 0;
  function openDesktop() {
    opened++;
    const readable = new PassThrough();
    const writable = new PassThrough();
    writable.resume();
    readable.write(Buffer.from('RFB 003.008\n'));
    return Promise.resolve(Duplex.from({ readable, writable }));
  }
  const fixture = await viewFixture(openDesktop);
  const grant = {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId: 'alice',
    granteeKind: 'member', grantedBy: 'owner',
  };
  await fixture.append(grantStream('shared_desktop', 'desktop'), 'grant.given', grant, true);
  function check(...args: Parameters<typeof access.viewAccess>) {
    calls++;
    if (unavailableCalls > 0) {
      unavailableCalls--;
      return Promise.reject(new access.ViewCheckUnavailable('authorisation'));
    }
    if (mode === 'unavailable') return Promise.reject(new access.ViewCheckUnavailable('authorisation'));
    if (mode === 'deny') return Promise.reject(new Error('Access changed'));
    return realAccess(...args);
  }
  const authority = vi.spyOn(access, 'viewAccess');
  authority.mockImplementation(check);
  const identity = {
    sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const headers = {
    origin: new URL(fixture.config.redirectUri).origin, 'x-opencrane-view': '1',
    cookie: `${fixture.config.cookieName}=${encodeSession(fixture.config, identity)}`,
  };
  function post() {
    return fixture.app.inject({ method: 'POST', url: '/api/conversations/chat/view', headers });
  }
  function setMode(next: Mode, transientFailures = 0) {
    mode = next;
    unavailableCalls = transientFailures;
    calls = 0;
  }
  async function connect(ticket: string) {
    const address = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
    const url = `${address.replace('http:', 'ws:')}/ws/conversations/chat/view`;
    const socket = new WebSocket(url, ['binary', ticket], { headers });
    socket.on('error', ignoreError);
    return socket;
  }
  function counts() {
    return { opened, calls };
  }
  async function records(sessionId: string) {
    return history(fixture.nats.store, `view-${sessionId}`, 'test');
  }
  return { ...fixture, post, setMode, connect, counts, records };
}
function ignoreError() { /* Refused upgrades deliberately emit errors. */ }

async function retriesUpgrade() {
  const fixture = await admissionFixture();
  let socket: WebSocket | undefined;
  try {
    const admission = await fixture.post();
    expect(admission.statusCode).toBe(200);
    const issued = admission.json<{ ticket: string; sessionId: string }>();
    fixture.setMode('real', 2);
    socket = await fixture.connect(issued.ticket);
    await once(socket, 'open');
    expect(fixture.counts().opened).toBe(1);
    const records = await fixture.records(issued.sessionId);
    expect(records).toHaveLength(1);
    expect(records[0]?.event.type).toBe('computer.view_started');
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}
it('retries two unavailable upgrade checks before opening one audited desktop', retriesUpgrade, 30_000);

async function retriesAdmission() {
  const fixture = await admissionFixture();
  try {
    fixture.setMode('real', 2);
    expect((await fixture.post()).statusCode).toBe(200);
    expect(fixture.counts().calls).toBe(3);
  } finally {
    await fixture.close();
  }
}
it('retries two unavailable admission checks before issuing a ticket', retriesAdmission, 30_000);

async function unconfirmedAdmission() {
  const fixture = await admissionFixture();
  try {
    fixture.setMode('unavailable');
    const response = await fixture.post();
    expect(response.statusCode).toBe(503);
    const result = response.json<{ status: string; attemptId: string }>();
    expect(result.status).toBe('unavailable');
    const records = await fixture.records(result.attemptId);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toMatchObject({
      type: 'computer.view_refused', data: { reason: 'unavailable' },
    });
  } finally {
    await fixture.close();
  }
}
it('returns 503 and audits unavailable when admission cannot be confirmed', unconfirmedAdmission, 30_000);

async function deniedAdmission() {
  const fixture = await admissionFixture();
  try {
    fixture.setMode('deny');
    expect((await fixture.post()).statusCode).toBe(403);
    expect(fixture.counts().calls).toBe(1);
  } finally {
    await fixture.close();
  }
}
it('refuses an explicit admission denial after one check', deniedAdmission, 30_000);

async function unconfirmedUpgrade() {
  const fixture = await admissionFixture();
  let socket: WebSocket | undefined;
  try {
    const admission = await fixture.post();
    fixture.setMode('unavailable');
    socket = await fixture.connect(admission.json<{ ticket: string }>().ticket);
    const response = await once(socket, 'unexpected-response');
    const incoming: unknown = response[1];
    if (!(incoming instanceof IncomingMessage)) throw new Error('Missing upgrade response');
    expect(incoming.statusCode).toBe(503);
    expect(fixture.counts().opened).toBe(0);
    const records = await history(fixture.nats.store, 'view-*', 'test');
    function isRefusal(record: (typeof records)[number]) {
      return record.event.type === 'computer.view_refused';
    }
    const refusals = records.filter(isRefusal);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.event.data).toMatchObject({ reason: 'unavailable' });
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}
it('returns an upgrade 503 and audits unavailable without opening the desktop', unconfirmedUpgrade, 30_000);

async function closesForCheckFailure(scenario: { mode: 'unavailable' | 'deny'; code: number; reason: string }) {
  const fixture = await admissionFixture();
  let socket: WebSocket | undefined;
  try {
    const admission = await fixture.post();
    const issued = admission.json<{ ticket: string; sessionId: string }>();
    socket = await fixture.connect(issued.ticket);
    expect(await nextBinaryMessage(socket)).toEqual(Buffer.from('RFB 003.008\n'));
    const notices = recordLeaseNotices(socket);
    const closed = once(socket, 'close');
    const began = performance.now();
    fixture.setMode(scenario.mode);
    if (scenario.mode === 'unavailable') {
      await expectUnavailablePause(socket, began, notices);
    } else {
      expect((await closed)[0]).toBe(scenario.code);
      expect(performance.now() - began).toBeLessThan(2000);
    }
    async function stopped() {
      return (await fixture.records(issued.sessionId)).length === 2;
    }
    await until(stopped);
    expect((await fixture.records(issued.sessionId))[1]?.event.data)
      .toMatchObject({ reason: scenario.reason });
  } finally {
    socket?.terminate();
    await fixture.close();
  }
}
it.each([
  { mode: 'unavailable', code: 4503, reason: 'unavailable' },
  { mode: 'deny', code: 4003, reason: 'access_changed' },
] as const)('closes a displayed view with $code for $mode checks', closesForCheckFailure, 30_000);
