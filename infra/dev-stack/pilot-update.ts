import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createLogger } from '@opencrane/observability';
import { readApprovedRelease } from '../clamav/release.mjs';
import { publishComputerImage } from '../package/publish-approved-images.mjs';
import { directory, root } from './config.ts';
import { readBoundedJson, readBoundedText } from './bounded-input.ts';
import { backupBeforeUpdate, requireIdleBackup, updateBackupLock } from './pilot-update-backup.ts';
import { checkComputerImages, recordComputers, replaceComputerImages,
  type SavedComputer } from './pilot-computers.ts';
import { command, configureComputerGateway, installedValues, ownedKubectl,
  releaseCommand, waitForPilot, type PackageOwner } from './packaged.ts';

type UpdateRecord = {
  id: string;
  namespaceUid: string;
  releaseSecretUid: string;
  context: string;
  namespace: string;
  revision: string;
  sourceRevision: string;
  images: Record<string, string>;
  volumes: Record<string, string>;
  computers: SavedComputer[];
  backupId?: string;
};
const logger = createLogger('pilot-update');

async function volumeIds(owner: PackageOwner) {
  const output = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'pvc', '-o', 'json']);
  const list = JSON.parse(output) as { items: Array<{ metadata: { name: string; uid: string } }> };
  const result: Record<string, string> = {};
  for (const item of list.items) result[item.metadata.name] = item.metadata.uid;
  return result;
}

async function checkScanner(owner: PackageOwner, revision: string, margin = 0) {
  const output = await releaseCommand(owner, ['get', 'values', owner.release, '--revision',
    revision, '-o', 'json']);
  const values = JSON.parse(output) as Awaited<ReturnType<typeof installedValues>>;
  const name = values.secrets?.scanner;
  if (!name || !values.images?.['scanner'] || !values.scanner?.approvedSha) {
    throw new Error('The recorded scanner approval is missing');
  }
  const secretText = await ownedKubectl(owner, ['-n', owner.namespace, 'get', 'secret', name,
    '-o', 'json']);
  const secret = JSON.parse(secretText) as { data: Record<string, string> };
  const destination = join(directory, 'rollback-scanner');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const file of ['signatures.json', 'release.json']) {
    const encoded = secret.data[file];
    if (!encoded) throw new Error('The recorded scanner files are missing');
    await writeFile(join(destination, file), Buffer.from(encoded, 'base64'), { mode: 0o600 });
  }
  const settings = { image: values.images['scanner'], approvedSha: values.scanner.approvedSha,
    manifestPath: join(destination, 'signatures.json'), releasePath: join(destination, 'release.json') };
  await readApprovedRelease(settings, Date.now());
  // Keep a full maintenance hour available before the old scanner approval expires.
  if (margin) await readApprovedRelease(settings, Date.now() + margin);
}

async function recordUpdate(owner: PackageOwner, revision: string,
  sourceRevision: string): Promise<UpdateRecord> {
  const values = await installedValues(owner);
  if (!values.exposure?.public?.enabled || values.pilotRestore?.enabled ||
      !owner.releaseSecretUid || !values.images) {
    throw new Error('The update needs the recorded live pilot, not a recovery installation');
  }
  return { id: randomUUID(), namespaceUid: owner.namespaceUid,
    releaseSecretUid: owner.releaseSecretUid, context: owner.context, namespace: owner.namespace,
    revision, sourceRevision, images: values.images, volumes: await volumeIds(owner),
    computers: await recordComputers(owner) };
}

function recordDirectory(record: UpdateRecord) {
  if (!/^[a-f0-9-]{36}$/u.test(record.id)) throw new Error('The update record ID is invalid');
  return join(directory, `pilot-update-${record.id}`);
}

async function saveUpdateRecord(record: UpdateRecord) {
  const contents = JSON.stringify(record);
  const paths = [join(recordDirectory(record), 'state.json'), join(directory, 'pilot-update.json')];
  for (const path of paths) {
    await writeFile(path, contents, { mode: 0o600 });
  }
}

async function checkRecordedTarget(owner: PackageOwner, record: UpdateRecord) {
  if (record.context !== owner.context || record.namespace !== owner.namespace ||
      record.namespaceUid !== owner.namespaceUid || record.releaseSecretUid !== owner.releaseSecretUid) {
    throw new Error('The update record belongs to another installation');
  }
  if (!isDeepStrictEqual(await volumeIds(owner), record.volumes)) {
    throw new Error('The pilot volumes differ from the recorded update');
  }
}

async function buildComputer(record: UpdateRecord) {
  const revision = record.sourceRevision;
  const logFile = join(recordDirectory(record), 'computer-build.log');
  const script = 'exec nice -n 10 node "$1" --id "$2" --revision "$3" ' +
    '--computer-only > "$4" 2>&1';
  const args = ['-c', script, 'pilot-computer',
    'scripts/private-memory-qualification/build-images.mjs', process.env['DEV_STACK_ID']!,
    revision, logFile];
  await command('bash', args, 1_800_000);
  const output = await readBoundedText(logFile);
  const trimmed = output.trim();
  const lines = trimmed.split('\n');
  const filename = lines.at(-1);
  if (!filename) throw new Error('The computer build did not return its checked record');
  const result = await readBoundedJson(filename) as {
    sourceRevision: string; computer: { archive: string; manifestDigest: string };
  };
  if (result.sourceRevision !== revision) throw new Error('The computer source revision differs');
  const image = await publishComputerImage(result.computer);
  await writeFile(join(recordDirectory(record), 'computer-image'), `${image}\n`, { mode: 0o600 });
  return image;
}

async function checkPilotHealth(owner: PackageOwner) {
  await waitForPilot(owner);
  const script = `for (const url of ['http://127.0.0.1:8080/healthz',
    'http://127.0.0.1:43002/healthz/ready']) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Pilot health failed');
    }`;
  await ownedKubectl(owner, ['-n', owner.namespace, 'exec', 'deployment/server', '-c', 'server',
    '--', 'node', '--input-type=module', '-e', script]);
}

async function restoreRelease(owner: PackageOwner, record: UpdateRecord) {
  await checkRecordedTarget(owner, record);
  await requireIdleBackup(owner, record.id);
  await checkScanner(owner, record.revision);
  await releaseCommand(owner, ['rollback', owner.release, record.revision, '--history-max', '0',
    '--wait=false'], 180_000);
  await configureComputerGateway(owner);
  await replaceComputerImages(owner, record.computers);
  await ownedKubectl(owner, ['-n', owner.namespace, 'scale', 'deployment/worker-computers',
    '--replicas=1']);
  await checkPilotHealth(owner);
  await checkComputerImages(owner, record.computers);
  const values = await installedValues(owner);
  if (!isDeepStrictEqual(values.images, record.images)) {
    throw new Error('The rolled-back image pins differ from the recorded images');
  }
  await checkRecordedTarget(owner, record);
}

export async function requireUpdateSource(revision: string) {
  const current = await command('git', ['rev-parse', 'HEAD']);
  if (current !== revision) throw new Error('The approved source revision changed');
  await command('git', ['diff', '--quiet', 'HEAD', '--', 'infra/package/chart']);
  const untracked = await command('git', ['ls-files', '--others', '--', 'infra/package/chart']);
  if (untracked) throw new Error('The chart contains untracked files');
}

export async function updatePilot(owner: PackageOwner, previous: string, settings: string[],
  sourceRevision: string) {
  await requireUpdateSource(sourceRevision);
  await requireIdleBackup(owner);
  await checkScanner(owner, previous, 3_600_000);
  const record = await recordUpdate(owner, previous, sourceRevision);
  const destination = recordDirectory(record);
  await mkdir(destination, { mode: 0o700 });
  record.backupId = await backupBeforeUpdate(owner, destination, record.images);
  await saveUpdateRecord(record);
  const image = await buildComputer(record);
  await updateBackupLock(owner, record.id);
  let serviceRestored = false;
  try {
    await requireIdleBackup(owner, record.id);
    await checkRecordedTarget(owner, record);
    await checkScanner(owner, previous, 3_600_000);
    await requireUpdateSource(sourceRevision);
    // Keep the original release Secret and the completed bootstrap Job for rollback.
    const chart = resolve(root, 'infra/package/chart');
    const args = ['upgrade', owner.release, chart, '--reuse-values',
      '--history-max', '0', '--wait=false', '--set-string', `images.computer=${image}`];
    for (const setting of settings) args.push('--set-string', setting);
    try {
      await releaseCommand(owner, [...args, '--set', 'pilotUpdatePaused=true'], 180_000);
      await ownedKubectl(owner, ['-n', owner.namespace, 'wait', '--for=delete', 'pod',
        '-l', 'app in (server,worker-dispatcher,worker-computers)', '--timeout=60s'], 70_000);
      await configureComputerGateway(owner);
      await replaceComputerImages(owner, record.computers, image);
      await releaseCommand(owner, [...args, '--set', 'pilotUpdatePaused=false'], 180_000);
      await configureComputerGateway(owner);
      await checkPilotHealth(owner);
      await checkComputerImages(owner, record.computers, image);
      await checkRecordedTarget(owner, record);
      serviceRestored = true;
    } catch (cause) {
      logger.error({ err: cause }, 'Pilot update failed; restoring the recorded release');
      try {
        await restoreRelease(owner, record);
        serviceRestored = true;
      } catch (rollback) {
        throw new AggregateError([cause, rollback], 'Pilot update and rollback could not be confirmed');
      }
      throw new Error(`Pilot update failed. Helm revision ${previous} was restored`, { cause });
    }
  } finally {
    // Retain the backup lock if neither the update nor rollback could restore service.
    if (serviceRestored) await updateBackupLock(owner, record.id, true);
  }
}

export async function rollbackPilot(owner: PackageOwner, revision: string) {
  const record = await readBoundedJson(join(directory, 'pilot-update.json')) as UpdateRecord;
  if (record.revision !== revision) throw new Error('Select the revision saved by this update');
  const values = await installedValues(owner);
  if (values.pilotRestore?.enabled) throw new Error('Rollback refuses a recovery installation');
  await checkRecordedTarget(owner, record);
  await requireIdleBackup(owner);
  await updateBackupLock(owner, record.id);
  await restoreRelease(owner, record);
  await updateBackupLock(owner, record.id, true);
}
