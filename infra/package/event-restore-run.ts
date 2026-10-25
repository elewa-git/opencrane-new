#!/usr/bin/env -S node --experimental-strip-types
import { connectNats } from '@opencrane/event-store';
import type { NatsConnection } from '@nats-io/transport-node';
import { restoreEventBackup } from './event-restore.ts';

const message = 'Event restore refused; keep target isolated\n';
const controller = new AbortController();
const expired = Promise.withResolvers<never>();
const connections: NatsConnection[] = [];
function cancel() {
  controller.abort();
  expired.reject(new Error(message));
}
function hardStop() {
  process.stderr.write(message);
  process.exit(1);
}
async function open(env: NodeJS.ProcessEnv) {
  const connection = await connectNats(env);
  connections.push(connection);
  if (controller.signal.aborted) await connection.close();
  return connection;
}
const deadline = setTimeout(cancel, 60_000);
const shutdownDeadline = setTimeout(hardStop, 65_000);
process.once('SIGINT', cancel);
process.once('SIGTERM', cancel);
try {
  const [silo, directory, flag, extra] = process.argv.slice(2);
  if (!silo || !directory || flag !== '--disposable' || extra) throw new Error(message);
  const sourceEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('SOURCE_NATS_')) sourceEnv[name.slice('SOURCE_'.length)] = value;
  }
  const source = await Promise.race([open(sourceEnv), expired.promise]);
  const target = await Promise.race([open(process.env), expired.promise]);
  await restoreEventBackup(source, target,
    { silo, directory, disposable: true, signal: controller.signal });
} catch {
  process.stderr.write(message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (controller.signal.aborted) process.exit(1);
  for (const connection of connections) {
    try {
      await connection.close();
    } catch {
      process.stderr.write(message);
      process.exitCode = 1;
    }
  }
  clearTimeout(shutdownDeadline);
  process.removeListener('SIGINT', cancel);
  process.removeListener('SIGTERM', cancel);
}
