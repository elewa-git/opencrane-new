import { once } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Duplex, PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession } from '@opencrane/auth';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { until } from '@opencrane/authz/testing';
import { getEventDefinition } from '@opencrane/events';
import { authorityFence, history, payingGroupAuthority } from '@opencrane/models';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { viewFixture } from './support/view-fixture.ts';
import { recordLeaseNotices } from './support/rfb-viewer.ts';

type Fixture = Awaited<ReturnType<typeof viewFixture>>;
type InjectionPoint = 'fence start' | 'last conversation read';
interface Injection {
  subject: string;
  type: string;
  data: Record<string, unknown>;
  project: boolean;
}
interface CloseResult {
  code: number;
  reason: string;
  at: number;
}
const desktopSubject = grantStream('shared_desktop', 'desktop');
const injectionPoints: InjectionPoint[] = ['fence start', 'last conversation read'];
const activityTypes = [
  'agent.turn_started', 'agent.turn_completed', 'agent.turn_failed',
  'agent.turn_stop_requested', 'message.posted', 'file.uploaded', 'file.delivered',
  'participant.added', 'participant.removed', 'file.rejected',
];
const timingSchema = z.object({
  operation: z.literal('view.timing'),
  stage: z.literal('lease_check'),
  outcome: z.literal('unavailable'),
  boundary: z.literal('authority_changed'),
});
const authorisationTimingSchema = z.object({
  operation: z.literal('view.timing'),
  stage: z.literal('lease_check'),
  outcome: z.literal('unavailable'),
  boundary: z.literal('authorisation'),
});
let fixture: Fixture | undefined;
let socket: WebSocket | undefined;
const logs: { line: string; at: number }[] = [];

async function cleanup() {
  socket?.terminate();
  socket = undefined;
  vi.restoreAllMocks();
  await fixture?.close();
  fixture = undefined;
  vi.unstubAllEnvs();
  logs.length = 0;
}
afterEach(cleanup);

function openDesktop() {
  const writable = new PassThrough();
  writable.resume();
  const streams = { readable: new PassThrough(), writable };
  return Promise.resolve(Duplex.from(streams));
}
function writeLog(line: string) {
  const entry = { line, at: performance.now() };
  logs.push(entry);
}
async function createFixture() {
  vi.stubEnv('LOG_LEVEL', 'info');
  const destination = { write: writeLog };
  const current = await viewFixture(openDesktop, undefined, destination);
  fixture = current;
  return current;
}
function eventData(type: string, overrides: Record<string, unknown>) {
  const definition = getEventDefinition(type);
  if (!definition) {
    throw new Error(`Missing event definition: ${type}`);
  }
  const example = z.record(z.string(), z.unknown()).parse(definition.example);
  return { ...example, ...overrides };
}
function eventInjection(subject: string, type: string,
  overrides: Record<string, unknown>, project = false): Injection {
  const data = eventData(type, overrides);
  return { subject, type, data, project };
}
function conversationEvent(type: string, turnId = 'turn-1') {
  const overrides: Record<string, unknown> = { conversationId: 'chat' };
  const definition = getEventDefinition(type);
  const example = z.record(z.string(), z.unknown()).parse(definition?.example);
  if ('turnId' in example) {
    overrides['turnId'] = turnId;
  }
  if ('participantId' in example) {
    overrides['participantId'] = 'bob';
  }
  return eventInjection('conversation-chat', type, overrides);
}
function desktopGrant(granteeId: string, granteeKind = 'member', type = 'grant.given') {
  const overrides: Record<string, unknown> = {
    resourceType: 'shared_desktop', resourceId: 'desktop', granteeId,
  };
  if (type === 'grant.given') {
    overrides['granteeKind'] = granteeKind;
    overrides['grantedBy'] = 'owner';
  } else {
    overrides['revokedBy'] = 'owner';
  }
  return eventInjection(desktopSubject, type, overrides, type === 'grant.given');
}
async function appendInjection(current: Fixture, injection: Injection) {
  return current.append(injection.subject, injection.type, injection.data, injection.project);
}
async function grantDirectly(current: Fixture) {
  const injection = desktopGrant('alice');
  await appendInjection(current, injection);
}
async function grantThroughTeam(current: Fixture, teamId = 'viewers') {
  const details = { teamId, name: 'Viewers', createdBy: 'alice' };
  const created = eventInjection(`team-${teamId}`, 'team.created', details, true);
  const joined = teamChange(teamId, 'alice', 'team.member_added', true);
  await appendInjection(current, created);
  await appendInjection(current, joined);
  const grant = desktopGrant(teamId, 'team');
  await appendInjection(current, grant);
}
function teamChange(teamId: string, memberId: string, type: string, project = false) {
  const overrides: Record<string, unknown> = { teamId, memberId };
  if (type === 'team.member_added') {
    overrides['addedBy'] = 'alice';
  } else {
    overrides['removedBy'] = 'owner';
  }
  return eventInjection(`team-${teamId}`, type, overrides, project);
}
function requestHeaders(current: Fixture) {
  const session = {
    sub: 'alice', orgId: 'org-test', roles: [], authTime: 1,
    exp: Math.floor(Date.now() / 1000) + 120,
  };
  const cookie = encodeSession(current.config, session);
  return {
    origin: new URL(current.config.redirectUri).origin,
    'x-opencrane-view': '1', cookie: `${current.config.cookieName}=${cookie}`,
  };
}
async function admission(current: Fixture, headers = requestHeaders(current)) {
  const request = {
    method: 'POST' as const, url: '/api/conversations/chat/view',
    headers,
  };
  return current.app.inject(request);
}
async function admit(current: Fixture) {
  const headers = requestHeaders(current);
  const response = await admission(current, headers);
  expect(response.statusCode).toBe(200);
  const issued = response.json<{ ticket: string }>();
  const listenOptions = { host: '127.0.0.1', port: 0 };
  const address = await current.app.listen(listenOptions);
  const url = `${address.replace('http:', 'ws:')}/ws/conversations/chat/view`;
  return { url, ticket: issued.ticket, headers };
}
type Admitted = Awaited<ReturnType<typeof admit>>;
function ignoreSocketError() {
  // Allow deliberate refusals and revocations to reach the assertions.
}
function connect(admitted: Admitted) {
  const options = { headers: admitted.headers };
  const viewer = new WebSocket(admitted.url, ['binary', admitted.ticket], options);
  viewer.on('error', ignoreSocketError);
  socket = viewer;
  return viewer;
}
function observeViewer(viewer: WebSocket) {
  const notices = recordLeaseNotices(viewer);
  const closed = Promise.withResolvers<CloseResult>();
  let closeResult: CloseResult | undefined;
  function recordClose(code: number, reason: Buffer) {
    closeResult = { code, reason: String(reason), at: performance.now() };
    closed.resolve(closeResult);
  }
  function hasValidNotice() {
    function valid(entry: (typeof notices)[number]) {
      return entry.notice.lease === 'valid';
    }
    return notices.some(valid);
  }
  function result() {
    return closeResult;
  }
  viewer.once('close', recordClose);
  return { viewer, notices, closed: closed.promise, hasValidNotice, result };
}
type ObservedViewer = ReturnType<typeof observeViewer>;
async function startViewer(current: Fixture) {
  const admitted = await admit(current);
  const viewer = connect(admitted);
  const observed = observeViewer(viewer);
  await once(observed.viewer, 'open');
  await until(observed.hasValidNotice);
  return observed;
}

// Append after head() reads the starting event number, or before the last conversation read.
// Keep the real store reads so the next check can find the injected event.
function armInjection(current: Fixture, point: InjectionPoint, injection: Injection,
  skipFences = 0, persistent = false) {
  const state = { armed: true, injectedAt: 0, skipped: 0, count: 0 };
  const injected = Promise.withResolvers<void>();
  const realHead = current.nats.store.head.bind(current.nats.store);
  let appendTail = Promise.resolve();
  async function appendEvent() {
    state.count++;
    let next = injection;
    if (persistent) {
      next = conversationEvent('agent.turn_completed', `turn-${state.count}`);
    }
    await appendInjection(current, next);
    state.injectedAt = performance.now();
    injected.resolve();
  }
  function append() {
    state.armed = persistent;
    // Keep overlapping checks from racing to append to the same conversation.
    const appended = appendTail.then(appendEvent);
    appendTail = appended;
    return appended;
  }
  async function readHead(subject?: string, deadline?: number) {
    if (point === 'last conversation read' && !persistent) {
      const siblingHead = subject !== undefined && subject !== 'conversation-chat';
      if (siblingHead && state.injectedAt === 0) {
        // Wait for the append before reading the other streams' latest event numbers.
        // These reads run in parallel, so one could otherwise miss the event.
        await injected.promise;
      }
    }
    if (!state.armed) {
      return realHead(subject, deadline);
    }
    if (point === 'fence start' && subject === undefined) {
      const head = await realHead(subject, deadline);
      if (state.skipped < skipFences) {
        state.skipped++;
        return head;
      }
      await append();
      return head;
    }
    if (point === 'last conversation read' && subject !== undefined) {
      if (subject === 'conversation-chat') {
        await append();
      }
    }
    return realHead(subject, deadline);
  }
  vi.spyOn(current.nats.store, 'head').mockImplementation(readHead);
  return { state, injected: injected.promise };
}
async function stopReason(current: Fixture) {
  const records = await history(current.nats.store, 'view-*', 'test');
  function stopped(row: (typeof records)[number]) {
    return row.event.type === 'computer.view_stopped';
  }
  const stop = records.find(stopped);
  const data = z.object({ reason: z.string() }).optional().parse(stop?.event.data);
  return data?.reason;
}
async function expectNoRefusal(current: Fixture) {
  const records = await history(current.nats.store, 'view-*', 'test');
  function refused(row: (typeof records)[number]) {
    return row.event.type === 'computer.view_refused';
  }
  expect(records.some(refused)).toBe(false);
}
async function expectStaysOpen(current: Fixture, observed: ObservedViewer, appendedAt: number) {
  const remaining = Math.max(0, appendedAt + 2500 - performance.now());
  await delay(remaining);
  expect(observed.viewer.readyState).toBe(WebSocket.OPEN);
  function validAfterAppend(entry: (typeof observed.notices)[number]) {
    return entry.at > appendedAt && entry.notice.lease === 'valid';
  }
  expect(observed.notices.some(validAfterAppend)).toBe(true);
  expect(observed.result()).toBeUndefined();
  expect(await stopReason(current)).toBeUndefined();
}
async function expectRevoked(current: Fixture, observed: ObservedViewer, appendedAt: number,
  label: string) {
  const closed = await observed.closed;
  expect(closed.code).toBe(4003);
  expect(closed.reason).toBe('access_changed');
  const elapsed = closed.at - appendedAt;
  expect(elapsed).toBeLessThan(2000);
  async function stopped() {
    return await stopReason(current) !== undefined;
  }
  await until(stopped);
  expect(await stopReason(current)).toBe('access_changed');
  console.info(`Revocation ${label}: ${Math.round(elapsed)} ms`);
  return closed;
}
function hasUnavailableTimingBefore(closedAt = Infinity) {
  function matches(entry: (typeof logs)[number]) {
    const record: unknown = JSON.parse(entry.line);
    return entry.at < closedAt && timingSchema.safeParse(record).success;
  }
  return logs.some(matches);
}
function hasAuthorisationUnavailableTiming() {
  function matches(entry: (typeof logs)[number]) {
    const record: unknown = JSON.parse(entry.line);
    return authorisationTimingSchema.safeParse(record).success;
  }
  return logs.some(matches);
}
async function keepsViewerOpen(injection: Injection, point: InjectionPoint,
  throughTeam = false) {
  const current = await createFixture();
  if (throughTeam) {
    await grantThroughTeam(current);
  } else {
    await grantDirectly(current);
  }
  const observed = await startViewer(current);
  const armed = armInjection(current, point, injection);
  await armed.injected;
  await expectStaysOpen(current, observed, armed.state.injectedAt);
}
async function keepsChatActivityOpen(type: string) {
  await keepsViewerOpen(conversationEvent(type), 'last conversation read');
}
async function keepsOtherGrantOpen() {
  await keepsViewerOpen(desktopGrant('bob'), 'fence start');
}
async function keepsRoleChangeOpen() {
  const details = { memberId: 'alice', newRole: 'admin', changedBy: 'owner' };
  const injection = eventInjection('member-alice', 'member.role_changed', details, true);
  await keepsViewerOpen(injection, 'fence start');
}
function chatActivityTests() {
  it.each(activityTypes)('%s at the last conversation read keeps the viewer open',
    keepsChatActivityOpen, 30_000);
  it("another member's desktop grant keeps alice viewing", keepsOtherGrantOpen, 30_000);
  it('a member role change that keeps access keeps alice viewing', keepsRoleChangeOpen, 30_000);
}
describe('chat activity during an access check', chatActivityTests);

async function admitsDuringActivity() {
  const current = await createFixture();
  await grantDirectly(current);
  const injection = conversationEvent('agent.turn_completed');
  const armed = armInjection(current, 'last conversation read', injection);
  const response = await admission(current);
  await armed.injected;
  expect(response.statusCode).toBe(200);
  expect(response.json<{ ticket: string }>().ticket).toEqual(expect.any(String));
  await expectNoRefusal(current);
}
async function opensDuringActivity() {
  const current = await createFixture();
  await grantDirectly(current);
  const admitted = await admit(current);
  const injection = conversationEvent('agent.turn_completed');
  armInjection(current, 'fence start', injection);
  const viewer = connect(admitted);
  await once(viewer, 'open');
  const records = await history(current.nats.store, 'view-*', 'test');
  function started(row: (typeof records)[number]) {
    return row.event.type === 'computer.view_started';
  }
  expect(records.some(started)).toBe(true);
  await expectNoRefusal(current);
}
async function keepsFirstCheckOpen() {
  const current = await createFixture();
  await grantDirectly(current);
  const admitted = await admit(current);
  const injection = conversationEvent('agent.turn_completed');
  const armed = armInjection(current, 'fence start', injection, 1);
  const viewer = connect(admitted);
  const observed = observeViewer(viewer);
  await armed.injected;
  await expectStaysOpen(current, observed, armed.state.injectedAt);
}
function openingTests() {
  it('a turn report inside the admission check still issues a ticket', admitsDuringActivity, 30_000);
  it('a turn report inside the upgrade check still opens the socket', opensDuringActivity, 30_000);
  it('a turn report inside the first lease check keeps the socket', keepsFirstCheckOpen, 30_000);
}
describe('opening the viewer while chat activity lands', openingTests);

async function keepsTeamJoinOpen() {
  const injection = teamChange('viewers', 'bob', 'team.member_added', true);
  await keepsViewerOpen(injection, 'last conversation read', true);
}
async function resumesAfterTeamApplied() {
  const current = await createFixture();
  await grantThroughTeam(current);
  const observed = await startViewer(current);
  const injection = teamChange('viewers', 'bob', 'team.member_added');
  const event = await appendInjection(current, injection);
  const appendedAt = performance.now();
  const waitUntilLeaseExpires = Math.max(0, appendedAt + 2000 - performance.now());
  await delay(waitUntilLeaseExpires);
  expect(observed.viewer.readyState).toBe(WebSocket.OPEN);
  expect(observed.result()).toBeUndefined();
  expect(await stopReason(current)).toBeUndefined();
  function pausedAfterJoin(entry: (typeof observed.notices)[number]) {
    return entry.at > appendedAt && entry.notice.lease === 'paused';
  }
  expect(observed.notices.some(pausedAfterJoin)).toBe(true);
  function validAfterLeaseExpiry(entry: (typeof observed.notices)[number]) {
    return entry.at >= appendedAt + 1500 && entry.notice.lease === 'valid';
  }
  expect(observed.notices.some(validAfterLeaseExpiry)).toBe(false);
  expect(hasAuthorisationUnavailableTiming()).toBe(true);
  const appliedAt = performance.now();
  const authorisation = memberAuthorisation(current.binding);
  await authorisation.handler.handle(event, current.db);
  function resumed() {
    function validAfterApplied(entry: (typeof observed.notices)[number]) {
      return entry.at > appliedAt && entry.notice.lease === 'valid';
    }
    return observed.notices.some(validAfterApplied);
  }
  await until(resumed, 3000);
  expect(observed.viewer.readyState).toBe(WebSocket.OPEN);
  expect(observed.result()).toBeUndefined();
  expect(await stopReason(current)).toBeUndefined();
}
async function deniesOtherFreshnessErrors() {
  const current = await createFixture();
  await grantDirectly(current);
  const observed = await startViewer(current);
  const realHead = current.nats.store.head.bind(current.nats.store);
  async function headWithMemberReadFailure(subject?: string, deadline?: number) {
    if (subject === 'member-alice') {
      throw new Error('boom');
    }
    return realHead(subject, deadline);
  }
  vi.spyOn(current.nats.store, 'head').mockImplementation(headWithMemberReadFailure);
  const closed = await observed.closed;
  expect(closed.code).toBe(4003);
  expect(closed.reason).toBe('access_changed');
}
async function closesTeamRemoval() {
  const current = await createFixture();
  await grantThroughTeam(current);
  const observed = await startViewer(current);
  const injection = teamChange('viewers', 'alice', 'team.member_removed');
  const armed = armInjection(current, 'last conversation read', injection);
  await armed.injected;
  await expectRevoked(current, observed, armed.state.injectedAt, 'team.member_removed');
}
async function keepsSecondTeamAvailable() {
  const current = await createFixture();
  await grantThroughTeam(current);
  await grantThroughTeam(current, 'others');
  const observed = await startViewer(current);
  const injection = teamChange('viewers', 'bob', 'team.member_added');
  await appendInjection(current, injection);
  const appendedAt = performance.now();
  await expectStaysOpen(current, observed, appendedAt);
  function successfulRenewal(entry: (typeof observed.notices)[number]) {
    return entry.at > appendedAt + 1500 && entry.notice.lease === 'valid';
  }
  expect(observed.notices.some(successfulRenewal)).toBe(true);
}
function teamTests() {
  it('stays open when another member joins the team during a check', keepsTeamJoinOpen, 30_000);
  it("stays open while IAM has not applied another member's team join, then resumes",
    resumesAfterTeamApplied, 30_000);
  it('denies a plain error from the final freshness check', deniesOtherFreshnessErrors, 30_000);
  it('closes within 2,000 ms when alice leaves the team during a check',
    closesTeamRemoval, 30_000);
  it('keeps viewing through a second team while the first team is still being applied',
    keepsSecondTeamAvailable, 30_000);
}
describe('a viewer granted through a team', teamTests);

function revocation(type: string) {
  if (type === 'grant.revoked') {
    return desktopGrant('alice', 'member', type);
  }
  if (type === 'member.removed') {
    const overrides = { memberId: 'alice' };
    return eventInjection('member-alice', type, overrides);
  }
  const details: Record<string, unknown> = { conversationId: 'chat' };
  if (type === 'participant.removed') {
    details['participantId'] = 'alice';
  }
  return eventInjection('conversation-chat', type, details);
}
const revocationCases: { type: string; point: InjectionPoint }[] = [];
for (const type of ['grant.revoked', 'participant.removed', 'conversation.closed', 'member.removed']) {
  for (const point of injectionPoints) {
    const testCase = { type, point };
    revocationCases.push(testCase);
  }
}
async function closesRevocation(testCase: (typeof revocationCases)[number]) {
  const current = await createFixture();
  await grantDirectly(current);
  const observed = await startViewer(current);
  const injection = revocation(testCase.type);
  const armed = armInjection(current, testCase.point, injection);
  await armed.injected;
  const label = `${testCase.type} / ${testCase.point}`;
  const closed = await expectRevoked(current, observed, armed.state.injectedAt, label);
  if (testCase.point === 'last conversation read') {
    expect(hasUnavailableTimingBefore(closed.at)).toBe(true);
  }
}
async function closesDuringContinuousActivity(revokedType: string) {
  const current = await createFixture();
  await grantDirectly(current);
  const observed = await startViewer(current);
  const injection = conversationEvent('agent.turn_completed');
  const armed = armInjection(current, 'last conversation read', injection, 0, true);
  await armed.injected;
  await delay(1000);
  expect(observed.viewer.readyState).toBe(WebSocket.OPEN);
  const revoked = revocation(revokedType);
  await appendInjection(current, revoked);
  const revokedAt = performance.now();
  await expectRevoked(current, observed, revokedAt, `${revokedType} / continuous activity`);
}
async function refusesRevokedUpgrade(point: InjectionPoint) {
  const current = await createFixture();
  await grantDirectly(current);
  const admitted = await admit(current);
  const injection = revocation('grant.revoked');
  const injectionState = armInjection(current, point, injection);
  const viewer = connect(admitted);
  const result = Promise.withResolvers<number>();
  function refused(_request: unknown, response: IncomingMessage) {
    result.resolve(response.statusCode ?? 0);
    response.resume();
    viewer.terminate();
  }
  function opened() {
    result.resolve(101);
  }
  viewer.once('unexpected-response', refused);
  viewer.once('open', opened);
  await injectionState.injected;
  const status = await result.promise;
  expect(status).toBe(403);
  const records = await history(current.nats.store, 'view-*', 'test');
  function upgradeRefused(row: (typeof records)[number]) {
    if (row.event.type !== 'computer.view_refused') {
      return false;
    }
    const data = z.object({ reason: z.string() }).parse(row.event.data);
    return data.reason === 'upgrade';
  }
  expect(records.some(upgradeRefused)).toBe(true);
}
function revocationTests() {
  it.each(revocationCases)('$type at $point closes within 2,000 ms', closesRevocation, 30_000);
  it.each(['grant.revoked', 'member.removed'])(
    'closes within 2,000 ms for %s while every check sees chat activity',
    closesDuringContinuousActivity, 30_000);
  it.each(injectionPoints)('a grant revocation inside the upgrade check at %s refuses the upgrade',
    refusesRevokedUpgrade, 30_000);
}
describe('real revocations during an access check still close the viewer', revocationTests);

async function logsUnconfirmedActivity() {
  const injection = conversationEvent('agent.turn_completed');
  await keepsViewerOpen(injection, 'last conversation read');
  expect(hasUnavailableTimingBefore()).toBe(true);
}
function timingTests() {
  it('logs a check that saw chat activity as unavailable with boundary authority_changed',
    logsUnconfirmedActivity, 30_000);
}
describe('timing records', timingTests);

async function keepsExactChangedMessage() {
  const current = await createFixture();
  const subjects = ['conversation-chat'];
  const fresh = await authorityFence(current.nats.store, performance.now(), subjects);
  const injection = conversationEvent('agent.turn_completed');
  await appendInjection(current, injection);
  await expect(fresh()).rejects.toEqual(new Error('Authority changed'));
}
it('throws the exact Authority changed message when the watched history moves',
  keepsExactChangedMessage, 30_000);

async function keepsActiveSiloMembershipRefusalMessage() {
  const current = await createFixture();
  await grantThroughTeam(current);
  const removed = eventInjection('member-alice', 'member.removed', {
    memberId: 'alice', removedBy: 'owner',
  });
  await appendInjection(current, removed);
  const authority = payingGroupAuthority(
    current.nats.store, 'test', 'alice', 'viewers', current.binding);
  await expect(authority).rejects.toMatchObject({
    message: 'Active silo membership required',
  });
}
it('keeps the exact refusal message for a removed silo member',
  keepsActiveSiloMembershipRefusalMessage, 30_000);
