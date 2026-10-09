import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { grantStream } from '@opencrane/authz';
import { readDecisionGrants } from '../src/decision-grants.ts';
import { envelope } from '../src/actor.ts';

async function keepsOneHundredThousandGranteesWarm() {
  const modelId = 'gpt-6-luna';
  const subject = grantStream('model', modelId);
  const readPositions: number[] = [];
  const count = 100_000;
  function head() {
    return Promise.resolve(count);
  }
  async function* readStream(name: string, from = 1) {
    await setImmediate();
    expect(name).toBe(subject);
    readPositions.push(from);
    for (let sequence = from; sequence <= count; sequence++) {
      const grant = { resourceType: 'model', resourceId: modelId,
        granteeKind: 'member', granteeId: randomUUID(), grantedBy: 'alice' };
      const event = { id: randomUUID(), subject, type: 'grant.given', silo: 'test',
        source: 'models', time: '2026-10-09T00:00:00Z', correlation: {}, data: grant };
      yield { sequence, event };
    }
  }
  const store = { head, readStream };
  const cold = await readDecisionGrants(store, 'test', modelId, Infinity);
  expect(cold.rows).toHaveLength(count);
  const warm = await readDecisionGrants(store, 'test', modelId, performance.now() + 2000);
  expect(warm.rows).toHaveLength(count);
  expect(readPositions).toEqual([1, count + 1]);
  expect(warm.rows[0]?.event).toEqual(cold.rows[0]?.event);
  expect(warm.rows[0]?.event).not.toHaveProperty('principal');
  expect(warm.rows[0]?.event).not.toHaveProperty('correlation');
  expect(warm.rows[0]?.event.data).not.toHaveProperty('grantedBy');
}
it('keeps 100,000 UUID grantees within the retained grant budget',
  keepsOneHundredThousandGranteesWarm, 30_000);

const wrongResources = [
  { resourceType: 'model', resourceId: 'another-model' },
  { resourceType: 'mcp_server', resourceId: 'gpt-6-luna' },
];

async function refusesMismatchedResource(resource: (typeof wrongResources)[number]) {
  const modelId = 'gpt-6-luna';
  const subject = grantStream('model', modelId);
  function head() {
    return Promise.resolve(1);
  }
  async function* readStream() {
    await setImmediate();
    const grant = { ...resource, granteeId: 'alice', granteeKind: 'member', grantedBy: 'alice' };
    const event = envelope('test', subject, 'grant.given', grant);
    yield { sequence: 1, event };
  }
  const store = { head, readStream };
  await expect(readDecisionGrants(store, 'test', modelId, Infinity))
    .rejects.toThrow('Authority changed');
}
it.each(wrongResources)('refuses a $resourceType / $resourceId grant on a different model stream',
  refusesMismatchedResource);
