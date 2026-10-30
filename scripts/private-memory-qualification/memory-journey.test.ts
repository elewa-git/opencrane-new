import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { probeHost } from './host-probe.ts';
import { runJourney } from './journey.ts';
import { memoryAdmission } from '../../apps/server/src/chat/memory-admission.ts';

vi.mock('./host-probe.ts', { spy: true });
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
async function observesStore(name: string, role = 'command'): Promise<void> {
  const fixture = await natsFixture();
  const directory = await mkdtemp('.tools/memory-journey-');
  vi.stubEnv('MEMORY_KEY_DIRECTORY', directory);
  vi.mocked(probeHost).mockReturnValue(true);
  for (const [key, value] of Object.entries(fixture.env(role))) vi.stubEnv(key, value);
  vi.stubEnv('SILO_ID', 'test');
  try {
    const result = await runJourney(JSON.stringify({ ...request, name }));
    if (role === 'command') {
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
      expect(await fixture.store.head()).toBe(0);
    }
    expect(memoryAdmission.state).toBe('disabled');
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
}
it.each(['invalidation', 'unrelatedActivity', 'requesterIsolation', 'sessionIsolation'])(
  'executes %s on the configured event store without claiming live qualification', observesStore, 30_000);

async function failedJourney(): Promise<void> {
  vi.mocked(probeHost).mockReturnValue(true);
  vi.stubEnv('SILO_ID', 'test');
  vi.stubEnv('NATS_URL', '');
  const result = await runJourney(JSON.stringify({ ...request, name: 'invalidation' }));
  expect(result).toEqual({ result: 'FAIL', reason: 'journey_failed' });
}
it('refuses a journey that cannot execute without exposing connection settings', failedJourney);

async function deniedAppend(name: string): Promise<void> {
  await observesStore(name, 'projection');
}
it.each(['invalidation', 'requesterIsolation', 'sessionIsolation'])(
  'refuses when the measured store rejects %s', deniedAppend, 30_000);
