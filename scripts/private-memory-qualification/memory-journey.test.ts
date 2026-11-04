import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { probeHost } from './host-probe.ts';
import { runJourney } from './journey.ts';
import { stopInvalidatedMemory } from '../../apps/server/src/memory/stop.ts';
import { memoryAdmission } from '../../apps/server/src/chat/memory-admission.ts';

vi.mock('./host-probe.ts', { spy: true });
vi.mock('../../apps/server/src/memory/stop.ts', { spy: true });
afterEach(vi.restoreAllMocks);
afterEach(vi.unstubAllEnvs);

const request = {
  sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}`,
  environmentId: 'c'.repeat(64),
  siloId: `sha256:${createHash('sha256').update('test').digest('hex')}`,
  installationId: `sha256:${'e'.repeat(64)}`, freshInstall: true,
  runId: '11111111-1111-4111-8111-111111111111',
  challengeId: '22222222-2222-4222-8222-222222222222',
};
async function observesStore(name: string, role = 'command', silo = 'test', badStop = false): Promise<void> {
  const fixture = await natsFixture();
  const directory = await mkdtemp('.tools/memory-journey-');
  vi.stubEnv('MEMORY_KEY_DIRECTORY', directory);
  vi.mocked(probeHost).mockReturnValue(true);
  for (const [key, value] of Object.entries(fixture.env(role))) vi.stubEnv(key, value);
  vi.stubEnv('SILO_ID', silo);
  try {
    const result = await runJourney(JSON.stringify({ ...request, name }));
    if (role === 'command' && silo === 'test' && !badStop) {
      expect(result).toMatchObject({ ...request, name, result: 'PARTIAL', complete: false });
      const position = await fixture.store.head();
      const changes: string[] = [];
      for (let sequence = 1; sequence <= position; sequence += 1) {
        const row = await fixture.store.readEvent(sequence);
        if (['memory.corrected', 'memory.forgotten'].includes(row.event.type)) {
          changes.push(row.event.type);
        }
      }
      expect(changes).toEqual(['memory.corrected', 'memory.forgotten']);
    } else {
      expect(result).toEqual({ result: 'FAIL', reason: 'journey_failed' });
      if (!badStop) expect(await fixture.store.head()).toBe(0);
    }
    expect(memoryAdmission.state).toBe('disabled');
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function completedJourney(name: string) {
  await observesStore(name);
}
it.each(['invalidation', 'unrelatedActivity', 'requesterIsolation', 'sessionIsolation', 'stopReconnect'])(
  'executes %s on the configured event store without claiming live qualification',
  completedJourney, 30_000);

async function failedJourney(name: string): Promise<void> {
  vi.mocked(probeHost).mockReturnValue(true);
  vi.stubEnv('SILO_ID', 'test');
  vi.stubEnv('NATS_URL', '');
  const result = await runJourney(JSON.stringify({ ...request, name }));
  expect(result).toEqual({ result: 'FAIL', reason: 'journey_failed' });
}
it.each(['invalidation', 'stopReconnect'])(
  'refuses unavailable %s without exposing connection settings', failedJourney);

async function deniedAppend(name: string): Promise<void> {
  await observesStore(name, 'projection');
}
it.each(['invalidation', 'requesterIsolation', 'sessionIsolation', 'stopReconnect'])(
  'refuses when the measured store rejects %s', deniedAppend, 30_000);

async function wrongSilo(name: string): Promise<void> {
  await observesStore(name, 'command', 'foreign');
}
it.each(['requesterIsolation', 'sessionIsolation', 'stopReconnect'])(
  'refuses %s before writes when the configured silo differs', wrongSilo, 30_000);

async function privateFailure() {
  vi.mocked(stopInvalidatedMemory).mockRejectedValue(new Error('private-fixture-error'));
  await observesStore('stopReconnect', 'command', 'test', true);
}
it('returns only the fixed failure when a Stop assertion throws', privateFailure, 30_000);
