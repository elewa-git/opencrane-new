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

function runningScanner() {
  const status = { observedGeneration: 1, replicas: 1, updatedReplicas: 1 };
  return { metadata: { uid: 'scanner-uid', generation: 1 }, status, spec: {
    replicas: 1, strategy: { type: 'RollingUpdate', rollingUpdate: {
      maxSurge: 1, maxUnavailable: 0,
    } }, template: { spec: {
      initContainers: [{ name: 'copy-evidence', image: 'unchanged-sidecar' },
        { name: 'copy-databases', image: runningImage }],
      containers: [{ name: 'engine', image: runningImage }, {
        name: 'https', image: 'unchanged-sidecar', env: [
          { name: 'SCANNER_IMAGE', value: runningImage },
          { name: 'SCANNER_APPROVED_SHA', value: runningSha },
        ],
      }],
      volumes: [{ name: 'evidence-source', projected: { sources: [
        { secret: { name: 'scanner-secret', items: [{ key: 'trust.json' }] } },
        { secret: { name: 'scanner-secret', items: [{ key: 'release.json' }] } },
      ] } }],
    } },
  } };
}

function runningServer() {
  return { spec: { replicas: 1, template: { spec: { containers: [{ name: 'server',
    env: [{ name: 'SCANNER_APPROVED_MANIFEST_FILE', value: approvedFile }],
    volumeMounts: [{ name: 'scanner-approval', mountPath: '/run/scanner-approval', readOnly: true }],
  }], volumes: [{ name: 'scanner-approval', configMap: { name: 'scanner-config' } }] } } } };
}

async function stageApprovedFixture(directory) {
  const fixture = await scannerApprovalFixture(directory, { images: { scanner: newRelease.image } });
  const manifestPath = join(directory, 'signatures.json');
  const releasePath = join(directory, 'release.json');
  await writeFile(manifestPath, fixture.files['signatures.json']);
  await writeFile(releasePath, fixture.files['release.json']);
  const evidence = JSON.parse(fixture.files['release.json']);
  return { ...newRelease, manifestPath, releasePath, approvedSha: fixture.approval.approvedSha,
    databaseUpdatedAt: evidence.databaseUpdatedAt };
}

function cluster() {
  vi.mocked(fetchLatestScannerApproval).mockImplementation(stageApprovedFixture);
  const scanner = runningScanner();
  const initialTemplate = structuredClone(scanner.spec.template);
  const server = runningServer();
  const approval = `sha256:${runningSha}\n`;
  const config = { metadata: { resourceVersion: '1' }, data: {
    'approved-manifests': approval, 'package.conf': 'unchanged scanner settings',
  } };
  const runningRelease = { imageDigest: runningImage.split('@')[1],
    manifestDigest: `sha256:${runningSha}`, databaseUpdatedAt: new Date(Date.now() - 3600000) };
  const patches = [];
  const clusterState = { failRollout: false };
  async function command(args) {
    const [verb, resource] = args;
    if (verb === 'get') return readResource(resource, args[3]);
    if (verb === '--request-timeout=10s') return config.data['approved-manifests'];
    if (verb === 'rollout') {
      if (clusterState.failRollout) throw new Error('Scanner did not become ready');
      expect(args[2]).toBe('deployment/scanner');
      scanner.status.observedGeneration = scanner.metadata.generation;
      return '';
    }
    expect(verb).toBe('patch');
    const operations = JSON.parse(args[4]);
    patches.push(resource);
    if (resource === 'configmap/scanner-config') {
      expect(operations[0].value).toBe(config.metadata.resourceVersion);
      config.data = operations[1].value;
    } else {
      expect(resource).toBe('deployment/scanner');
      expect(publishPackageImage).toHaveBeenCalledOnce();
      expect(operations[0].value).toBe(scanner.metadata.uid);
      expect(operations[1].value).toBe(scanner.metadata.generation);
      expect(operations[2].value).toEqual(scanner.spec.template);
      scanner.spec.template = operations[3].value;
      scanner.metadata.generation++;
    }
    return '';
  }
  function readResource(resource, output) {
    if (resource === 'deployment/scanner') return JSON.stringify(scanner);
    if (resource === 'deployment/server') return JSON.stringify(server);
    if (resource === 'configmap/scanner-config') return JSON.stringify(config);
    expect(resource).toBe('secret/scanner-secret');
    const data = { 'release.json': Buffer.from(JSON.stringify(runningRelease)).toString('base64') };
    if (output === String.raw`jsonpath={.data.release\.json}`) return data['release.json'];
    return '';
  }
  const kubectl = vi.fn(command);
  return { kubectl, scanner, initialTemplate, config, patches, clusterState };
}

async function updatedOnlyScanner() {
  const fixture = cluster();
  const result = await refreshScanner(fixture.kubectl, newRelease.image);
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
  expect(sources[1].configMap.items[0].key).toBe(`signatures-${result.sha}.json`);
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
  fixture.clusterState.failRollout = true;
  await expect(refreshScanner(fixture.kubectl)).rejects.toThrow('previous pins were restored');
  expect(fixture.patches).toEqual([
    'configmap/scanner-config', 'deployment/scanner', 'deployment/scanner',
  ]);
  expect(fixture.scanner.spec.template).toEqual(fixture.initialTemplate);
  expect(fixture.config.data['approved-manifests']).toContain(`sha256:${runningSha}\n`);
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
