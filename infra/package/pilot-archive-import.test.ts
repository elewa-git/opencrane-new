import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importPilotArchive, type ArchiveDestination } from './pilot-archive-import.ts';

const source = { clusterUid: 'source-cluster', namespace: 'opencrane-package-1' };

function destinationFixture(clusterUid: string, namespace: string) {
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
  const destination: ArchiveDestination = { namespace, run };
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
