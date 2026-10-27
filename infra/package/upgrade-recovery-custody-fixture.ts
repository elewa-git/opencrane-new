import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import { event, natsFixture } from '@opencrane/event-store/testing';
import type { MemoryIdentity } from '@opencrane/events';
import * as projections from '@opencrane/projections';
import { recoveryHomes } from '../../apps/server/test/support/recovery-homes.ts';

type Nats = Awaited<ReturnType<typeof natsFixture>>;
const memoryKeys = projections.memoryKeys;

export async function recoveryCustody(source: Nats, directory: string, fault: string) {
  const current = await natsFixture();
  onTestFinished(current.close);
  const sourceDirectory = join(directory, 'current');
  const candidateDirectory = join(directory, 'candidate');
  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(candidateDirectory, { mode: 0o700 });
  const scopeId = projections.memoryScopeId('test', 'person', 'alice');
  const forgotten: MemoryIdentity = { silo: 'test', scopeId, scopeKind: 'person',
    ownerId: 'alice', memoryId: 'forgotten', revision: 1 };
  const store = memoryKeys(sourceDirectory);
  let forgottenReference = '';
  for (const memoryId of ['survivor', 'forgotten']) {
    const identity = { ...forgotten, memoryId };
    const reference = store.provision(identity).slice(4);
    if (memoryId === 'forgotten') {
      forgottenReference = reference;
    }
    const bytes = await readFile(join(sourceDirectory, reference));
    await writeFile(join(candidateDirectory, reference), bytes, { mode: 0o600 });
    bytes.fill(0);
    const encrypted = store.encrypt(identity, `Synthetic ${memoryId}`);
    const data = { schemaVersion: 1, scopeId, scopeKind: 'person', ownerId: 'alice',
      memoryId, revision: 1, kind: 'fact', pinned: false, expiresAt: null,
      sources: [{ memberId: 'alice', commandId: memoryId }], dependsOn: [], ...encrypted };
    const written = { ...event(memoryId), subject: `scope-${scopeId}`,
      type: 'memory.written', data };
    await source.seed([written]);
  }
  const names: string[] = [];
  if (fault === 'incomplete-homes') {
    names.push('retained');
  }
  const collectHomes = await recoveryHomes(source, names);
  const volumeDirectory = join(directory, 'homes');
  const memory = { source: current.connection, sourceDirectory, candidateDirectory };

  async function capture(eventDirectory: string, backupKeyFile: string) {
    const options = { eventDirectory, volumeDirectory, backupKeyFile,
      silo: 'test', attempt: 'before-upgrade' };
    const homes = await collectHomes(options);
    expect(homes.binding.volumes).toHaveLength(names.length);
    expect(homes.exports).toHaveLength(names.length);
    if (fault === 'incomplete-homes') {
      for (const entry of homes.exports) {
        await rm(join(volumeDirectory, entry.file));
      }
      homes.binding.volumes = [];
      homes.exports = [];
      await writeFile(join(volumeDirectory, 'descriptor.json'), JSON.stringify(homes));
    }
    const archivedPosition = await source.reader.head();
    for (let sequence = 1; sequence <= archivedPosition; sequence++) {
      const stored = await source.reader.readEvent(sequence);
      await current.seed([stored.event]);
    }
    const { silo: _silo, ...fields } = forgotten;
    const data = { schemaVersion: 1, ...fields, expectedRevision: 1, revision: 2 };
    const removed = { ...event('forget-after-backup'), subject: `scope-${scopeId}`,
      type: 'memory.forgotten', data };
    await current.seed([removed]);
    for (const path of [sourceDirectory, candidateDirectory]) {
      const keys = memoryKeys(path);
      keys.delete(forgotten);
      const next = { ...forgotten, revision: 2 };
      keys.provision(next);
      keys.delete(next);
    }
    expect(await current.reader.head()).toBe(archivedPosition + 1);
    expect(await source.reader.head()).toBe(archivedPosition);
    if (fault === 'missing-custody') {
      await rm(candidateDirectory, { recursive: true });
    }
    if (fault === 'resurrected') {
      // Keep the folders identical so the current deletion event must cause refusal.
      for (const path of [sourceDirectory, candidateDirectory]) {
        await writeFile(join(path, forgottenReference), Buffer.alloc(32, 7));
      }
    }
    if (fault === 'inventory') {
      function changedKeys(path: string) {
        const keys = memoryKeys(path);
        function status(identity: MemoryIdentity) {
          const result = keys.status(identity);
          writeFileSync(join(candidateDirectory, 'f'.repeat(64)), Buffer.alloc(0),
            { mode: 0o600 });
          return result;
        }
        return { ...keys, status };
      }
      vi.spyOn(projections, 'memoryKeys').mockImplementation(changedKeys);
    }
  }
  function expectDeleted() {
    expect(memoryKeys(sourceDirectory).status(forgotten)).toBe('destroyed');
    expect(memoryKeys(candidateDirectory).status(forgotten)).toBe('destroyed');
  }
  return { capture, memory, volumeDirectory, expectDeleted };
}
