import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createLogger } from '@opencrane/observability';
import { captureScheduledBackup, listBackups, showBackup } from './scheduled-backup.ts';

const logger = createLogger('package-backup');
export async function runBackupCommand(args: string[], directory: string) {
  const [command, id, extra] = args;
  if (extra) throw new Error('Unexpected backup argument');
  if (command === 'list' && !id) {
    process.stdout.write(`${JSON.stringify(await listBackups(directory), null, 2)}\n`);
  } else if (command === 'show' && id) {
    process.stdout.write(`${JSON.stringify(await showBackup(directory, id), null, 2)}\n`);
  } else if (command === 'run' && !id) {
    const images = z.record(z.string(), z.string()).parse(JSON.parse(process.env['BACKUP_IMAGES'] ?? '{}'));
    const providerMode = process.env['BACKUP_PROVIDER_MODE'] === 'true';
    const options = { directory, id: randomUUID(), silo: process.env['SILO_ID'] ?? '',
      images, providerMode };
    const { packageBackupSource } = await import('./scheduled-backup-source.ts');
    const runtime = await packageBackupSource(options);
    try {
      const manifest = await captureScheduledBackup(options, runtime.source);
      logger.info({ backupId: manifest.id, sequence: manifest.point.sequence }, 'Backup complete');
    } finally {
      await runtime.close();
    }
  } else {
    throw new Error('Expected run, list or show BACKUP_ID');
  }
}

function failed(error: unknown) {
  let reason = 'operator_command';
  if (error instanceof Error && error.cause && typeof error.cause === 'object' &&
      'kind' in error.cause && error.cause.kind === 'scheduled_backup' &&
      'reason' in error.cause && typeof error.cause.reason === 'string') {
    reason = error.cause.reason;
  }
  // Keep the stage, never SDK output, database text, private paths or credentials.
  const err = new Error('Backup failed', { cause: { kind: 'scheduled_backup', reason } });
  let message = 'Backup failed; inspect the Job and maintenance state';
  if (reason === 'resume' || reason === 'resume_marker') {
    message = 'Backup failed; maintenance remains active and the lock is retained';
  }
  logger.error({ err, reason }, message);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runBackupCommand(process.argv.slice(2), '/backups/sets').catch(failed);
}
