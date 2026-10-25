#!/usr/bin/env -S node --experimental-strip-types
import { connectNats } from '@opencrane/event-store';
import { collectEventBackup } from './event-backup.ts';

// Bound connection setup and shutdown too, including reads of credential files.
const controller = new AbortController();
const expired = Promise.withResolvers<never>();
function cancel() {
  controller.abort();
  expired.reject(new Error('Event backup refused'));
}
function hardStop() {
  process.stderr.write('Event backup refused\n');
  process.exit(1);
}
const deadline = setTimeout(cancel, 60_000);
const shutdownDeadline = setTimeout(hardStop, 65_000);
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
let connection: Awaited<ReturnType<typeof connectNats>> | undefined;
async function openConnection() {
  const opened = await connectNats();
  connection = opened;
  if (controller.signal.aborted) await opened.close();
  return opened;
}
try {
  const [silo, attempt, destination, extra] = process.argv.slice(2);
  if (!silo || !attempt || !destination || extra) throw new Error('Event backup refused');
  connection = await Promise.race([openConnection(), expired.promise]);
  await collectEventBackup(connection, { silo, attempt, destination, signal: controller.signal });
} catch {
  process.stderr.write('Event backup refused\n');
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (!connection) process.exit(1);
  try {
    await connection.close();
  } catch {
    process.stderr.write('Event backup refused\n');
    process.exitCode = 1;
  }
  clearTimeout(shutdownDeadline);
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
