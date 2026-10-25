#!/usr/bin/env -S node --experimental-strip-types
import { connectNats } from '@opencrane/event-store';
import type { NatsConnection } from '@nats-io/transport-node';
import { replay } from '../../apps/ops/src/replay.ts';
import { checkMemoryRestore } from './memory-restore-check.ts';

const message = 'Memory restore refused; keep target isolated\n';
const connections: NatsConnection[] = [];
const controller = new AbortController();
function stop() {
  controller.abort();
  process.stderr.write(message);
  process.exit(1);
}
const deadline = setTimeout(stop, 65_000);
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  const [silo, flag, extra] = process.argv.slice(2);
  const sourceDirectory = process.env['SOURCE_MEMORY_KEY_DIRECTORY'];
  const candidateDirectory = process.env['MEMORY_KEY_DIRECTORY'];
  if (!silo || flag !== '--confirm-stopped' || extra || !sourceDirectory || !candidateDirectory) {
    throw new Error(message);
  }
  const sourceEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('SOURCE_NATS_')) {
      sourceEnv[name.slice('SOURCE_'.length)] = value;
    }
  }
  const source = await connectNats(sourceEnv);
  connections.push(source);
  const target = await connectNats();
  connections.push(target);
  await checkMemoryRestore(source, target,
    { silo, sourceDirectory, candidateDirectory, stopped: true, signal: controller.signal });
  for (const connection of connections) {
    await connection.close();
  }
  clearTimeout(deadline);
  // Open PostgreSQL only after custody and current source history have passed all checks.
  await replay(['memory', '--confirm-memory-stopped']);
} catch {
  process.stderr.write(message);
  process.exitCode = 1;
} finally {
  for (const connection of connections) {
    try {
      await connection.close();
    } catch {
      process.stderr.write(message);
      process.exitCode = 1;
    }
  }
  clearTimeout(deadline);
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
}
