import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger } from '@opencrane/observability';
import { fetchLatestScannerApproval } from '../clamav/approval.mjs';
import { readApprovedRelease, readBoundedBytes } from '../clamav/release.mjs';
import { publishPackageImage } from './publish-package-image.mjs';
import {
  approvalFile,
  changeTemplate,
  configMapName,
  configResource,
  evidenceKeys,
  getJson,
  isNewerRelease,
  newAttempt,
  recoverAttempt,
  requireSettings,
  requireSettledScanner,
  savedAttempt,
  ScannerRefreshRefusal,
  scannerPosition,
  scannerResource,
  waitForReadyScanner,
  withAttempt,
  writeApproval,
} from './scanner-rollout.mjs';

export { ScannerRefreshRefusal };

const logger = createLogger('scanner-refresh');
const serverResource = 'deployment/server';
const mountPath = '/run/scanner-approval';
const approvalPath = `${mountPath}/${approvalFile}`;

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
  // Mount the directory so Kubernetes can replace the approval file while the server runs.
  requireSettings(path.value === approvalPath && mount.mountPath === mountPath &&
    mount.readOnly === true && !mount.subPath && !mount.subPathExpr &&
    config?.name === configMapName && deployment.spec.replicas === 1);
  return path.value;
}

function scannerFields(template) {
  const pod = template.spec;
  const engine = named(pod.containers, 'engine');
  const databaseCopy = named(pod.initContainers, 'copy-databases');
  const https = named(pod.containers, 'https');
  const image = named(https.env, 'SCANNER_IMAGE');
  const manifestHash = named(https.env, 'SCANNER_APPROVED_SHA');
  const source = named(pod.volumes, 'evidence-source');
  const sources = source.projected?.sources;
  requireSettings(sources?.length === 2 && sources[0]?.secret?.name);
  requireSettings(engine.image === image.value && databaseCopy.image === image.value &&
    /^.+@sha256:[a-f0-9]{64}$/u.test(image.value) &&
    /^[a-f0-9]{64}$/u.test(manifestHash.value));
  return { engine, databaseCopy, image, manifestHash, sources };
}

async function readInstalledEvidence(kubectl, config, fields) {
  const source = fields.sources[1];
  if (!source.secret) {
    requireSettings(source.configMap?.name === configMapName);
    const keys = evidenceKeys(fields.manifestHash.value);
    return config.data[keys.release];
  }
  requireSettings(source.secret.name === fields.sources[0].secret.name);
  const name = `secret/${source.secret.name}`;
  const releasePath = String.raw`jsonpath={.data.release\.json}`;
  const encoded = await kubectl(['get', name, '-o', releasePath]);
  const releaseBytes = Buffer.from(encoded, 'base64');
  return releaseBytes.toString('utf8');
}

async function installedRelease(kubectl, install) {
  const fields = scannerFields(install.scanner.spec.template);
  const text = await readInstalledEvidence(kubectl, install.config, fields);
  const record = JSON.parse(text);
  const sha = fields.manifestHash.value;
  const image = fields.image.value;
  const date = Date.parse(record.databaseUpdatedAt);
  requireSettings(image.endsWith(`@${record.imageDigest}`) &&
    record.manifestDigest === `sha256:${sha}` && Number.isFinite(date) && date <= Date.now());
  const approval = install.config.data[approvalFile]?.trimEnd();
  const approved = approval?.split('\n');
  requireSettings(approved?.includes(`sha256:${sha}`));
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
  return { scanner, config, path };
}

function candidateTemplate(template, release) {
  const next = structuredClone(template);
  const fields = scannerFields(next);
  const keys = evidenceKeys(release.approvedSha);
  fields.databaseCopy.image = release.image;
  fields.engine.image = release.image;
  fields.image.value = release.image;
  fields.manifestHash.value = release.approvedSha;
  fields.sources[1] = { configMap: { name: configMapName, items: [
    { key: keys.manifest, path: 'signatures.json' },
    { key: keys.release, path: 'release.json' },
  ] } };
  return next;
}

async function stageApproval(kubectl, install, release, attempt) {
  const data = withAttempt(install.config.data, attempt);
  const keys = evidenceKeys(release.approvedSha);
  const manifest = await readBoundedBytes(release.manifestPath);
  const record = await readBoundedBytes(release.releasePath, 1024);
  data[keys.manifest] = manifest.toString('utf8');
  data[keys.release] = record.toString('utf8');
  data[approvalFile] = attempt.approval;
  // Save the rollback details and both hashes before either scanner can serve uploads.
  await writeApproval(kubectl, install.config, data);
}

async function waitForApproval(kubectl, path, text) {
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const args = ['--request-timeout=10s', 'exec', serverResource, '-c', 'server', '--', 'cat', path];
    const actual = await kubectl(args, 15_000);
    if (actual.trimEnd() === text.trimEnd()) {
      return;
    }
    await delay(2000);
  }
  throw new ScannerRefreshRefusal('projection');
}

async function applyAttempt(kubectl, install, release, attempt) {
  let stage = 'projection';
  try {
    await waitForApproval(kubectl, install.path, attempt.approval);
    stage = 'expired';
    await readApprovedRelease(release, Date.now());
    stage = 'patch';
    await changeTemplate(kubectl, attempt.previous, attempt.next);
  } catch (cause) {
    return new ScannerRefreshRefusal(stage, cause);
  }
  return undefined;
}

async function startRefresh(kubectl, install, previous, release, directory) {
  requireSettledScanner(install.scanner);
  try {
    const archive = join(directory, 'scanner.tar');
    publishPackageImage(archive, release.image);
  } catch (cause) {
    throw new ScannerRefreshRefusal('publish', cause);
  }
  const template = candidateTemplate(install.scanner.spec.template, release);
  const approval = `sha256:${previous.sha}\nsha256:${release.approvedSha}\n`;
  const attempt = newAttempt(install, release, template, approval);
  await stageApproval(kubectl, install, release, attempt);
  const failure = await applyAttempt(kubectl, install, release, attempt);
  const scanner = await readPatchedScanner(kubectl, failure);
  const outcome = await recoverAttempt(kubectl, scanner, attempt);
  if (outcome.status === 'restored') {
    throw new ScannerRefreshRefusal('rollout', outcome.cause);
  }
  if (outcome.status === 'cleared') {
    throw failure ?? new ScannerRefreshRefusal('patch');
  }
  return resultFor(release, 'updated');
}

async function readPatchedScanner(kubectl, failure) {
  try {
    return await getJson(kubectl, scannerResource);
  } catch (cause) {
    throw failure ?? new ScannerRefreshRefusal('patch', cause);
  }
}

function resultFor(release, status) {
  return { status, image: release.image, sha: release.approvedSha, runId: release.runId,
    databaseUpdatedAt: release.databaseUpdatedAt };
}

async function chooseRelease(directory, expectedImage) {
  let release;
  try {
    release = await fetchLatestScannerApproval(directory);
  } catch (cause) {
    const failure = new ScannerRefreshRefusal('approval', cause);
    if (expectedImage !== undefined) {
      throw failure;
    }
    // A scheduled check can still restore a saved rollout if GitHub is unavailable.
    return { failure };
  }
  if (expectedImage !== undefined && expectedImage !== release.image) {
    throw new ScannerRefreshRefusal('image');
  }
  return { release };
}

function sameRelease(attempt, release) {
  return attempt.image === release.image && attempt.approvedSha === release.approvedSha;
}

async function refreshInstall(kubectl, selection, directory) {
  let install = await readInstall(kubectl);
  const attempt = savedAttempt(install.config);
  const { release } = selection;
  if (attempt !== undefined) {
    const outcome = await recoverAttempt(kubectl, install.scanner, attempt, release);
    if (outcome.status === 'restored' && !isNewerRelease(attempt, release)) {
      throw new ScannerRefreshRefusal('rollout', outcome.cause);
    }
    if (outcome.status === 'updated' && release !== undefined && sameRelease(attempt, release)) {
      return resultFor(release, 'updated');
    }
    install = await readInstall(kubectl);
  }
  if (release === undefined) {
    throw selection.failure;
  }
  const previous = await installedRelease(kubectl, install);
  if (sameRelease({ image: previous.image, approvedSha: previous.sha }, release)) {
    await waitForReadyScanner(kubectl, scannerPosition(install.scanner));
    return resultFor(release, 'current');
  }
  if (Date.parse(release.databaseUpdatedAt) <= previous.date) {
    await waitForReadyScanner(kubectl, scannerPosition(install.scanner));
    return { status: 'newer-installed', image: previous.image, sha: previous.sha,
      runId: release.runId, databaseUpdatedAt: new Date(previous.date).toISOString() };
  }
  return startRefresh(kubectl, install, previous, release, directory);
}

function safeCause(cause) {
  if (cause instanceof ScannerRefreshRefusal) {
    return cause.reason;
  }
  if (cause?.cause === 'expired' || cause?.cause?.reason === 'expired') {
    return 'expired';
  }
  if (cause instanceof SyntaxError || cause?.cause?.reason === 'malformed') {
    return 'malformed';
  }
  if (cause !== undefined) {
    return 'outage';
  }
  return undefined;
}

export async function refreshScanner(kubectl, expectedImage) {
  const directory = await mkdtemp(join(tmpdir(), 'scanner-refresh-'));
  try {
    const selection = await chooseRelease(directory, expectedImage);
    return await refreshInstall(kubectl, selection, directory);
  } catch (cause) {
    const error = cause instanceof ScannerRefreshRefusal ? cause :
      new ScannerRefreshRefusal('install', cause);
    logger.error({ reason: error.reason, cause: safeCause(error.cause) }, error.message);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
