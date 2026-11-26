import { afterEach, expect, test, vi } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchLatestScannerApproval } from '../infra/clamav/approval.mjs';
import { scannerApprovalFixture } from '../infra/clamav/approval-fixture.mjs';
import { publishPackageImage } from '../infra/package/publish-package-image.mjs';
import { refreshScanner } from '../infra/package/scanner-refresh.mjs';

vi.mock('../infra/clamav/approval.mjs', mockApproval);
vi.mock('../infra/package/publish-package-image.mjs', mockPublisher);

function mockApproval() {
  return { fetchLatestScannerApproval: vi.fn() };
}

function mockPublisher() {
  return { publishPackageImage: vi.fn() };
}

function clearTestState() {
  vi.useRealTimers();
  vi.resetAllMocks();
}
afterEach(clearTestState);

const prefix = 'k3d-ocn-registry:5000/opencrane/scanner@sha256:';
const newRelease = { image: `${prefix}${'a'.repeat(64)}`, approvedSha: 'b'.repeat(64), runId: 42 };

async function wrongImageRefusesBeforeChangingScanner() {
  vi.mocked(fetchLatestScannerApproval).mockResolvedValue(newRelease);
  const kubectl = vi.fn();
  const wrongImage = `${prefix}${'c'.repeat(64)}`;
  await expect(refreshScanner(kubectl, wrongImage)).rejects.toThrow(/image.*does not match/iu);
  expect(publishPackageImage).not.toHaveBeenCalled();
  expect(kubectl).not.toHaveBeenCalled();
}
test('refuses a supplied image that differs from CI before publishing or editing the install',
  wrongImageRefusesBeforeChangingScanner);

const runningImage = `${prefix}${'d'.repeat(64)}`;
const runningSha = 'e'.repeat(64);
const approvedFile = '/run/scanner-approval/approved-manifests';

function scannerEvidence() {
  const secret = 'scanner-secret';
  return { name: 'evidence-source', projected: { sources: [
    { secret: { name: secret, items: [{ key: 'trust.json', path: 'trust.json' }] } },
    { secret: { name: secret, items: [
      { key: 'signatures.json', path: 'signatures.json' },
      { key: 'release.json', path: 'release.json' },
    ] } },
  ] } };
}

function scannerPod() {
  const wrapper = { name: 'https', image: 'unchanged-sidecar', env: [
    { name: 'SCANNER_IMAGE', value: runningImage },
    { name: 'SCANNER_APPROVED_SHA', value: runningSha },
  ] };
  return {
    initContainers: [{ name: 'copy-evidence', image: 'unchanged-sidecar' },
      { name: 'copy-databases', image: runningImage }],
    containers: [{ name: 'engine', image: runningImage }, wrapper],
    volumes: [scannerEvidence()],
  };
}

function readyStatus(generation) {
  return { observedGeneration: generation, replicas: 1, updatedReplicas: 1,
    readyReplicas: 1, availableReplicas: 1 };
}

function runningScanner() {
  const status = readyStatus(1);
  const strategy = { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } };
  const spec = { replicas: 1, strategy, template: { spec: scannerPod() } };
  return { metadata: { uid: 'scanner-uid', generation: 1 }, status, spec };
}

function runningServer() {
  const mount = { name: 'scanner-approval', mountPath: '/run/scanner-approval', readOnly: true };
  const configMap = { name: 'scanner-config', items: [
    { key: 'approved-manifests', path: 'approved-manifests' },
  ] };
  const volume = { name: 'scanner-approval', configMap };
  const container = { name: 'server',
    env: [{ name: 'SCANNER_APPROVED_MANIFEST_FILE', value: approvedFile }], volumeMounts: [mount] };
  const spec = { containers: [container], volumes: [volume] };
  return { spec: { replicas: 1, template: { spec } } };
}

async function stageApprovedFixture(directory, image = newRelease.image) {
  const options = { images: { scanner: image } };
  const fixture = await scannerApprovalFixture(directory, options);
  const manifestPath = join(directory, 'signatures.json');
  const releasePath = join(directory, 'release.json');
  await writeFile(manifestPath, fixture.files['signatures.json']);
  await writeFile(releasePath, fixture.files['release.json']);
  const evidence = JSON.parse(fixture.files['release.json']);
  return { ...newRelease, image, manifestPath, releasePath, approvedSha: fixture.approval.approvedSha,
    databaseUpdatedAt: evidence.databaseUpdatedAt };
}

function readResource(fixture, args) {
  const [, resource, flag, output] = args;
  expect(args).toHaveLength(4);
  expect(flag).toBe('-o');
  if (resource === 'secret/scanner-secret') {
    expect(output).toBe(String.raw`jsonpath={.data.release\.json}`);
    return Buffer.from(JSON.stringify(fixture.runningRelease)).toString('base64');
  }
  const resources = {
    'deployment/scanner': fixture.scanner,
    'deployment/server': fixture.server,
    'configmap/scanner-config': fixture.config,
  };
  expect(output).toBe('json');
  expect(resources).toHaveProperty(resource);
  return JSON.stringify(resources[resource]);
}

function patchApproval(config, operations) {
  expect(operations).toEqual([
    { op: 'test', path: '/metadata/resourceVersion', value: config.metadata.resourceVersion },
    { op: 'replace', path: '/data', value: expect.any(Object) },
  ]);
  config.data = operations[1].value;
  config.metadata.resourceVersion = String(Number(config.metadata.resourceVersion) + 1);
}

function patchTemplate(fixture, operations) {
  const { scanner, clusterState } = fixture;
  expect(operations).toEqual([
    { op: 'test', path: '/metadata/uid', value: scanner.metadata.uid },
    { op: 'test', path: '/metadata/generation', value: scanner.metadata.generation },
    { op: 'test', path: '/spec/template', value: scanner.spec.template },
    { op: 'replace', path: '/spec/template', value: expect.any(Object) },
  ]);
  if (clusterState.refusePatch) {
    throw new Error('Kubernetes refused the patch');
  }
  scanner.spec.template = operations[3].value;
  scanner.metadata.generation++;
  scanner.status.replicas = 2;
  if (clusterState.interruptAfterPatch) {
    clusterState.offline = true;
    throw new Error('The command stopped after Kubernetes saved the patch');
  }
}

function patchResource(fixture, args) {
  const [, resource, patchType, flag, body] = args;
  expect(args).toHaveLength(5);
  expect(patchType).toBe('--type=json');
  expect(flag).toBe('--patch');
  const operations = JSON.parse(body);
  fixture.patches.push(resource);
  if (resource === 'configmap/scanner-config') {
    patchApproval(fixture.config, operations);
  } else {
    expect(resource).toBe('deployment/scanner');
    patchTemplate(fixture, operations);
  }
  return '';
}

function scannerRollout(fixture, args) {
  expect(args).toEqual(['rollout', 'status', 'deployment/scanner', '--timeout=180s']);
  const { scanner, clusterState } = fixture;
  clusterState.onRollout?.(fixture);
  const image = scanner.spec.template.spec.containers[0].image;
  if (clusterState.failedImage === image || clusterState.failAllRollouts) {
    throw new Error('Scanner did not become ready');
  }
  scanner.status = readyStatus(scanner.metadata.generation);
  return '';
}

function projectApproval(fixture, args) {
  expect(args).toEqual(['--request-timeout=10s', 'exec', 'deployment/server', '-c', 'server',
    '--', 'cat', approvedFile]);
  fixture.clusterState.onProject?.(fixture);
  return fixture.config.data['approved-manifests'];
}

function cluster() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const clusterState = {};
  const scanner = runningScanner();
  const initialTemplate = structuredClone(scanner.spec.template);
  const server = runningServer();
  const data = { 'approved-manifests': `sha256:${runningSha}\n`,
    'package.conf': 'unchanged scanner settings' };
  const config = { metadata: { resourceVersion: '1' }, data };
  const initialApproval = structuredClone(data);
  const runningRelease = { imageDigest: runningImage.split('@')[1],
    manifestDigest: `sha256:${runningSha}`, databaseUpdatedAt: new Date(Date.now() - 3600000) };
  const patches = [];
  const fixture = { scanner, server, initialTemplate, config, initialApproval, runningRelease,
    patches, clusterState };
  function command(args) {
    if (clusterState.offline) {
      throw new Error('Kubernetes is unavailable');
    }
    switch (args[0]) {
      case 'get': return readResource(fixture, args);
      case 'patch': return patchResource(fixture, args);
      case 'rollout': return scannerRollout(fixture, args);
      default: return projectApproval(fixture, args);
    }
  }
  function approved(directory) {
    return stageApprovedFixture(directory, clusterState.approvedImage);
  }
  vi.mocked(fetchLatestScannerApproval).mockImplementation(approved);
  return { ...fixture, kubectl: vi.fn(command) };
}

async function updatedOnlyScanner() {
  const fixture = cluster();
  const result = await refreshScanner(fixture.kubectl, newRelease.image);
  expect(publishPackageImage).toHaveBeenCalledWith(expect.stringMatching(/\/scanner\.tar$/u),
    newRelease.image);
  expect(result).toMatchObject({ status: 'updated', image: newRelease.image, runId: 42 });
  expect(fixture.patches).toEqual([
    'configmap/scanner-config', 'deployment/scanner', 'configmap/scanner-config',
  ]);
  const current = fixture.scanner.spec.template.spec;
  const original = fixture.initialTemplate.spec;
  expect(current.initContainers[0]).toEqual(original.initContainers[0]);
  expect(current.initContainers[1].image).toBe(result.image);
  expect(current.containers[0].image).toBe(result.image);
  expect(current.containers[1].image).toBe(original.containers[1].image);
  expect(current.containers[1].env[0].value).toBe(result.image);
  expect(current.containers[1].env[1].value).toBe(result.sha);
  const sources = current.volumes[0].projected.sources;
  expect(sources[0]).toEqual(original.volumes[0].projected.sources[0]);
  expect(sources[1].configMap).toEqual({ name: 'scanner-config', items: [
    { key: `signatures-${result.sha}.json`, path: 'signatures.json' },
    { key: `release-${result.sha}.json`, path: 'release.json' },
  ] });
  expect(fixture.config.data['package.conf']).toBe('unchanged scanner settings');
  expect(fixture.config.data['approved-manifests']).toBe(`sha256:${result.sha}\n`);
}
test('publishes a verified image then changes only scanner and its approval data', updatedOnlyScanner);

async function failedPublishLeavesInstallInPlace() {
  const fixture = cluster();
  function badArchive() {
    throw new Error('Archive bytes differ from the selected digest');
  }
  vi.mocked(publishPackageImage).mockImplementation(badArchive);
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow('Could not publish');
  expect(fixture.patches).toEqual([]);
  expect(fixture.scanner.spec.template).toEqual(fixture.initialTemplate);
}
test('keeps the entire install in place if the registry cannot publish the checked image',
  failedPublishLeavesInstallInPlace);

async function restoresPreviousPinsOnFailedRollout() {
  const fixture = cluster();
  fixture.clusterState.failedImage = newRelease.image;
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow('previous pins were restored');
  expect(fixture.patches).toEqual([
    'configmap/scanner-config', 'deployment/scanner', 'deployment/scanner', 'configmap/scanner-config',
  ]);
  expect(fixture.scanner.spec.template).toEqual(fixture.initialTemplate);
  expect(fixture.scanner.status).toEqual(readyStatus(fixture.scanner.metadata.generation));
  expect(fixture.config.data).toEqual(fixture.initialApproval);
}
test('restores the previous scanner pins if the replacement never becomes ready',
  restoresPreviousPinsOnFailedRollout);

async function finishedRefreshCanRunAgain() {
  vi.setSystemTime(new Date());
  const fixture = cluster();
  const first = await refreshScanner(fixture.kubectl);
  const repeat = await refreshScanner(fixture.kubectl);
  expect(repeat).toMatchObject({ status: 'current', sha: first.sha });
  expect(publishPackageImage).toHaveBeenCalledOnce();
  expect(fixture.patches).toHaveLength(3);
}
test('running the same approval again verifies readiness without republishing',
  finishedRefreshCanRunAgain);

async function interruptAfterPatch(fixture) {
  fixture.clusterState.interruptAfterPatch = true;
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow();
  expect(fixture.scanner.spec.template.spec.containers[0].image).toBe(newRelease.image);
  expect(fixture.scanner.status.replicas).toBe(2);
  fixture.clusterState.interruptAfterPatch = false;
  fixture.clusterState.offline = false;
}

async function resumesAnInterruptedReadyRollout() {
  const fixture = cluster();
  await interruptAfterPatch(fixture);
  const result = await refreshScanner(fixture.kubectl);
  expect(result).toMatchObject({ status: 'updated', image: newRelease.image });
  expect(fixture.config.data['approved-manifests']).toBe(`sha256:${result.sha}\n`);
  expect(fixture.scanner.status).toEqual(readyStatus(fixture.scanner.metadata.generation));
  expect(publishPackageImage).toHaveBeenCalledOnce();
}
test('finishes a saved rollout after the original command is interrupted',
  resumesAnInterruptedReadyRollout);

async function rollsBackAnInterruptedFailedRollout() {
  const fixture = cluster();
  await interruptAfterPatch(fixture);
  fixture.clusterState.failedImage = newRelease.image;
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow('previous pins were restored');
  expect(fixture.scanner.spec.template).toEqual(fixture.initialTemplate);
  expect(fixture.scanner.status).toEqual(readyStatus(fixture.scanner.metadata.generation));
  expect(fixture.config.data).toEqual(fixture.initialApproval);
}
test('restores the old ready scanner and its exact approval after an interrupted failed rollout',
  rollsBackAnInterruptedFailedRollout);

async function updatesAfterInterruptedFailure() {
  const fixture = cluster();
  await interruptAfterPatch(fixture);
  fixture.clusterState.failedImage = newRelease.image;
  const laterImage = `${prefix}${'c'.repeat(64)}`;
  fixture.clusterState.approvedImage = laterImage;
  vi.setSystemTime(Date.now() + 60_000);
  const result = await refreshScanner(fixture.kubectl);
  expect(result).toMatchObject({ status: 'updated', image: laterImage });
  expect(fixture.scanner.spec.template.spec.containers[0].image).toBe(laterImage);
  expect(fixture.scanner.status).toEqual(readyStatus(fixture.scanner.metadata.generation));
  expect(fixture.config.data['approved-manifests']).toBe(`sha256:${result.sha}\n`);
}
test('a newer approval can replace a failed rollout after a restart', updatesAfterInterruptedFailure);

async function detectsSupersedingRollout() {
  const fixture = cluster();
  function operatorRollout(current) {
    current.clusterState.onRollout = undefined;
    current.scanner.metadata.generation++;
    const serving = structuredClone(current.initialTemplate);
    serving.metadata = { annotations: { 'operator-change': 'new rollout' } };
    current.scanner.spec.template = serving;
  }
  fixture.clusterState.onRollout = operatorRollout;
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow(/scanner.*changed during/iu);
  expect(fixture.scanner.spec.template.metadata.annotations['operator-change']).toBe('new rollout');
  expect(fixture.scanner.status).toEqual(readyStatus(fixture.scanner.metadata.generation));
  expect(fixture.config.data['approved-manifests']).toContain(`sha256:${runningSha}\n`);
  expect(fixture.patches).toEqual(['configmap/scanner-config', 'deployment/scanner']);
}
test('a ready superseding rollout keeps its serving approval and refuses the refresh',
  detectsSupersedingRollout);

async function refusesOlderApprovalWithoutReadyScanner() {
  const fixture = cluster();
  fixture.runningRelease.databaseUpdatedAt = new Date(Date.now());
  fixture.clusterState.failAllRollouts = true;
  fixture.scanner.status.readyReplicas = 0;
  fixture.scanner.status.availableReplicas = 0;
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow(/scanner.*ready/iu);
  expect(fixture.patches).toEqual([]);
  expect(fixture.scanner.spec.template).toEqual(fixture.initialTemplate);
  expect(fixture.config.data).toEqual(fixture.initialApproval);
}
test('refuses an older approval when there is no ready installed scanner',
  refusesOlderApprovalWithoutReadyScanner);

async function repeatReportsReadinessFailure() {
  const fixture = cluster();
  await refreshScanner(fixture.kubectl);
  fixture.clusterState.failAllRollouts = true;
  const inPlace = structuredClone(fixture.scanner.spec.template);
  const approved = structuredClone(fixture.config.data);
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow(/scanner.*ready/iu);
  expect(fixture.scanner.spec.template).toEqual(inPlace);
  expect(fixture.config.data).toEqual(approved);
  expect(fixture.patches).toHaveLength(3);
}
test('a repeat refresh reports readiness failure with the approval still in place',
  repeatReportsReadinessFailure);
