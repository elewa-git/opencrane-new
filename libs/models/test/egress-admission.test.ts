import { Server } from 'node:net';
import { once } from 'node:events';
import { chmod, copyFile, readFile, readdir, stat, writeFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { recoverEgressReceipt } from '../src/egress-receipt.ts';
import { parseEventByType } from '@opencrane/events';
import { startEgress } from '../src/egress-startup.ts';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished, vi } from 'vitest';
import { egressGrantStream } from '@opencrane/projections';
import { z } from 'zod';
import { decodeJwt } from 'jose';
import { verifyEgressCapability } from '@opencrane/auth';
import { failingPublishStore } from '@opencrane/event-store/testing';
import { history } from '../src/event-history.ts';
import { fixture } from './fixture.ts';
import { egressFixture } from './egress-fixture.ts';
import { clientHello } from './egress-hello-fixture.ts';

const destination = { host: 'registry.npmjs.org', port: 443 };
async function setup(missing?: string, problem = 'missing', team = false) {
  const facts = await fixture(2000, 20000, false, 'gpt-6-luna', team);
  // Allow the test services to drain before removing their temporary data.
  onTestFinished(facts.close.bind(facts), 30_000);
  await facts.stopDispatch();
  const positions: number[] = [];
  for (const [scope, subjectId] of [['silo', 'test'], ['person', 'alice'],
    ['assistant', 'assistant']] as const) {
    const changed = scope === missing;
    let silo = 'test';
    const rule = { ...destination, scope, subjectId: String(subjectId) };
    if (changed && problem === 'port') rule.port = 8443;
    if (changed && problem === 'foreign') {
      silo = 'other';
      if (scope === 'silo') rule.subjectId = 'other';
    }
    const subject = egressGrantStream(silo, rule);
    const eventId = randomUUID();
    const event = { id: eventId, commandId: eventId, subject, silo,
      type: changed && problem === 'revoked' ? 'egress.destination_revoked'
        : 'egress.destination_allowed', source: 'opencrane-server',
      time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'alice' },
      correlation: {}, data: { ...rule, changedBy: 'alice', expectedSequence: 0 } };
    if (!changed || problem !== 'missing') {
      const saved = await facts.nats.store.append({ event, expectedSequence: 0 });
      expect(saved.status).toBe('appended');
    }
    positions.push(await facts.nats.store.head(subject) || 1);
  }
  const production = { actor: facts.actor, identity: facts.identity, binding: facts.binding };
  const gateway = await egressFixture(true, true, { production });
  const expires = Date.now() + 60_000;
  const claims = { silo: 'test', requester: 'alice', assistant: 'assistant', computer: 'computer',
    generation: 1, conversation: 'conversation', thread: 'thread', turn: 'turn',
    operationId: 'operation', operationKind: 'npm-install', operationDigest: '0'.repeat(64),
    ...destination, channel: 'command' as const, siloPosition: positions[0]!,
    personPosition: positions[1]!, assistantPosition: positions[2]!,
    turnExpiresAt: expires, grantExpiresAt: expires };
  async function token(patch = {}) {
    const input = { ...claims, ...patch };
    return (await facts.tokens.egress(input)).value;
  }
  async function tunnel(bearer: string) {
    return gateway.tunnel(bearer, 'registry.npmjs.org:443', clientHello());
  }
  return { facts, gateway, claims, token, tunnel };
}

async function admitsOnce() {
  const test = await setup();
  const bearer = await test.token();
  expect(await test.tunnel(bearer)).toBe(200);
  expect(await test.tunnel(bearer)).toBe(403);
  expect(test.gateway.connected()).toBe(1);
  expect(test.facts.actor.state.dispatches).toHaveLength(1);
  expect(test.facts.actor.state.reservations).toHaveLength(0);
  const id = decodeJwt(bearer).jti!;
  const saved = await history(test.facts.nats.store, `decision-${id}`, 'test');
  expect(saved).toHaveLength(1);
  expect(saved[0]!.event.data).toMatchObject({ route: 'egress', outcome: 'allow', permitId: id });
  expect(test.gateway.received()).toEqual(clientHello());
}

it('admits one recorded zero-cost connection through the production decision route', admitsOnce);

async function refusesMissingRule(scope: string, problem: string) {
  const test = await setup(scope, problem);
  const bearer = await test.token();
  expect(await test.tunnel(bearer)).toBe(403);
  const id = decodeJwt(bearer).jti!;
  const saved = await history(test.facts.nats.store, `decision-${id}`, 'test');
  expect(saved).toHaveLength(1);
  expect(saved[0]!.event.data).toMatchObject({ outcome: 'deny', reason: `missing_${scope}_rule` });
  expect(test.gateway.connected()).toBe(0);
}
const ruleCases: [string, string][] = [];
for (const scope of ['silo', 'person', 'assistant']) {
  for (const problem of ['missing', 'revoked', 'foreign', 'port']) {
    ruleCases.push([scope, problem]);
  }
}
it.each(ruleCases)('refuses the %s rule when it is %s', refusesMissingRule);

async function refusesChangedCapabilities() {
  const test = await setup();
  const cases = [
    { computer: 'other' }, { generation: 2 }, { silo: 'other' },
    { channel: 'desktop', leaseExpiresAt: Date.now() + 60_000 },
    { port: 8443 }, { host: 'github.com' }, { turn: 'ended' },
    { conversation: 'other' }, { thread: 'other' }, { requester: 'other' },
    { personPosition: 1 }, { assistantPosition: 1 }, { siloPosition: 1 },
  ];
  for (const patch of cases) {
    expect(await test.tunnel(await test.token(patch))).toBe(403);
  }
  for (const [audience, ttl] of [['computer-egress', 61], ['computer-egress', -1],
    ['decision-service', 60], ['agentgateway', 60]] as const) {
    const claims = { ...test.claims, jti: randomUUID(), typ: 'computer-egress',
      turnExpiresAt: Date.now() + 120_000, grantExpiresAt: Date.now() + 120_000 };
    const bearer = await test.facts.sign(claims, audience, ttl);
    expect(await test.tunnel(bearer)).not.toBe(200);
  }
  expect(test.gateway.connected()).toBe(0);
  expect(test.facts.actor.state.dispatches).toHaveLength(0);
}
it('refuses substituted bindings, wrong audiences and invalid lifetimes', refusesChangedCapabilities);

async function checksSigningBounds() {
  const test = await setup();
  for (const limit of ['turnExpiresAt', 'grantExpiresAt', 'leaseExpiresAt']) {
    const expiresAt = Date.now() + 20_000;
    const bearer = await test.token({ [limit]: expiresAt });
    const claims = decodeJwt(bearer);
    expect(claims.exp! * 1000).toBeLessThanOrEqual(expiresAt);
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(60);
    await expect(verifyEgressCapability(test.facts.tokens, bearer, 'desktop')).rejects.toThrow();
    await expect(test.facts.tokens.verify(bearer, 'agentgateway')).rejects.toThrow();
    await expect(test.token({ [limit]: claims.iat! * 1000 - 1 })).rejects.toThrow();
  }
}
it('bounds signed passes by every deadline and separates channels', checksSigningBounds);

async function refusesSavedRemoval(change: string) {
  const test = await setup();
  const bearer = await test.token();
  if (change === 'member') {
    await test.facts.append('member-alice', 'member.removed',
      { memberId: 'alice', removedBy: 'alice' });
  } else if (change === 'assistant') {
    await test.facts.append('assistant-assistant', 'assistant.settings_changed',
      { assistantId: 'assistant', active: false, changedBy: 'alice', changedFields: ['active'] });
  } else {
    await test.facts.append('computer-assistant', 'computer.turn_closed', {
      assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
      turnId: 'turn', requesterId: 'alice', task: 'chat_turn', status: 'completed' });
  }
  expect(await test.tunnel(bearer)).toBe(403);
  expect(test.gateway.connected()).toBe(0);
}
it.each(['member', 'assistant', 'turn'])('refuses a saved %s removal with IAM lagging',
  refusesSavedRemoval);

async function racesOnePermit() {
  const test = await setup();
  const bearer = await test.token();
  const responses = await Promise.all([test.tunnel(bearer), test.tunnel(bearer)]);
  responses.sort();
  expect(responses).toEqual([200, 403]);
  expect(test.gateway.connected()).toBe(1);
  expect(test.facts.actor.state.dispatches).toHaveLength(1);
}
it('admits at most one of two simultaneous uses of a pass', racesOnePermit);

async function refusesAfterDecision(failure: string) {
  const test = await setup();
  const append = test.facts.nats.store.append.bind(test.facts.nats.store);
  let connectionsAtDecision = -1;
  async function intercept(input: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(input.event);
    if (event.type !== 'decision.recorded') return append(input);
    connectionsAtDecision = test.gateway.connected();
    if (failure === 'audit') throw new Error('private-canary');
    const saved = await append(input);
    if (failure === 'lost-reply') throw new Error('private-canary');
    const scopeId = failure === 'unrelated' ? 'other' : 'assistant';
    const stop = { scope: 'assistant' as const, scopeId,
      ceilingCents: 0, setBy: 'alice' };
    await test.facts.actor.configure(stop);
    return saved;
  }
  const barrier = vi.spyOn(test.facts.nats.store, 'append').mockImplementation(intercept);
  onTestFinished(barrier.mockRestore.bind(barrier));
  const status = await test.tunnel(await test.token());
  expect(connectionsAtDecision).toBe(0);
  if (failure === 'budget' || failure === 'unrelated') {
    const rows = await history(test.facts.nats.store, 'budget-test', 'test');
    function assistantCeiling(row: (typeof rows)[number]) {
      return row.event.type === 'budget.ceiling_set' &&
        JSON.stringify(row.event.data).includes('"scope":"assistant"');
    }
    const stop = rows.find(assistantCeiling);
    const scopeId = failure === 'unrelated' ? 'other' : 'assistant';
    expect(stop?.event.data).toMatchObject({ scope: 'assistant', scopeId, ceilingCents: 0 });
  }
  if (failure === 'unrelated') {
    expect(status).toBe(200);
    expect(test.gateway.connected()).toBe(1);
  } else {
    expect(status).not.toBe(200);
    expect(test.gateway.connected()).toBe(0);
    expect(test.facts.actor.state.dispatches).toHaveLength(0);
  }
}
it.each(['audit', 'lost-reply', 'budget', 'unrelated'])('checks %s between saved decision and relay registration', refusesAfterDecision);

async function refusesFailedRegistration(failure: string) {
  const test = await setup();
  function unavailableRelay(): never {
    throw new Error('private-canary');
  }
  const registration = failure === 'listener'
    ? vi.spyOn(Server.prototype, 'listen') : vi.spyOn(test.gateway.registry, 'register');
  registration.mockImplementation(unavailableRelay);
  onTestFinished(registration.mockRestore.bind(registration));
  expect(await test.tunnel(await test.token())).toBe(403);
  expect(test.gateway.connected()).toBe(0);
  expect(test.facts.actor.state.dispatches).toHaveLength(1);
  if (failure === 'listener') {
    await test.gateway.runtime.flush();
    const dispatch = test.facts.actor.state.dispatches[0]!;
    const rows = await history(test.facts.nats.store, `egress-${dispatch.callId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.data).toMatchObject({ relay: { reason: 'failed' } });
  }
}
it.each(['registry', 'listener'])(
  'opens no connection when admitted relay registration fails at %s', refusesFailedRegistration);

async function changesDuringDispatchRetry(change: string) {
  const test = await setup();
  const bearer = await test.token();
  const requestId = decodeJwt(bearer).jti!;
  const retry = await failingPublishStore(test.facts.nats.connection);
  const append = test.facts.nats.store.append.bind(test.facts.nats.store);
  const register = test.gateway.registry.register.bind(test.gateway.registry);
  const registration = vi.spyOn(test.gateway.registry, 'register');
  onTestFinished(registration.mockRestore.bind(registration));
  async function expiredRegistration(input: Parameters<typeof register>[0]) {
    expireAuthority();
    return register(input);
  }
  if (change === 'registration-deadline') registration.mockImplementation(expiredRegistration);

  async function changeAuthority() {
    expect(registration).not.toHaveBeenCalled();
    expect(test.gateway.connected()).toBe(0);
    if (change === 'destination') {
      const rule = { ...destination, scope: 'person' as const, subjectId: 'alice' };
      const subject = egressGrantStream('test', rule);
      const expectedSequence = await test.facts.nats.store.head(subject);
      const payload = { ...rule, changedBy: 'alice', expectedSequence };
      const eventId = randomUUID();
      const event = { id: eventId, commandId: eventId, subject, silo: 'test',
        type: 'egress.destination_revoked', source: 'opencrane-server',
        time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'alice' },
        correlation: {}, data: payload };
      const command = { event, expectedSequence };
      expect(await append(command)).toMatchObject({ status: 'appended' });
    } else if (change === 'turn') {
      const closed = { assistantId: 'assistant', computerId: 'computer',
        conversationId: 'conversation', turnId: 'turn', requesterId: 'alice',
        task: 'chat_turn', status: 'completed' };
      await test.facts.append('computer-assistant', 'computer.turn_closed', closed);
    } else if (change === 'deadline') {
      expireAuthority();
    } else if (change === 'expiry') {
      const now = Date.now;
      function afterExpiry() {
        return now() + 61_000;
      }
      const clock = vi.spyOn(Date, 'now').mockImplementation(afterExpiry);
      onTestFinished(clock.mockRestore.bind(clock));
    }
  }
  async function retryDispatch(input: Parameters<typeof append>[0]) {
    const event = z.object({ type: z.string() }).parse(input.event);
    if (event.type !== 'budget.call_dispatch_admitted') return append(input);
    retry.failNextPublish(changeAuthority);
    return retry.store.append(input);
  }
  const barrier = vi.spyOn(test.facts.nats.store, 'append').mockImplementation(retryDispatch);
  onTestFinished(barrier.mockRestore.bind(barrier));
  const headers = { authorization: `Bearer ${bearer}`,
    'x-egress-authority': 'registry.npmjs.org:443' };
  const options = { method: 'POST', headers };
  const response = await fetch(`${test.gateway.decisionUrl}/authorize/egress`, options);
  expect(retry.publishAttempts()).toBe(2);
  expect(test.facts.actor.state.dispatches).toHaveLength(1);
  expect(test.facts.actor.state.reservations).toHaveLength(0);
  expect(test.gateway.connected()).toBe(0);
  if (change === 'none') {
    expect(response.status).toBe(200);
    expect(registration).toHaveBeenCalledTimes(1);
    expect(response.headers.get('x-egress-relay')).toMatch(/^127\.0\.0\.1:\d+$/u);
    return;
  }
  expect.soft(response.status).toBe(403);
  expect.soft(await response.text()).toBe('{"reason":"egress_refused"}');
  expect.soft(response.headers.get('x-egress-relay')).toBeNull();
  if (change !== 'registration-deadline') expect.soft(registration).not.toHaveBeenCalled();
  const outcomes = await history(test.facts.nats.store, `egress-${requestId}`, 'test');
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.event.type).toBe('egress.observed');
  expect(outcomes[0]!.event.data).toMatchObject({ requestId, permitId: requestId,
    channel: 'command', outcome: 'error' });
}
it.each(['destination', 'turn', 'deadline', 'registration-deadline', 'expiry', 'none'])(
  'rechecks %s after the real budget dispatch append retries', changesDuringDispatchRetry);

function expireAuthority() {
  const now = performance.now.bind(performance);
  function afterDeadline() {
    return now() + 2100;
  }
  const clock = vi.spyOn(performance, 'now').mockImplementation(afterDeadline);
  onTestFinished(clock.mockRestore.bind(clock));
}

async function closeObservation(test: Awaited<ReturnType<typeof setup>>, bearer: string) {
  await test.gateway.upstreamClosed();
  await test.gateway.runtime.flush();
  const rows = await history(test.facts.nats.store, `egress-${decodeJwt(bearer).jti!}`, 'test');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.event.type).toBe('egress.observed');
  expect(test.gateway.connected()).toBe(1);
  return rows[0]!.event.data;
}
async function callerReceipt() {
  const test = await setup();
  const bearer = await test.token();
  expect(await test.tunnel(bearer)).toBe(200);
  expect(await closeObservation(test, bearer)).toMatchObject({
    outcome: 'unknown', relay: { reason: 'finished' } });
  await test.gateway.runtime.close();
  expect(await test.tunnel(bearer)).toBe(403);
  await test.gateway.restartRuntime();
  expect(await test.tunnel(bearer)).toBe(403);
  await closeObservation(test, bearer);
  expect(test.gateway.activeConnections()).toBe(0);
}
it('saves one caller close through startup and refuses permit reuse across restart', callerReceipt);

async function revokeLive(change: string) {
  const test = await setup(undefined, 'missing', change === 'team');
  const bearer = await test.token();
  async function duringRelay(socket: import('node:net').Socket) {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    const started = performance.now();
    if (['silo', 'person', 'assistant-rule'].includes(change)) {
      const scope = z.enum(['silo', 'person', 'assistant']).parse(
        change === 'assistant-rule' ? 'assistant' : change);
      const subjects = { silo: 'test', person: 'alice', assistant: 'assistant' };
      const subjectId = subjects[scope];
      const rule = { ...destination, scope, subjectId };
      const subject = egressGrantStream('test', rule);
      const expectedSequence = await test.facts.nats.store.head(subject);
      const id = randomUUID();
      const event = { id, commandId: id, subject, silo: 'test',
        type: 'egress.destination_revoked', source: 'opencrane-server',
        time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'alice' },
        correlation: {}, data: { ...rule, changedBy: 'alice', expectedSequence } };
      expect(await test.facts.nats.store.append({ event, expectedSequence }))
        .toMatchObject({ status: 'appended' });
    } else if (change === 'team') {
      await test.facts.append('team-sales', 'team.member_removed',
        { teamId: 'sales', memberId: 'alice', removedBy: 'alice' });
    } else if (change === 'member') {
      await test.facts.append('member-alice', 'member.removed',
        { memberId: 'alice', removedBy: 'alice' });
    } else if (change === 'assistant') {
      await test.facts.append('assistant-assistant', 'assistant.settings_changed',
        { assistantId: 'assistant', active: false, changedBy: 'alice', changedFields: ['active'] });
    } else if (change === 'generation') {
      await test.facts.append('computer-assistant', 'computer.ready',
        { assistantId: 'assistant', computerId: 'computer', generation: 2, podUid: 'next' });
    } else if (change === 'turn') {
      await test.facts.append('computer-assistant', 'computer.turn_closed', {
        assistantId: 'assistant', computerId: 'computer', conversationId: 'conversation',
        turnId: 'turn', requesterId: 'alice', task: 'chat_turn', status: 'completed' });
    } else if (change === 'conversation') {
      await test.facts.append('participation-conversation', 'conversation.closed',
        { conversationId: 'conversation', closedBy: 'alice' });
    } else {
      let scope: 'global' | 'paying_group' | 'assistant' = 'assistant';
      if (change === 'silo-stop') scope = 'global';
      if (change === 'group-stop') scope = 'paying_group';
      const scopeId = scope === 'paying_group' ? 'personal-default' : 'assistant';
      const subject = scope === 'global' ? {} : { scopeId };
      await test.facts.actor.configure({ scope, ...subject, ceilingCents: 0, setBy: 'alice' });
    }
    await closed;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(socket.destroyed).toBe(true);
  }
  expect(await test.gateway.tunnel(bearer, 'registry.npmjs.org:443', clientHello(),
    duringRelay)).toBe(200);
  expect(await closeObservation(test, bearer)).toMatchObject({ relay: { reason: 'revoked' } });
  expect(test.gateway.activeConnections()).toBe(0);
}
it.each(['silo', 'person', 'assistant-rule', 'member', 'assistant', 'generation', 'turn',
  'conversation', 'spending', 'group-stop', 'silo-stop', 'team'])('closes a live relay within two seconds after %s revocation', revokeLive);

async function harmlessChange() {
  const test = await setup();
  const bearer = await test.token();
  const reads: { subject: string; from: number | undefined }[] = [];
  const read = test.facts.nats.store.readStream.bind(test.facts.nats.store);
  async function duringRelay(socket: import('node:net').Socket) {
    function track(subject: string, from?: number, deadline?: number, closes?: boolean) {
      if (!subject.startsWith('budget-')) reads.push({ subject, from });
      return read(subject, from, deadline, closes);
    }
    const wrapped = vi.spyOn(test.facts.nats.store, 'readStream').mockImplementation(track);
    onTestFinished(wrapped.mockRestore.bind(wrapped));
    await test.facts.append('assistant-assistant', 'assistant.settings_changed',
      { assistantId: 'assistant', changedBy: 'alice', changedFields: ['model'] });
    await test.facts.actor.configure({ scope: 'assistant', scopeId: 'other',
      ceilingCents: 0, setBy: 'alice' });
    const head = test.facts.nats.store.head.bind(test.facts.nats.store);
    const checked = Promise.withResolvers<void>();
    let rounds = 0;
    async function watch(subject?: string, deadline?: number, closes?: boolean) {
      const position = await head(subject, deadline, closes);
      if (subject === 'member-alice' && ++rounds === 4) checked.resolve();
      return position;
    }
    const watched = vi.spyOn(test.facts.nats.store, 'head').mockImplementation(watch);
    onTestFinished(watched.mockRestore.bind(watched));
    await checked.promise;
    expect(socket.destroyed).toBe(false);
    expect(test.gateway.activeConnections()).toBe(1);
    expect(reads.length).toBeGreaterThan(0);
    for (const row of reads) {
      expect(row.from).toBeGreaterThan(1);
      expect(row.subject.startsWith('conversation-')).toBe(false);
      expect(row.subject.startsWith('computer-')).toBe(false);
    }
  }
  expect(await test.gateway.tunnel(bearer, 'registry.npmjs.org:443', clientHello(),
    duringRelay)).toBe(200);
}
it('keeps harmless watched changes and unrelated spending open using only tails', harmlessChange);

async function gracefulRestart() {
  const test = await setup();
  const bearer = await test.token();
  async function duringRelay(socket: import('node:net').Socket) {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    await test.gateway.restartRuntime();
    await closed;
  }
  expect(await test.gateway.tunnel(bearer, 'registry.npmjs.org:443', clientHello(),
    duringRelay)).toBe(200);
  expect(await closeObservation(test, bearer)).toMatchObject({ relay: { reason: 'unavailable' } });
  expect(await test.tunnel(bearer)).toBe(403);
  expect(test.gateway.connected()).toBe(1);
}
it('closes an open relay once on graceful restart and replay opens no relay', gracefulRestart);

async function retainedRecords() {
  const test = await setup();
  const bearer = await test.token();
  async function duringRelay() {
    await test.facts.nats.stop();
  }
  expect(await test.gateway.tunnel(bearer, 'registry.npmjs.org:443', clientHello(),
    duringRelay)).toBe(200);
  await test.gateway.runtime.close();
  const directory = join(test.gateway.directory, 'egress');
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const original = join(directory, files[0]!);
  await copyFile(original, join(directory, 'renamed.jsonl'));
  const foreign = z.record(z.string(), z.unknown()).parse(
    JSON.parse(await readFile(original, 'utf8')));
  foreign['silo'] = 'foreign';
  await writeFile(join(directory, 'foreign.jsonl'), JSON.stringify(foreign), { mode: 0o600 });
  await test.facts.nats.restart();
  await test.gateway.restartRuntime();
  await closeObservation(test, bearer);
  await test.gateway.restartRuntime();
  await closeObservation(test, bearer);
  expect(await readdir(directory)).toHaveLength(3);
  expect(test.gateway.order.filter(isRefusal)).toHaveLength(4);
}
function isRefusal(value: string) {
  return value === 'egress_receipt_refused';
}
it('recovers retained outage evidence once and keeps renamed and foreign files refused', retainedRecords);

async function privateDirectory() {
  const test = await setup();
  const directory = join(test.gateway.directory, 'egress');
  expect((await stat(directory)).mode & 0o777).toBe(0o700);
  await test.gateway.runtime.close();
  await chmod(directory, 0o755);
  await expect(startEgress(test.facts.nats.store, 'test', test.gateway.directory,
    refusedDirectory)).rejects.toThrow('egress_directory_refused');
}
function refusedDirectory() {
  throw new Error('Unexpected log');
}
it('creates a private receipt directory and refuses existing wider access', privateDirectory);

async function unrelatedTeamRemoval() {
  const test = await setup(undefined, 'missing', true);
  await test.facts.append('team-sales', 'team.member_added',
    { teamId: 'sales', memberId: 'bob', addedBy: 'alice' });
  const bearer = await test.token();
  const checked = Promise.withResolvers<boolean>();
  let removalSaved = false;
  const register = test.gateway.registry.register.bind(test.gateway.registry);
  async function trackRegistration(input: Parameters<typeof register>[0]) {
    async function recheck() {
      const checksRemoval = removalSaved;
      try {
        await input.recheck!();
        if (checksRemoval) checked.resolve(true);
      } catch (error) {
        if (checksRemoval) checked.resolve(false);
        throw error;
      }
    }
    return register({ ...input, recheck });
  }
  const tracked = vi.spyOn(test.gateway.registry, 'register').mockImplementation(trackRegistration);
  onTestFinished(tracked.mockRestore.bind(tracked));
  async function duringRelay(socket: import('node:net').Socket) {
    // Hold the IAM receipt by saving the removal without running its projection handler.
    const bob = await test.facts.append('team-sales', 'team.member_removed',
      { teamId: 'sales', memberId: 'bob', removedBy: 'alice' });
    removalSaved = true;
    expect(await test.facts.auth.applied(bob.id)).toBe(false);
    expect(await checked.promise).toBe(true);
    expect(socket.destroyed).toBe(false);
    expect(test.gateway.activeConnections()).toBe(1);
    await test.gateway.runtime.flush();
    const rows = await history(test.facts.nats.store, `egress-${decodeJwt(bearer).jti!}`, 'test');
    expect(rows).toHaveLength(0);
    expect(await test.facts.auth.applied(bob.id)).toBe(false);
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    const started = performance.now();
    await test.facts.append('team-sales', 'team.member_removed',
      { teamId: 'sales', memberId: 'alice', removedBy: 'alice' });
    await closed;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(socket.destroyed).toBe(true);
  }
  expect(await test.gateway.tunnel(bearer, 'registry.npmjs.org:443', clientHello(),
    duringRelay)).toBe(200);
  expect(await closeObservation(test, bearer)).toMatchObject({ relay: { reason: 'revoked' } });
}
it('keeps Alice open while Bob removal awaits IAM, then closes on Alice removal',
  unrelatedTeamRemoval);

async function invalidDirectory(kind: string) {
  const test = await setup();
  await test.gateway.runtime.close();
  const directory = join(test.gateway.directory, 'egress');
  const original = join(test.gateway.directory, 'original');
  await rename(directory, original);
  if (kind === 'symlink') {
    await symlink(original, directory);
  } else {
    await writeFile(directory, 'private-path-canary', { mode: 0o700 });
  }
  await expect(startEgress(test.facts.nats.store, 'test', test.gateway.directory,
    refusedDirectory)).rejects.toThrow(/^egress_directory_refused$/u);
}
it.each(['symlink', 'file'])('refuses an evidence directory that is a %s with fixed text',
  invalidDirectory);

async function invalidRecoveredBinding(field: string) {
  const test = await setup();
  const bearer = await test.token();
  expect(await test.tunnel(bearer)).toBe(200);
  await closeObservation(test, bearer);
  await test.gateway.runtime.close();
  const directory = join(test.gateway.directory, 'egress');
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  const file = join(directory, files[0]!);
  const raw: unknown = JSON.parse(await readFile(file, 'utf8'));
  const record = z.object({ data: z.record(z.string(), z.unknown()) }).passthrough().parse(raw);
  if (field === 'requestId') {
    record.data['requestId'] = 'other-request';
    record['subject'] = 'egress-other-request';
  } else {
    record.data['channel'] = 'desktop';
  }
  expect(parseEventByType(record).success).toBe(true);
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  await expect(recoverEgressReceipt(test.facts.nats.store, 'test', directory, files[0]!))
    .rejects.toThrow(/^egress_receipt_refused$/u);
  expect(await readFile(file, 'utf8')).toBe(bytes);
  const rows = await history(test.facts.nats.store, `egress-${decodeJwt(bearer).jti!}`, 'test');
  expect(rows).toHaveLength(1);
}
it.each(['requestId', 'channel'])('refuses and keeps recovered evidence with a changed %s',
  invalidRecoveredBinding);

async function separateReceipts() {
  const test = await setup();
  const first = await test.token();
  const second = await test.token();
  const firstOpen = Promise.withResolvers<void>();
  const secondOpen = Promise.withResolvers<void>();
  async function firstRelay(socket: import('node:net').Socket) {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    firstOpen.resolve();
    await closed;
  }
  async function secondRelay(socket: import('node:net').Socket) {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    secondOpen.resolve();
    await closed;
  }
  const firstTunnel = test.gateway.tunnel(first, 'registry.npmjs.org:443', clientHello(), firstRelay);
  await firstOpen.promise;
  const secondTunnel = test.gateway.tunnel(second, 'registry.npmjs.org:443', clientHello(), secondRelay);
  await secondOpen.promise;
  expect(test.gateway.activeConnections()).toBe(2);
  await test.gateway.runtime.close();
  expect(await Promise.all([firstTunnel, secondTunnel])).toEqual([200, 200]);
  await test.gateway.runtime.flush();
  for (const bearer of [first, second]) {
    const permitId = decodeJwt(bearer).jti!;
    const rows = await history(test.facts.nats.store, `egress-${permitId}`, 'test');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.data).toMatchObject({ requestId: permitId, permitId,
      channel: 'command', relay: { permitId, reason: 'unavailable' } });
  }
}
it('saves a separate receipt for each of two open permits', separateReceipts);
