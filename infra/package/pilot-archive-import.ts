import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

type BackupSource = { clusterUid: string; namespace: string; namespaceUid?: string | undefined };

export interface ArchiveDestination {
  namespace: string;
  namespaceUid: string;
  run(args: string[], archive?: string): Promise<string>;
}

const execute = promisify(execFile);

class ImportRefused extends Error {}

export async function importPilotArchive(
  source: BackupSource, destination: ArchiveDestination, archive: string,
): Promise<void> {
  const { namespace, namespaceUid, run } = destination;
  const clusterId = await run(['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}']);
  const clusterUid = clusterId.trim();
  if (!source.clusterUid.trim() || !source.namespace.trim() || !clusterUid ||
      !namespace.trim() || !namespaceUid.trim() || source.namespaceUid?.trim() === '') {
    throw new ImportRefused('The source and destination identities are required');
  }
  const sameName = source.namespace === namespace && source.clusterUid === clusterUid;
  // Keep refusing an older export with no ID if its cluster and namespace name match.
  if (sameName && (!source.namespaceUid || source.namespaceUid === namespaceUid)) {
    throw new ImportRefused('The destination matches the source cluster and namespace');
  }
  await run(['-n', namespace, 'rollout', 'status', 'deployment/backup-catalogue', '--timeout=60s']);
  await run(['-n', namespace, 'exec', '-i', 'deployment/backup-catalogue', '--',
    'sh', '-ec', 'mkdir -m 700 -p /backups/sets && tar -xpf - -C /backups/sets'], archive);
}

async function extractArchive(args: string[], archive: string, env: NodeJS.ProcessEnv) {
  const file = await open(archive, 'r');
  try {
    const child = spawn('kubectl', args, { env, stdio: [file.fd, 'ignore', 'ignore'],
      signal: AbortSignal.timeout(120_000) });
    const [code] = await once(child, 'exit') as [number | null];
    if (code !== 0) {
      throw new ImportRefused('The backup archive could not be imported');
    }
  } finally {
    await file.close();
  }
}

async function main() {
  const [archive, clusterUid, namespace, namespaceUid, extra] = process.argv.slice(2);
  if (!archive || !clusterUid || !namespace || extra !== undefined) {
    throw new ImportRefused('Pass the archive, source cluster ID, namespace and namespace ID');
  }
  const owner = await verifyPackageOwner();
  async function run(args: string[], archiveFile?: string): Promise<string> {
    // Check namespace ownership again just before each operation.
    const connection = await packageConnectionArgs(owner);
    const command = [...connection.args, ...args];
    if (archiveFile) {
      await extractArchive(command, archiveFile, connection.environment);
      return '';
    }
    const result = await execute('kubectl', command, { env: connection.environment,
      timeout: 70_000 });
    return result.stdout;
  }
  const source = { clusterUid, namespace, namespaceUid };
  const destination = { namespace: owner.namespace, namespaceUid: owner.namespaceUid, run };
  await importPilotArchive(source, destination, archive);
  console.log('PASS archive imported into the checked recovery namespace');
}

function failed(cause: unknown) {
  const message = cause instanceof ImportRefused ? cause.message : 'Could not check the recovery install';
  console.error(`Backup import refused. ${message}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(failed);
}
