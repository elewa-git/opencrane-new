import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { parseAllDocuments } from 'yaml';
import { assertScannerFiles, isEvidenceSource, isServer } from './file-services-fixture.mjs';

function fileServiceValues() {
  const images = {};
  const secrets = {};
  for (const role of ['server', 'web', 'postgres', 'nats', 'openfga', 'computer', 'objects', 'scanner']) {
    images[role] = `example.invalid/${role}@sha256:${'a'.repeat(64)}`;
  }
  for (const role of ['runtime', 'runtimeFiles', 'postgres', 'nats', 'openfga', 'bootstrap', 'objects', 'scanner']) {
    secrets[role] = `test-${role.toLowerCase()}`;
  }
  return { images, secrets, scanner: { approvedSha: 'c'.repeat(64) } };
}

function renderFileServices() {
  const values = fileServiceValues();
  const options = { encoding: 'utf8', input: JSON.stringify(values) };
  const result = spawnSync('helm', ['template', 'files', 'infra/package/chart', '-f', '-'],
    options);
  assert.equal(result.status, 0, result.stderr);
  const resources = new Map();
  for (const document of parseAllDocuments(result.stdout)) {
    const resource = document.toJS();
    resources.set(`${resource.kind}/${resource.metadata.name}`, resource);
  }
  return resources;
}

function packageFilesRunInsideInstallation() {
  const resources = renderFileServices();
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

function packageAllowsScannerOnlyRollouts() {
  const resources = renderFileServices();
  const scanner = resources.get('Deployment/scanner');
  const strategy = {
    type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
  };
  assert.deepEqual(scanner.spec.strategy, strategy);
  const config = resources.get('ConfigMap/scanner-config');
  assert.equal(config.data['approved-manifests'].trim(), `sha256:${'c'.repeat(64)}`);
  const server = resources.get('Deployment/server').spec.template.spec;
  const application = server.containers.find(isServer);
  assert.ok(application.env.some(isApprovalFile));
  assert.ok(application.volumeMounts.some(isApprovalMount));
  const volume = server.volumes.find(isApprovalVolume);
  const approvalProjection = { name: 'scanner-config', items: [
    { key: 'approved-manifests', path: 'approved-manifests' },
  ] };
  assert.deepEqual(volume.configMap, approvalProjection);
  const source = scanner.spec.template.spec.volumes.find(isEvidenceSource);
  assertScannerFiles(source, 'test-scanner');
}

function isApprovalVolume(volume) {
  return volume.name === 'scanner-approval';
}

function isApprovalFile(variable) {
  return variable.name === 'SCANNER_APPROVED_MANIFEST_FILE' &&
    variable.value === '/run/scanner-approval/approved-manifests';
}

function isApprovalMount(mount) {
  return mount.name === 'scanner-approval' && mount.readOnly &&
    mount.mountPath === '/run/scanner-approval' && !mount.subPath && !mount.subPathExpr;
}

test('a scanner rollout keeps a ready replica and shares the checked manifest file',
  packageAllowsScannerOnlyRollouts);

function isEvidenceCopy(container) {
  return container.name === 'copy-evidence';
}

test('packaged uploads have persistent storage and a private authenticated scanner',
  packageFilesRunInsideInstallation);

function isEngine(container) {
  return container.name === 'engine';
}

function isConfiguration(mount) {
  return mount.name === 'config';
}

function scannerConfigurationPreservesTrust() {
  const resources = renderFileServices();
  const scanner = resources.get('Deployment/scanner');
  const engine = scanner.spec.template.spec.containers.find(isEngine);
  const mount = engine.volumeMounts.find(isConfiguration);
  assert.equal(mount.mountPath, '/etc/clamav/package.conf',
    'Keep the certificate directory from the reviewed scanner image visible');
  assert.equal(mount.subPath, 'package.conf');
}
test('scanner configuration keeps the bundled database verification certificates visible',
  scannerConfigurationPreservesTrust);
