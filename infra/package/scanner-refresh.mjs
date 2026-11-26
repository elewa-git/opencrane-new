import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createLogger } from '@opencrane/observability';
import { fetchLatestScannerApproval } from '../clamav/approval.mjs';
import { readApprovedRelease, readBoundedBytes } from '../clamav/release.mjs';
import { publishPackageImage } from './publish-package-image.mjs';

const logger = createLogger('scanner-refresh');
const approvalFile = 'approved-manifests';
const configMapName = 'scanner-config';
const configResource = `configmap/${configMapName}`;
const scannerResource = 'deployment/scanner';
const serverResource = 'deployment/server';
const mountPath = '/run/scanner-approval';
const approvalPath = `${mountPath}/${approvalFile}`;
const templatePath = '/spec/template';
const refreshMessages = {
  approval: 'Could not fetch a current scanner approval from GitHub main',
  image: 'Requested scanner image does not match the GitHub approval',
  install: 'The running package does not have the checked scanner refresh settings',
  busy: 'The previous scanner rollout is still in progress',
  publish: 'Could not publish the approved scanner image digest',
  settings: 'Could not update the scanner approval file',
  projection: 'The server did not receive the scanner approval file',
  expired: 'The scanner approval expired before the rollout',
  patch: 'Kubernetes did not confirm the scanner change',
  rollback: 'The scanner rollout failed and the previous pins could not be confirmed',
  rollout: 'The scanner rollout failed and the previous pins were restored',
  unchanged: 'Kubernetes refused the scanner change and kept the previous pins',
};

export class ScannerRefreshRefusal extends Error {
  constructor(reason, cause) {
    super(`Scanner refresh refused. ${refreshMessages[reason]}.`, { cause });
    this.reason = reason;
  }
}

function requireSettings(condition) {
  if (!condition) throw new ScannerRefreshRefusal('install');
}

function named(items, name) {
  function matches(item) {
    return item.name === name;
  }
  const found = items?.find(matches);
  requireSettings(found);
  return found;
}

function getApprovalPath(deployment) {
  const pod = deployment.spec.template.spec;
  const server = named(pod.containers, 'server');
  const path = named(server.env, 'SCANNER_APPROVED_MANIFEST_FILE');
  const mount = named(server.volumeMounts, 'scanner-approval');
  const config = named(pod.volumes, 'scanner-approval').configMap;
  requireSettings(path.value === approvalPath && mount.mountPath === mountPath &&
    mount.readOnly === true && !mount.subPath && !mount.subPathExpr &&
    config?.name === configMapName && deployment.spec.replicas === 1);
  return path.value;
}

function scannerFields(template) {
  const pod = template.spec;
  const engine = named(pod.containers, 'engine');
  const copy = named(pod.initContainers, 'copy-databases');
  const https = named(pod.containers, 'https');
  const image = named(https.env, 'SCANNER_IMAGE');
  const sha = named(https.env, 'SCANNER_APPROVED_SHA');
  const source = named(pod.volumes, 'evidence-source');
  const sources = source.projected?.sources;
  requireSettings(sources?.length === 2 && sources[0]?.secret?.name);
  requireSettings(engine.image === image.value && copy.image === image.value &&
    /^.+@sha256:[a-f0-9]{64}$/u.test(image.value) && /^[a-f0-9]{64}$/u.test(sha.value));
  return { engine, copy, image, sha, sources };
}

async function getJson(kubectl, resource) {
  const body = await kubectl(['get', resource, '-o', 'json']);
  return JSON.parse(body);
}

function evidenceKeys(sha) {
  return { manifest: `signatures-${sha}.json`, release: `release-${sha}.json` };
}

async function installedRelease(kubectl, fields, config) {
  const sha = fields.sha.value;
  const image = fields.image.value;
  const source = fields.sources[1];
  const keys = evidenceKeys(sha);
  let text = config.data[keys.release];
  if (source.secret) {
    requireSettings(source.secret.name === fields.sources[0].secret.name);
    const name = `secret/${source.secret.name}`;
    const releasePath = String.raw`jsonpath={.data.release\.json}`;
    const encoded = await kubectl(['get', name, '-o', releasePath]);
    text = Buffer.from(encoded, 'base64').toString('utf8');
  } else {
    requireSettings(source.configMap?.name === configMapName);
  }
  const record = JSON.parse(text);
  const date = Date.parse(record.databaseUpdatedAt);
  requireSettings(image.endsWith(`@${record.imageDigest}`) &&
    record.manifestDigest === `sha256:${sha}` && Number.isFinite(date) && date <= Date.now());
  return { sha, image, date };
}

async function readInstall(kubectl) {
  const scanner = await getJson(kubectl, scannerResource);
  const server = await getJson(kubectl, serverResource);
  const config = await getJson(kubectl, configResource);
  const strategy = scanner.spec.strategy;
  requireSettings(scanner.spec.replicas === 1 && strategy?.type === 'RollingUpdate' &&
    strategy.rollingUpdate?.maxUnavailable === 0 && strategy.rollingUpdate?.maxSurge === 1);
  const path = getApprovalPath(server);
  const fields = scannerFields(scanner.spec.template);
  const previous = await installedRelease(kubectl, fields, config);
  const approved = config.data[approvalFile]?.trimEnd().split('\n');
  requireSettings(approved?.includes(`sha256:${previous.sha}`));
  return { scanner, config, previous, path };
}

function candidateTemplate(template, release) {
  const next = structuredClone(template);
  const fields = scannerFields(next);
  const keys = evidenceKeys(release.approvedSha);
  fields.copy.image = release.image;
  fields.engine.image = release.image;
  fields.image.value = release.image;
  fields.sha.value = release.approvedSha;
  fields.sources[1] = { configMap: { name: configMapName, items: [
    { key: keys.manifest, path: 'signatures.json' },
    { key: keys.release, path: 'release.json' },
  ] } };
  return next;
}

function patch(kubectl, name, operations) {
  return kubectl(['patch', name, '--type=json', '--patch', JSON.stringify(operations)]);
}

async function writeApproval(kubectl, config, data) {
  const operations = [
    { op: 'test', path: '/metadata/resourceVersion', value: config.metadata.resourceVersion },
    { op: 'replace', path: '/data', value: data },
  ];
  await patch(kubectl, configResource, operations);
}

async function stageApproval(kubectl, install, release) {
  const data = approvalData(install.config, install.previous.sha);
  const keys = evidenceKeys(release.approvedSha);
  data[keys.manifest] = (await readBoundedBytes(release.manifestPath)).toString('utf8');
  data[keys.release] = (await readBoundedBytes(release.releasePath, 1024)).toString('utf8');
  const text = `sha256:${install.previous.sha}\nsha256:${release.approvedSha}\n`;
  data[approvalFile] = text;
  await writeApproval(kubectl, install.config, data);
  return text;
}

async function waitForApproval(kubectl, path, text) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const args = ['--request-timeout=10s', 'exec', serverResource, '-c', 'server', '--', 'cat', path];
    const actual = await kubectl(args, 15_000);
    if (actual.trimEnd() === text.trimEnd()) return;
    await delay(2000);
  }
  throw new ScannerRefreshRefusal('projection');
}

function changeTemplate(kubectl, scanner, current, next) {
  const operations = [
    { op: 'test', path: '/metadata/uid', value: scanner.metadata.uid },
    { op: 'test', path: '/metadata/generation', value: scanner.metadata.generation },
    { op: 'test', path: templatePath, value: current },
    { op: 'replace', path: templatePath, value: next },
  ];
  return patch(kubectl, scannerResource, operations);
}

async function restoreScanner(kubectl, scanner, previous, next) {
  const actual = await getJson(kubectl, scannerResource);
  requireSettings(actual.metadata.uid === scanner.metadata.uid);
  if (isDeepStrictEqual(actual.spec.template, previous)) return 'unchanged';
  requireSettings(actual.metadata.generation === scanner.metadata.generation + 1);
  await changeTemplate(kubectl, actual, next, previous);
  return 'rollout';
}

function waitForScanner(kubectl) {
  return kubectl(['rollout', 'status', scannerResource, '--timeout=180s'], 195_000);
}

async function rollScanner(kubectl, scanner, release) {
  const previous = scanner.spec.template;
  const next = candidateTemplate(previous, release);
  try {
    await changeTemplate(kubectl, scanner, previous, next);
    await waitForScanner(kubectl);
  } catch (cause) {
    let reason;
    try {
      reason = await restoreScanner(kubectl, scanner, previous, next);
    } catch (restoreError) {
      const error = new AggregateError([cause, restoreError]);
      throw new ScannerRefreshRefusal('rollback', error);
    }
    throw new ScannerRefreshRefusal(reason, cause);
  }
}

function keepApprovalKey(name, sha) {
  if (!/^(signatures|release)-[a-f0-9]{64}\.json$/u.test(name)) return true;
  const keys = evidenceKeys(sha);
  return name === keys.manifest || name === keys.release;
}

function approvalData(config, sha) {
  const data = {};
  for (const [key, value] of Object.entries(config.data)) {
    if (keepApprovalKey(key, sha)) data[key] = value;
  }
  return data;
}

async function finishApproval(kubectl, release) {
  const config = await getJson(kubectl, configResource);
  const data = approvalData(config, release.approvedSha);
  const text = `sha256:${release.approvedSha}\n`;
  if (data[approvalFile] === text) return;
  data[approvalFile] = text;
  await writeApproval(kubectl, config, data);
}

async function completeRefresh(kubectl, release, current) {
  let cleanupPending = false;
  try {
    await finishApproval(kubectl, release);
  } catch (cause) {
    // Keep the two checked pins if cleanup fails. Both still carry their original expiry.
    const warning = new ScannerRefreshRefusal('settings', cause);
    logger.warn({ reason: warning.reason }, 'Could not remove the previous scanner approval');
    cleanupPending = true;
  }
  const status = current ? 'current' : 'updated';
  return { status, image: release.image, sha: release.approvedSha, runId: release.runId,
    databaseUpdatedAt: release.databaseUpdatedAt, cleanupPending };
}

function requireSettledScanner(scanner) {
  const status = scanner.status;
  const replicas = status?.replicas ?? 0;
  const updated = status?.updatedReplicas ?? 0;
  if (status?.observedGeneration !== scanner.metadata.generation ||
      replicas > 1 || updated !== replicas) {
    throw new ScannerRefreshRefusal('busy');
  }
}

export async function refreshScanner(kubectl, expectedImage) {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-refresh-'));
  let stage = 'approval';
  try {
    const release = await fetchLatestScannerApproval(directory);
    if (expectedImage !== undefined && expectedImage !== release.image) {
      throw new ScannerRefreshRefusal('image');
    }
    stage = 'install';
    const install = await readInstall(kubectl);
    const current = release.image === install.previous.image &&
      release.approvedSha === install.previous.sha;
    if (!current && Date.parse(release.databaseUpdatedAt) <= install.previous.date) {
      const { image, sha, date } = install.previous;
      return { status: 'newer-installed', image, sha, runId: release.runId,
        databaseUpdatedAt: new Date(date).toISOString() };
    }
    if (!current) {
      // Keep the approval for any old replica that is still serving.
      requireSettledScanner(install.scanner);
      stage = 'publish';
      publishPackageImage(join(directory, 'scanner.tar'), release.image);
      stage = 'settings';
      const text = await stageApproval(kubectl, install, release);
      stage = 'projection';
      await waitForApproval(kubectl, install.path, text);
      stage = 'expired';
      await readApprovedRelease(release, Date.now());
      stage = 'patch';
      await rollScanner(kubectl, install.scanner, release);
    } else {
      await waitForScanner(kubectl);
    }
    return await completeRefresh(kubectl, release, current);
  } catch (cause) {
    const error = cause instanceof ScannerRefreshRefusal ? cause :
      new ScannerRefreshRefusal(stage, cause);
    logger.error({ reason: error.reason }, error.message);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
