import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { parseEventByType } from '@opencrane/events';
import { memoryKeys, memoryScopeId, memoryIdentity } from '../src/index.ts';

const identity = {
  silo: 'test', scopeKind: 'person' as const, ownerId: 'alice', memoryId: 'fact', revision: 1,
  scopeId: 'pending',
};
function currentIdentity() {
  return { ...identity, scopeId: memoryScopeId('test', 'person', 'alice') };
}
function fixtureEvent(ciphertext: string, keyId: string) {
  const current = currentIdentity();
  return {
    id: 'event', type: 'memory.written', commandId: 'command', source: 'test', silo: 'test',
    time: '2026-10-08T00:00:00Z', principal: { kind: 'human' as const, id: 'alice' },
    subject: `scope-${current.scopeId}`, correlation: {},
    data: { scopeId: current.scopeId, scopeKind: current.scopeKind, ownerId: current.ownerId,
      memoryId: current.memoryId, revision: 1, schemaVersion: 1, kind: 'fact', pinned: false,
      expiresAt: null, sources: [], dependsOn: [], ciphertext, keyId },
  };
}
function withKeys(test: (keys: ReturnType<typeof memoryKeys>, directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'memory-keys-'));
  try {
    test(memoryKeys(directory), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function limits() {
  function check(keys: ReturnType<typeof memoryKeys>) {
    const current = currentIdentity();
    keys.provision(current);
    const text = '🦀'.repeat(1024);
    const encrypted = keys.encrypt(current, text);
    expect(keys.decrypt(current, encrypted)).toBe(text);
    expect(encrypted.ciphertext.length).toBe(5500);
    const leadingBom = keys.encrypt(current, '\ufeffhello');
    expect(keys.decrypt(current, leadingBom)).toBe('\ufeffhello');
    function oversized() {
      keys.encrypt(current, `${text}a`);
    }
    function empty() {
      keys.encrypt(current, '');
    }
    function nul() {
      keys.encrypt(current, 'a\0b');
    }
    function surrogate() {
      keys.encrypt(current, '\ud800');
    }
    expect(oversized).toThrow();
    expect(empty).toThrow();
    expect(nul).toThrow();
    expect(surrogate).toThrow();
    const event = fixtureEvent(encrypted.ciphertext, encrypted.keyId);
    expect(parseEventByType(event).success).toBe(true);
    const source = { memberId: 'alice', commandId: 'source' };
    const dependency = { scopeId: current.scopeId, memoryId: 'parent', revision: 1 };
    const patches = [
      { sources: Array(9).fill(source) }, { dependsOn: Array(33).fill(dependency) },
      { ownerId: 'a'.repeat(201) }, { ownerId: 'é' }, { revision: 2 },
      { dependsOn: [{ ...dependency, revision: Number.MAX_SAFE_INTEGER + 1 }] },
      { expiresAt: event.time }, { schemaVersion: 2 },
    ];
    for (const patch of patches) {
      const invalid = { ...event, data: { ...event.data, ...patch } };
      expect(parseEventByType(invalid).success).toBe(false);
    }
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    const atLimit = { ...event, source: `test${'a'.repeat(16384 - eventBytes)}` };
    expect(parseEventByType(atLimit).success).toBe(true);
    const padded = { ...atLimit, source: `${atLimit.source}a` };
    expect(parseEventByType(padded).success).toBe(false);
    const foreign = { ...event, silo: 'other' };
    function wrongScope() {
      memoryIdentity(foreign);
    }
    expect(wrongScope).toThrow();
    const preference = { ...event, data: { ...event.data, scopeKind: 'group', kind: 'preference' } };
    expect(parseEventByType(preference).success).toBe(false);
  }
  withKeys(check);
}
it('enforces UTF-8 text and whole-event limits before storage', limits);

function isolation() {
  function check(keys: ReturnType<typeof memoryKeys>, directory: string) {
    const current = currentIdentity();
    keys.provision(current);
    const encrypted = keys.encrypt(current, 'Delivery instructions');
    const originalKey = readFileSync(join(directory, encrypted.keyId.slice(4)));
    const alternatives = [
      { ...current, memoryId: 'other' }, { ...current, revision: 2 },
      { ...current, ownerId: 'bob', scopeId: memoryScopeId('test', 'person', 'bob') },
      { ...current, silo: 'other', scopeId: memoryScopeId('other', 'person', 'alice') },
    ];
    for (const alternative of alternatives) {
      const keyId = keys.provision(alternative);
      // Use identical key bytes to prove that authenticated identity itself blocks the move.
      writeFileSync(join(directory, keyId.slice(4)), originalKey);
      function moved() {
        keys.decrypt(alternative, { ...encrypted, keyId });
      }
      expect(moved).toThrow();
    }
    expect(keys.provision(current)).toBe(encrypted.keyId);
    expect(keys.decrypt(current, encrypted)).toBe('Delivery instructions');
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(directory, encrypted.keyId.slice(4))).mode & 0o777).toBe(0o600);
  }
  withKeys(check);
}
it('authenticates silo, scope, fact and revision even with the same key bytes', isolation);

function destruction() {
  function check(keys: ReturnType<typeof memoryKeys>, directory: string) {
    const current = currentIdentity();
    const second = { ...current, revision: 2 };
    keys.provision(current);
    const encrypted = keys.encrypt(current, 'first');
    keys.provision(second);
    const neighbour = keys.encrypt(second, 'second');
    const abandoned = join(directory, `${encrypted.keyId.slice(4)}-pending-crashed`);
    writeFileSync(abandoned, readFileSync(join(directory, encrypted.keyId.slice(4))));
    keys.delete(current);
    function abandonedKey() {
      readFileSync(abandoned);
    }
    expect(abandonedKey).toThrow();
    keys.delete(current);
    const reopened = memoryKeys(directory);
    expect(reopened.decrypt(current, encrypted)).toBeNull();
    function resurrect() {
      reopened.provision(current);
    }
    expect(resurrect).toThrow('destroyed');
    const script = `import { memoryKeys } from './libs/projections/src/index.ts';
      memoryKeys(process.argv[1]).provision(JSON.parse(process.argv[2]));`;
    const restarted = spawnSync(process.execPath, [
      '--experimental-strip-types', '--input-type=module', '-e', script,
      directory, JSON.stringify(current),
    ], { encoding: 'utf8' });
    expect(restarted.status).toBe(1);
    expect(restarted.stderr).toContain('Memory key destroyed');
    expect(reopened.decrypt(second, neighbour)).toBe('second');
    expect(readFileSync(join(directory, encrypted.keyId.slice(4)))).toHaveLength(0);
    const absentDirectory = join(directory, 'absent');
    expect(keys.decrypt(second, neighbour)).toBe('second');
    function missingStore() {
      memoryKeys(absentDirectory).decrypt(current, encrypted);
    }
    expect(missingStore).toThrow();
    writeFileSync(absentDirectory, 'not a directory');
    function unavailable() {
      memoryKeys(absentDirectory).decrypt(current, encrypted);
    }
    expect(unavailable).toThrow();
  }
  withKeys(check);
}
it('keeps deletion permanent after restart and distinguishes missing keys from store errors', destruction);

async function replay() {
  const nats = await natsFixture();
  const directory = mkdtempSync(join(tmpdir(), 'memory-replay-'));
  try {
    const keys = memoryKeys(directory);
    const current = currentIdentity();
    keys.provision(current);
    const encrypted = keys.encrypt(current, '日本語 deliveries');
    const event = fixtureEvent(encrypted.ciphertext, encrypted.keyId);
    expect((await nats.store.append({ event, expectedSequence: 0 })).status).toBe('appended');
    const oversized = { ...event, source: 'a'.repeat(16384) };
    expect((await nats.store.append({ event: oversized, expectedSequence: 1 })).status)
      .toBe('rejected');
    expect(await nats.reader.head()).toBe(1);
    keys.delete(current);
    const stored = [];
    for await (const row of nats.reader.readStream(event.subject)) {
      stored.push(row.event);
      expect(memoryIdentity(row.event)).toEqual(current);
      expect(keys.decrypt(current, encrypted)).toBeNull();
    }
    expect(stored).toHaveLength(1);
    expect(readFileSync(join(directory, encrypted.keyId.slice(4)))).toHaveLength(0);
    const legacy = { ...event, data: { scopeId: 'unknown', memoryId: 'fact', ...encrypted } };
    expect(parseEventByType(legacy).success).toBe(true);
    expect(memoryIdentity(legacy)).toBeNull();
    const legacyAppend = await nats.store.append({ event: legacy, expectedSequence: 1 });
    expect(legacyAppend.status).toBe('rejected');
    const historical = { ...legacy, id: 'legacy', commandId: 'legacy', subject: 'scope-unknown' };
    await nats.seed([historical]);
    for await (const row of nats.reader.readStream(historical.subject)) {
      expect(memoryIdentity(row.event)).toBeNull();
    }
  } finally {
    await nats.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
it('replays encrypted NATS events without provisioning and quarantines legacy ownership', replay);

function subjectMismatch() {
  const event = fixtureEvent('A'.repeat(40), 'key:' + 'a'.repeat(64));
  expect(parseEventByType(event).success).toBe(true);
  const invalid = { ...event, subject: 'scope-other' };
  expect(parseEventByType(invalid).success).toBe(false);
}
it('a memory subject must match its scope', subjectMismatch);

function foreignDependency() {
  const event = fixtureEvent('A'.repeat(40), 'key:' + 'a'.repeat(64));
  expect(parseEventByType(event).success).toBe(true);
  const dependency = { scopeId: 'b'.repeat(64), memoryId: 'parent', revision: 1 };
  const data = { ...event.data, dependsOn: [dependency] };
  const invalid = { ...event, data };
  expect(parseEventByType(invalid).success).toBe(false);
}
it('memory dependencies stay in their scope', foreignDependency);

function eventIdFormat() {
  const event = fixtureEvent('A'.repeat(40), 'key:' + 'a'.repeat(64));
  expect(parseEventByType(event).success).toBe(true);
  const invalid = { ...event, id: 'event:invalid' };
  expect(parseEventByType(invalid).success).toBe(false);
}
it('memory event ids use the allowed format', eventIdFormat);

function commandIdFormat() {
  const event = fixtureEvent('A'.repeat(40), 'key:' + 'a'.repeat(64));
  expect(parseEventByType(event).success).toBe(true);
  const invalid = { ...event, commandId: 'command:invalid' };
  expect(parseEventByType(invalid).success).toBe(false);
}
it('memory command ids use the allowed format', commandIdFormat);
