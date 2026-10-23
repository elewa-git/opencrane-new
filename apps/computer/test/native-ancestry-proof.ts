import assert from 'node:assert/strict';

type Context = {
  root: string; parent: string; parentTurn: string; generation: number;
  ended: boolean; boundThreads: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Check saved observations only. A JSON label cannot authenticate a live sender.
export function assertEarlyAncestry(value: unknown, context: Context) {
  const refusal = 'Early ancestry unproven';
  assert(isRecord(value), refusal);
  const observation = value;
  assert(observation['type'] === 'subAgentActivity', refusal);
  assert(observation['activity'] === 'started', refusal);
  assert(observation['source'] === 'app-server-stdio', refusal);
  assert(observation['method'] === 'item/started', refusal);
  for (const field of ['spawn', 'sender', 'receiver', 'parentTurn', 'readParent', 'root']) {
    const identifier = observation[field];
    assert(typeof identifier === 'string' && /^[a-zA-Z0-9_-]+$/u.test(identifier), refusal);
  }
  assert(observation['root'] === context.root, refusal);
  assert(observation['sender'] === context.parent, refusal);
  assert(observation['parentTurn'] === context.parentTurn, refusal);
  assert(observation['readParent'] === context.parent, refusal);
  assert(observation['generation'] === context.generation, refusal);
  assert(context.ended === false, refusal);
  const receiver = observation['receiver'];
  assert(typeof receiver === 'string', refusal);
  assert(receiver !== context.parent && !context.boundThreads.includes(receiver), refusal);
  for (const field of ['spawnOrder', 'readOrder', 'firstCallOrder']) {
    assert(Number.isSafeInteger(observation[field]) && Number(observation[field]) > 0, refusal);
  }
  assert(Number(observation['spawnOrder']) < Number(observation['firstCallOrder']), refusal);
  assert(Number(observation['readOrder']) < Number(observation['firstCallOrder']), refusal);
}
