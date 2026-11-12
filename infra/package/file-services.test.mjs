import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseAllDocuments } from 'yaml';

function packageFilesRunInsideInstallation() {
  const images = {};
  const secrets = {};
  for (const role of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer', 'objects', 'scanner']) {
    images[role] = `example.invalid/${role}@sha256:${'a'.repeat(64)}`;
  }
  for (const role of ['runtime', 'runtimeFiles', 'postgres', 'nats', 'openfga', 'bootstrap', 'objects', 'scanner']) {
    secrets[role] = `test-${role.toLowerCase()}`;
  }
  const values = { images, secrets, scanner: { approvedSha: 'c'.repeat(64) } };
  const options = { encoding: 'utf8', input: JSON.stringify(values) };
  const result = spawnSync('helm', ['template', 'files', 'infra/package/chart', '-f', '-'],
    options);
  assert.equal(result.status, 0, result.stderr);
  const resources = new Map();
  for (const document of parseAllDocuments(result.stdout)) {
    const resource = document.toJS();
    resources.set(`${resource.kind}/${resource.metadata.name}`, resource);
  }
  const storage = resources.get('StatefulSet/objects');
  assert.ok(storage, 'The package must run its own persistent object store');
  assert.ok(storage.spec.volumeClaimTemplates.length > 0);
  const scanner = resources.get('Deployment/scanner');
  assert.ok(scanner, 'The package must run its own authenticated scanner');
  const pod = scanner.spec.template.spec;
  assert.equal(pod.containers.length, 2);
  for (const container of pod.containers) {
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.runAsUser, 1000,
      'Kubernetes must verify the engine user without resolving an image user name');
  }
  const evidence = pod.volumes.find(isEvidenceVolume);
  assert.deepEqual(evidence.emptyDir, { medium: 'Memory' },
    'Copy projected Secret symlinks into regular files before strict release validation');
  const evidenceCopy = pod.initContainers.find(isEvidenceCopy);
  assert.ok(evidenceCopy, 'The scanner must copy its release evidence before starting');
  assert.match(evidenceCopy.args[0], /cp \/run\/scanner-source\/\* \/run\/scanner\//);
  const service = resources.get('Service/scanner');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.deepEqual(service.spec.ports, [{ port: 8443, targetPort: 8443 }]);
  const policy = resources.get('NetworkPolicy/scanner');
  assert.ok(policy, 'Only the authenticated wrapper may be reached outside its Pod');
  assert.deepEqual(policy.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8443 }]);
}

function isEvidenceVolume(volume) {
  return volume.name === 'evidence';
}

function isEvidenceCopy(container) {
  return container.name === 'copy-evidence';
}

test('packaged uploads have persistent storage and a private authenticated scanner',
  packageFilesRunInsideInstallation);
