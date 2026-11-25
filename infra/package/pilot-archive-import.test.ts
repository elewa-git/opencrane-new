import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importPilotArchive, type ArchiveDestination } from './pilot-archive-import.ts';

const source = { clusterUid: 'source-cluster', namespace: 'opencrane-package-1' };

function destinationFixture(clusterUid: string, namespace: string, namespaceUid = 'target-id') {
  const calls: string[][] = [];
  async function run(args: string[], archive?: string): Promise<string> {
    const call = [...args];
    if (archive) {
      call.push(archive);
    }
    calls.push(call);
    if (args[0] === 'get') {
      return clusterUid;
    }
    return '';
  }
  const recorded = { namespace, namespaceUid, run };
  const destination: ArchiveDestination = recorded;
  return { calls, destination };
}

test('the source cluster and namespace match even when context names differ',
  async function refusesSource() {
    const fixture = destinationFixture(source.clusterUid, source.namespace);
    await assert.rejects(importPilotArchive(source, fixture.destination, 'archive.tar'),
      /source cluster and namespace/u);
    assert.deepEqual(fixture.calls, [['get', 'namespace', 'kube-system',
      '-o', 'jsonpath={.metadata.uid}']]);
  });

test('the archive may go into a fresh namespace that reuses the old name',
  async function importsAfterReinstall() {
    const fixture = destinationFixture(source.clusterUid, source.namespace);
    const exported = { ...source, namespaceUid: 'original-id' };
    await importPilotArchive(exported, fixture.destination, 'archive.tar');
    assert.equal(fixture.calls.at(-1)?.at(-1), 'archive.tar');
  });

test('the archive cannot go back into the namespace that produced it',
  async function refusesOriginalNamespace() {
    const namespaceUid = 'original-id';
    const fixture = destinationFixture(source.clusterUid, source.namespace, namespaceUid);
    const exported = { ...source, namespaceUid };
    await assert.rejects(importPilotArchive(exported, fixture.destination, 'archive.tar'),
      /source cluster and namespace/u);
    assert.equal(fixture.calls.length, 1);
  });

test('rollout and extraction both use the checked destination namespace',
  async function importsIntoDestination() {
    const namespace = 'opencrane-package-2';
    const fixture = destinationFixture(source.clusterUid, namespace);
    await importPilotArchive(source, fixture.destination, 'archive.tar');
    const [, rollout, extraction] = fixture.calls;
    assert.deepEqual(rollout, ['-n', namespace, 'rollout', 'status',
      'deployment/backup-catalogue', '--timeout=60s']);
    assert.deepEqual(extraction?.slice(0, 7),
      ['-n', namespace, 'exec', '-i', 'deployment/backup-catalogue', '--', 'sh']);
    assert.equal(extraction?.at(-1), 'archive.tar');
  });
