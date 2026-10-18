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
async function setup(missing?: string, problem = 'missing') {
  const facts = await fixture();
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

async function refusesFailedRegistration() {
  const test = await setup();
  function unavailableRelay(): Promise<string> {
    return Promise.reject(new Error('private-canary'));
  }
  const registration = vi.spyOn(test.gateway.registry, 'register');
  registration.mockImplementation(unavailableRelay);
  onTestFinished(registration.mockRestore.bind(registration));
  expect(await test.tunnel(await test.token())).toBe(403);
  expect(test.gateway.connected()).toBe(0);
  expect(test.facts.actor.state.dispatches).toHaveLength(1);
}
it('opens no connection when admitted relay registration fails', refusesFailedRegistration);

async function changesDuringDispatchRetry(change: string) {
  const test = await setup();
  const bearer = await test.token();
  const requestId = decodeJwt(bearer).jti!;
  const retry = await failingPublishStore(test.facts.nats.connection);
  const append = test.facts.nats.store.append.bind(test.facts.nats.store);
  const registration = vi.spyOn(test.gateway.registry, 'register');
  onTestFinished(registration.mockRestore.bind(registration));

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
      const now = performance.now.bind(performance);
      function afterDeadline() {
        return now() + 2100;
      }
      const clock = vi.spyOn(performance, 'now').mockImplementation(afterDeadline);
      onTestFinished(clock.mockRestore.bind(clock));
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
  expect.soft(registration).not.toHaveBeenCalled();
  const outcomes = await history(test.facts.nats.store, `egress-${requestId}`, 'test');
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]!.event.type).toBe('egress.observed');
  expect(outcomes[0]!.event.data).toMatchObject({ requestId, permitId: requestId,
    channel: 'command', outcome: 'error' });
}
it.each(['destination', 'turn', 'deadline', 'expiry', 'none'])(
  'rechecks %s after the real budget dispatch append retries', changesDuringDispatchRetry);
