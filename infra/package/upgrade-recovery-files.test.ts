import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { files, ProjectionRunner } from '@opencrane/projections';
import { database } from '@opencrane/projections/testing';
import { logger } from '../../libs/handlers/test/helpers.ts';
import { restoreStorage } from '../../apps/server/test/support/restore-storage.ts';
import { seedRecoveryFiles } from './upgrade-recovery-files-fixture.ts';
import { collectFileRecovery, checkFileRecovery } from './upgrade-recovery-files.ts';

let nats: Awaited<ReturnType<typeof natsFixture>>;
let postgres: Awaited<ReturnType<typeof database>>;
let objects: Awaited<ReturnType<typeof restoreStorage>>;
let runner: ProjectionRunner;
let before: Awaited<ReturnType<typeof collectFileRecovery>>;
let uploads: Awaited<ReturnType<typeof seedRecoveryFiles>>;
let sequence: number;
async function initialise() {
  nats = await natsFixture();
  postgres = await database('pg');
  objects = await restoreStorage();
  uploads = await seedRecoveryFiles(nats, objects.client);
  sequence = await nats.reader.head();
  runner = new ProjectionRunner(postgres.db, nats.reader, logger);
  await runner.initialise(files);
  await runner.run(files);
  before = await collectFileRecovery(postgres.db, objects.client);
}
async function reset() {
  await postgres.db.query("UPDATE projection_checkpoints SET sequence = $1 WHERE name = 'files'",
    [sequence]);
  await runner.rebuild(files);
  for (const upload of uploads) {
    await objects.client.putObject('files', upload.data.objectKey, upload.bytes);
  }
}
async function close() {
  await objects?.close();
  await postgres?.close();
  await nats?.close();
}
beforeAll(initialise, 60_000);
beforeEach(reset);
afterAll(close);

const corruptions = [
  ['missing row', "DELETE FROM conversation_files WHERE file_id = 'screen'"],
  ['silo', "UPDATE conversation_files SET silo = 'foreign'"],
  ['conversation', "UPDATE conversation_files SET conversation_id = 'foreign'"],
  ['status', "UPDATE conversation_files SET status = 'delivered'"],
  ['delivery outcome', "UPDATE conversation_files SET delivery_outcome = 'kept_existing'"],
  ['position', 'UPDATE conversation_files SET position = position + 1'],
  ['saved data', `UPDATE conversation_files SET data = jsonb_set(data, '{name}', '"changed"')`],
  ['ahead checkpoint', `UPDATE projection_checkpoints SET sequence = sequence + 1
    WHERE name = 'files'`],
] as const;
async function refusesRows(_name: string, sql: string) {
  await postgres.db.query(sql);
  const after = await collectFileRecovery(postgres.db, objects.client);
  function compare() { checkFileRecovery(before, after, sequence); }
  expect(compare).toThrow('File recovery comparison refused');
}
it.each(corruptions)('refuses changed %s before comparison', refusesRows);

async function refusesBytes(missing: boolean) {
  const address = uploads[0]!.data.objectKey;
  if (missing) {
    await objects.client.removeObject('files', address);
  } else {
    const corrupt = Buffer.alloc(uploads[0]!.bytes.length, 65);
    await objects.client.putObject('files', address, corrupt);
  }
  await expect(collectFileRecovery(postgres.db, objects.client))
    .rejects.toEqual(new Error('File recovery collection refused'));
}
it.each([false, true])('refuses actual object corruption (missing: %s)', refusesBytes);

async function acceptsUnchanged() {
  const after = await collectFileRecovery(postgres.db, objects.client);
  expect(after).toEqual(before);
  expect(after.rowCount).toBe(2);
  checkFileRecovery(before, after, sequence);
}
it('accepts complete rows and actual bytes after rebuilding', acceptsUnchanged);

async function refusesMatchingAhead() {
  await postgres.db.query(`UPDATE projection_checkpoints SET sequence = sequence + 1
    WHERE name = 'files'`);
  const ahead = await collectFileRecovery(postgres.db, objects.client);
  function compare() { checkFileRecovery(ahead, ahead, sequence); }
  expect(compare).toThrow('File recovery comparison refused');
}
it('refuses matching checkpoints ahead of the archive', refusesMatchingAhead);
