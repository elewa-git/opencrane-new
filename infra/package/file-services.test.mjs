import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseAllDocuments } from 'yaml';

function packageFilesRunInsideInstallation() {
  const images = {};
  const secrets = {};
  for (const role of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer']) {
    images[role] = `example.invalid/${role}@sha256:${'a'.repeat(64)}`;
  }
  for (const role of ['runtime', 'runtimeFiles', 'postgres', 'nats', 'openfga', 'bootstrap']) {
    secrets[role] = `test-${role.toLowerCase()}`;
  }
  const values = { images, secrets };
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
  }
  const service = resources.get('Service/scanner');
  assert.equal(service.spec.type, 'ClusterIP');
  assert.deepEqual(service.spec.ports, [{ port: 8443, targetPort: 8443 }]);
  const policy = resources.get('NetworkPolicy/scanner');
  assert.ok(policy, 'Only the authenticated wrapper may be reached outside its Pod');
  assert.deepEqual(policy.spec.ingress[0].ports, [{ protocol: 'TCP', port: 8443 }]);
}

test('packaged uploads have persistent storage and a private authenticated scanner',
  packageFilesRunInsideInstallation);
