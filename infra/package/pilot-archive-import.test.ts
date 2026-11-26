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
  const destination: ArchiveDestination = { namespace, namespaceUid, run };
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
    const extraction = fixture.calls.at(-1);
    assert.equal(extraction?.at(-1), 'archive.tar');
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

for (const missing of ['source cluster', 'source namespace', 'source namespace ID',
  'destination cluster', 'destination namespace', 'destination namespace ID']) {
  async function refusesIncompleteIdentity() {
    const exported = { ...source, namespaceUid: 'original-id' };
    const fixture = destinationFixture('recovery-cluster', 'recovery-namespace');
    if (missing === 'source cluster') exported.clusterUid = '';
    if (missing === 'source namespace') exported.namespace = '';
    if (missing === 'source namespace ID') exported.namespaceUid = '';
    if (missing === 'destination namespace') fixture.destination.namespace = '';
    if (missing === 'destination namespace ID') fixture.destination.namespaceUid = '';
    const destination = missing === 'destination cluster'
      ? destinationFixture('', 'recovery-namespace') : fixture;
    await assert.rejects(importPilotArchive(exported, destination.destination, 'archive.tar'),
      /source and destination identities/u);
    assert.equal(destination.calls.length, 1);
  }
  test(`archive import requires the ${missing}`, refusesIncompleteIdentity);
}

async function permitsIndependentCluster() {
  const fixture = destinationFixture('recovery-cluster', source.namespace, 'original-id');
  const exported = { ...source, namespaceUid: 'original-id' };
  await importPilotArchive(exported, fixture.destination, 'archive.tar');
  assert.equal(fixture.calls.length, 3);
}

test('matching namespace names and IDs can belong to separate clusters', permitsIndependentCluster);
