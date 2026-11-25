import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

type BackupSource = { clusterUid: string; namespace: string };

export interface ArchiveDestination {
  namespace: string;
  run(args: string[], archive?: string): Promise<string>;
}

const execute = promisify(execFile);

class ImportRefused extends Error {}

export async function importPilotArchive(
  source: BackupSource, destination: ArchiveDestination, archive: string,
): Promise<void> {
  const { namespace, run } = destination;
  const clusterId = await run(['get', 'namespace', 'kube-system', '-o', 'jsonpath={.metadata.uid}']);
  const clusterUid = clusterId.trim();
  if (!source.clusterUid || !source.namespace || !clusterUid) {
    throw new ImportRefused('The source and destination identities are required');
  }
  // Compare the cluster’s own ID so context aliases cannot hide a source match.
  if (source.namespace === namespace && source.clusterUid === clusterUid) {
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
  const [archive, clusterUid, namespace] = process.argv.slice(2);
  if (!archive || !clusterUid || !namespace || process.argv.length !== 5) {
    throw new ImportRefused('Pass the archive, source cluster ID and source namespace');
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
  await importPilotArchive({ clusterUid, namespace }, { namespace: owner.namespace, run }, archive);
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
