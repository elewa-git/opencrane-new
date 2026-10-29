import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { recoveryHomes } from '../../apps/server/test/support/recovery-homes.ts';
import { captureBounds, collectEventBackup } from './event-backup.ts';
import { checkComputerVolumeBackup } from './computer-volume-check.ts';

async function fixture() {
  const source = await natsFixture();
  onTestFinished(source.close);
  const directory = await mkdtemp(join(tmpdir(), 'restore-home-'));
  async function cleanup() {
    await rm(directory, { recursive: true, force: true });
  }
  onTestFinished(cleanup);
  const homes = await recoveryHomes(source, ['one', 'two']);
  const options = { eventDirectory: join(directory, 'events'),
    volumeDirectory: join(directory, 'homes'), backupKeyFile: join(directory, 'key'),
    silo: 'test', attempt: 'copy' };
  await writeFile(options.backupKeyFile, randomBytes(32), { mode: 0o600 });
  await collectEventBackup(source.connection,
    { silo: options.silo, attempt: options.attempt, destination: options.eventDirectory });
  await homes(options);
  const bounds = captureBounds(source.connection, {});
  onTestFinished(bounds.dispose);
  return { source, options, bounds };
}

async function deliversOnlyAuthenticatedBytes() {
  const setup = await fixture();
  const deliver = vi.fn();
  await checkComputerVolumeBackup(setup.source.connection, setup.options, setup.bounds, deliver);
  expect(deliver).toHaveBeenCalledTimes(1);
}
it('hands off both authenticated homes before erasing their plaintext', deliversOnlyAuthenticatedBytes);
