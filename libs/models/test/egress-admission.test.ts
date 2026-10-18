import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { egressGrantStream } from '@opencrane/projections';
import { fixture } from './fixture.ts';
import { egressFixture } from './egress-fixture.ts';
import { clientHello } from './egress-hello-fixture.ts';

const destination = { host: 'registry.npmjs.org', port: 443 };
async function setup() {
  const facts = await fixture();
  onTestFinished(facts.close);
  const positions: number[] = [];
  for (const [scope, subjectId] of [['silo', 'test'], ['person', 'alice'],
    ['assistant', 'assistant']] as const) {
    const rule = { ...destination, scope, subjectId };
    const subject = egressGrantStream('test', rule);
    const eventId = randomUUID();
    const event = { id: eventId, commandId: eventId, subject, silo: 'test',
      type: 'egress.destination_allowed', source: 'opencrane-server',
      time: new Date().toISOString(), principal: { kind: 'human' as const, id: 'alice' },
      correlation: {}, data: { ...rule, changedBy: 'alice', expectedSequence: 0 } };
    await facts.nats.store.append({ event, expectedSequence: 0 });
    positions.push(await facts.nats.store.head(subject));
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
}
it('admits one recorded zero-cost connection through the production decision route', admitsOnce);
