import { isDeepStrictEqual } from 'node:util';

export const approvalFile = 'approved-manifests';
export const configMapName = 'scanner-config';
export const configResource = `configmap/${configMapName}`;
export const scannerResource = 'deployment/scanner';
const attemptKey = 'scanner-refresh.json';
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
  changed: 'The scanner Deployment changed during the refresh',
  verify: 'Could not check which scanner rollout is active',
  readiness: 'The scanner did not become ready',
  rollback: 'The previous scanner could not be confirmed ready after the failed rollout',
  rollout: 'The scanner rollout failed and the previous pins were restored',
};

export class ScannerRefreshRefusal extends Error {
  constructor(reason, cause) {
    super(`Scanner refresh refused. ${refreshMessages[reason]}.`, { cause });
    this.reason = reason;
  }
}

export function requireSettings(condition) {
  if (!condition) {
    throw new ScannerRefreshRefusal('install');
  }
}

export async function getJson(kubectl, resource) {
  const body = await kubectl(['get', resource, '-o', 'json']);
  return JSON.parse(body);
}

export function evidenceKeys(sha) {
  return { manifest: `signatures-${sha}.json`, release: `release-${sha}.json` };
}

function patch(kubectl, resource, operations) {
  const body = JSON.stringify(operations);
  return kubectl(['patch', resource, '--type=json', '--patch', body]);
}

export async function writeApproval(kubectl, config, data) {
  const operations = [
    { op: 'test', path: '/metadata/resourceVersion', value: config.metadata.resourceVersion },
    { op: 'replace', path: '/data', value: data },
  ];
  try {
    await patch(kubectl, configResource, operations);
  } catch (cause) {
    throw new ScannerRefreshRefusal('settings', cause);
  }
}

export function scannerPosition(scanner) {
  const { uid, generation } = scanner.metadata;
  return { uid, generation, template: scanner.spec.template };
}

function matchesPosition(scanner, position) {
  const actual = scannerPosition(scanner);
  return isDeepStrictEqual(actual, position);
}

async function readScannerAt(kubectl, position) {
  let scanner;
  try {
    scanner = await getJson(kubectl, scannerResource);
  } catch (cause) {
    throw new ScannerRefreshRefusal('verify', cause);
  }
  if (!matchesPosition(scanner, position)) {
    throw new ScannerRefreshRefusal('changed');
  }
  return scanner;
}

export function changeTemplate(kubectl, current, next) {
  // Check the generation as well as the template. Another rollout could restore
  // the same template while this command is waiting.
  const operations = [
    { op: 'test', path: '/metadata/uid', value: current.uid },
    { op: 'test', path: '/metadata/generation', value: current.generation },
    { op: 'test', path: templatePath, value: current.template },
    { op: 'replace', path: templatePath, value: next.template },
  ];
  return patch(kubectl, scannerResource, operations);
}

function scannerHasSettled(scanner) {
  const status = scanner.status;
  const replicas = status?.replicas ?? 0;
  const updated = status?.updatedReplicas ?? 0;
  return status?.observedGeneration === scanner.metadata.generation &&
    replicas <= 1 && updated === replicas;
}

export function requireSettledScanner(scanner) {
  if (!scannerHasSettled(scanner)) {
    throw new ScannerRefreshRefusal('busy');
  }
}

function scannerIsReady(scanner) {
  return scannerHasSettled(scanner) && scanner.status.replicas === 1 &&
    scanner.status.readyReplicas === 1 && scanner.status.availableReplicas === 1;
}

export async function waitForReadyScanner(kubectl, position) {
  let failure;
  try {
    await kubectl(['rollout', 'status', scannerResource, '--timeout=180s'], 195_000);
  } catch (cause) {
    failure = cause;
  }
  // Kubectl follows the latest rollout. Confirm which template actually became ready.
  const scanner = await readScannerAt(kubectl, position);
  if (failure !== undefined || !scannerIsReady(scanner)) {
    throw new ScannerRefreshRefusal('readiness', failure);
  }
}

export function newAttempt(install, release, template, approval) {
  const previous = scannerPosition(install.scanner);
  const next = { ...previous, generation: previous.generation + 1, template };
  const { image, approvedSha, databaseUpdatedAt } = release;
  const keys = evidenceKeys(approvedSha);
  const original = install.config.data;
  const previousApproval = {
    [approvalFile]: original[approvalFile],
    [keys.manifest]: original[keys.manifest],
    [keys.release]: original[keys.release],
  };
  return { previous, next, image, approvedSha, databaseUpdatedAt, previousApproval, approval };
}

export function withAttempt(data, attempt) {
  return { ...data, [attemptKey]: JSON.stringify(attempt) };
}

export function savedAttempt(config) {
  const saved = config.data[attemptKey];
  if (saved === undefined) {
    return undefined;
  }
  return JSON.parse(saved);
}

async function readAttemptConfig(kubectl, attempt) {
  const config = await getJson(kubectl, configResource);
  if (config.data[attemptKey] !== JSON.stringify(attempt) ||
      config.data[approvalFile] !== attempt.approval) {
    throw new ScannerRefreshRefusal('settings');
  }
  return config;
}

async function restoreApproval(kubectl, attempt, position) {
  const config = await readAttemptConfig(kubectl, attempt);
  await readScannerAt(kubectl, position);
  const data = { ...config.data };
  const keys = evidenceKeys(attempt.approvedSha);
  for (const key of [keys.manifest, keys.release, approvalFile]) {
    const previous = attempt.previousApproval[key];
    if (previous === undefined) {
      delete data[key];
    } else {
      data[key] = previous;
    }
  }
  delete data[attemptKey];
  await writeApproval(kubectl, config, data);
}

function keepApprovalKey(name, sha) {
  if (!/^(signatures|release)-[a-f0-9]{64}\.json$/u.test(name)) {
    return true;
  }
  const keys = evidenceKeys(sha);
  return name === keys.manifest || name === keys.release;
}

async function finishApproval(kubectl, attempt) {
  const config = await readAttemptConfig(kubectl, attempt);
  const scanner = await readScannerAt(kubectl, attempt.next);
  if (!scannerIsReady(scanner)) {
    throw new ScannerRefreshRefusal('readiness');
  }
  const data = {};
  for (const [key, value] of Object.entries(config.data)) {
    if (keepApprovalKey(key, attempt.approvedSha)) {
      data[key] = value;
    }
  }
  delete data[attemptKey];
  data[approvalFile] = `sha256:${attempt.approvedSha}\n`;
  await writeApproval(kubectl, config, data);
}

function rolledBackPosition(attempt) {
  return { ...attempt.previous, generation: attempt.next.generation + 1 };
}

export function isNewerRelease(attempt, release) {
  return release !== undefined &&
    Date.parse(release.databaseUpdatedAt) > Date.parse(attempt.databaseUpdatedAt);
}

async function finishRollback(kubectl, attempt, release) {
  const position = rolledBackPosition(attempt);
  try {
    await waitForReadyScanner(kubectl, position);
  } catch (cause) {
    if (cause.reason !== 'readiness') {
      throw cause;
    }
    const actual = await readScannerAt(kubectl, position);
    // Let a newer release recover an outage after the failed replica has gone.
    if (!isNewerRelease(attempt, release) || !scannerHasSettled(actual)) {
      throw new ScannerRefreshRefusal('rollback', cause);
    }
  }
  await restoreApproval(kubectl, attempt, position);
  return { status: 'restored' };
}

async function finishRollout(kubectl, attempt, release) {
  try {
    await waitForReadyScanner(kubectl, attempt.next);
  } catch (cause) {
    if (cause.reason !== 'readiness') {
      throw cause;
    }
    const rollback = rolledBackPosition(attempt);
    try {
      await changeTemplate(kubectl, attempt.next, rollback);
    } catch (patchError) {
      const error = new AggregateError([cause, patchError]);
      throw new ScannerRefreshRefusal('rollback', error);
    }
    await finishRollback(kubectl, attempt, release);
    return { status: 'restored', cause };
  }
  await finishApproval(kubectl, attempt);
  return { status: 'updated' };
}

export async function recoverAttempt(kubectl, scanner, attempt, release) {
  if (matchesPosition(scanner, attempt.previous)) {
    await restoreApproval(kubectl, attempt, attempt.previous);
    return { status: 'cleared' };
  }
  if (matchesPosition(scanner, attempt.next)) {
    return finishRollout(kubectl, attempt, release);
  }
  if (matchesPosition(scanner, rolledBackPosition(attempt))) {
    return finishRollback(kubectl, attempt, release);
  }
  throw new ScannerRefreshRefusal('changed');
}
