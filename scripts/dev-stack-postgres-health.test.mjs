import { execFile, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { until } from '@opencrane/authz/testing';
import { ports } from '../infra/dev-stack/identity.ts';

const execute = promisify(execFile);
const definitionSchema = z.object({ services: z.object({ postgres: z.object({
  image: z.string(), healthcheck: z.object({ test: z.tuple([z.literal('CMD-SHELL'), z.string()]) }),
}) }) });

async function docker(args, options = {}) {
  const result = await execute('docker', args, options);
  return result.stdout.trim();
}

async function postgresDefinition(directory) {
  const env = { ...process.env, ...ports, DEV_STACK_DIR: directory,
    DEV_STACK_ROOT: process.cwd(), DEV_STACK_UID: String(process.getuid()),
    DEV_STACK_GID: String(process.getgid()) };
  const args = ['compose', '--project-name', 'postgres-readiness-fixture',
    '--env-file', '/dev/null', '-f', 'infra/dev-stack/compose.yaml',
    '-f', 'infra/dev-stack/compose.secondary.yaml', 'config',
    '--no-env-resolution', '--format', 'json'];
  const options = { env };
  const output = await docker(args, options);
  const configuration = JSON.parse(output);
  const definition = definitionSchema.parse(configuration);
  return definition.services.postgres;
}

function followInitialisation(container) {
  const ready = Promise.withResolvers();
  const args = ['logs', '--follow', container];
  const options = { stdio: ['ignore', 'pipe', 'ignore'] };
  const child = spawn('docker', args, options);
  let output = '';
  function received(bytes) {
    output += bytes.toString();
    if (output.includes('INIT_HELD')) ready.resolve();
  }
  function exited() {
    ready.reject(new Error('PostgreSQL exited before initialisation was held'));
  }
  function close() {
    child.kill('SIGTERM');
  }
  child.stdout.on('data', received);
  child.on('error', ready.reject);
  child.on('exit', exited);
  return { ready: ready.promise, close };
}

function probe(container, command) {
  const args = ['exec', container, 'sh', '-c', command];
  const options = { encoding: 'utf8', timeout: 10_000 };
  return spawnSync('docker', args, options).status;
}

async function rejectTemporaryPostgres() {
  const directory = await mkdtemp(join(tmpdir(), 'postgres-readiness-'));
  const name = `postgres-readiness-${randomUUID()}`;
  let logs;
  let container;
  try {
    const definition = await postgresDefinition(directory);
    const script = join(directory, 'hold-init.sh');
    const contents = 'mkfifo /tmp/finish-init\necho INIT_HELD\nread -r release < /tmp/finish-init\n';
    const fileOptions = { mode: 0o644 };
    await writeFile(script, contents, fileOptions);
    const args = ['run', '-d', '--name', name, '--network', 'none', '--cpus', '0.5',
      '-e', 'POSTGRES_PASSWORD=test', '-v', `${script}:/docker-entrypoint-initdb.d/hold.sh:ro`,
      definition.image];
    container = await docker(args);
    logs = followInitialisation(container);
    await logs.ready;
    expect(probe(container, 'pg_isready -U postgres')).toBe(0);
    const configuredProbe = definition.healthcheck.test[1];
    expect(probe(container, configuredProbe)).toBe(2);
    const releaseArgs = ['exec', '--user', 'postgres', container, 'sh', '-c',
      'printf "ready\\n" > /tmp/finish-init'];
    await docker(releaseArgs);
    function finalServerReady() {
      return probe(container, 'pg_isready -h 127.0.0.1 -U postgres') === 0;
    }
    await until(finalServerReady);
    expect(probe(container, configuredProbe)).toBe(0);
  } finally {
    logs?.close();
    if (container) {
      const removeArgs = ['rm', '-f', '-v', container];
      await docker(removeArgs);
    }
    const removeOptions = { recursive: true, force: true };
    await rm(directory, removeOptions);
  }
}

it('keeps the secondary PostgreSQL probe unhealthy during temporary initialisation',
  rejectTemporaryPostgres, 60_000);
