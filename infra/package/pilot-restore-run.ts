import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createLogger } from '@opencrane/observability';
import { descriptorSchema } from './event-backup.ts';
import { backupProviderMode } from './model-settings.ts';
import { restorePilotBackup, PilotRestoreRefused } from './pilot-restore.ts';
import { packageRestoreTarget } from './pilot-restore-target.ts';

const logger = createLogger('pilot-restore');

async function main() {
  const [argument, extra] = process.argv.slice(2);
  if (extra) throw new Error('Unexpected restore argument');
  const id = descriptorSchema.shape.attempt.parse(argument);
  const images = z.record(z.string(), z.string()).parse(JSON.parse(process.env['BACKUP_IMAGES'] ?? '{}'));
  const options = { directory: '/backups/sets', stateDirectory: '/restore/state', id,
    silo: process.env['SILO_ID'] ?? '', images, providerMode: backupProviderMode(process.env) };
  const runtime = await packageRestoreTarget(options);
  try {
    const result = await restorePilotBackup(options, runtime.target);
    logger.info({ backupId: result.backupId, sequence: result.sequence, stage: 'complete' },
      'Pilot restore PASS; reading is open and effects remain held');
  } finally {
    await runtime.close();
  }
}

function failed(error: unknown) {
  let reason = 'operator_command';
  let stage = 'arguments';
  if (error instanceof PilotRestoreRefused) {
    reason = error.reason;
    stage = error.stage;
  }
  // Keep dependency output and credentials inside the operation, away from operator logs.
  const err = new Error('Pilot restore FAIL', { cause: { kind: 'pilot_restore', reason, stage } });
  logger.error({ err, reason, stage }, 'Pilot restore FAIL; keep the installation isolated');
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(failed);
}
