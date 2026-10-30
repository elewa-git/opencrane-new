import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { natsFixture } from '@opencrane/event-store/testing';
import { memoryContextRecordedEventSchema } from '@opencrane/events';

const execute = promisify(execFile);
const imageTag = `private-memory-image-test:${randomUUID()}`;

async function docker(args: string[], timeout = 30_000): Promise<string> {
  const options = { encoding: 'utf8' as const, timeout, maxBuffer: 4 * 1024 * 1024 };
  const result = await execute('/usr/bin/docker', args, options);
  return result.stdout.trim();
}

async function buildImage(): Promise<void> {
  await docker(['build', '-q', '-f', 'infra/package/Dockerfile', '-t', imageTag, '.'], 600_000);
}

async function removeImage(): Promise<void> {
  await docker(['image', 'rm', '-f', imageTag]);
}

beforeAll(buildImage, 610_000);
afterAll(removeImage, 30_000);

async function excludesTests(): Promise<void> {
  const paths = await docker(['run', '--rm', '--network=none', '--read-only', imageTag,
    'find', '/app/apps', '/app/libs', '/app/scripts',
    '-name', 'test', '-o', '-name', 'tests', '-o', '-name', '*.test.*',
    '-o', '-name', '*.spec.*']);
  expect(paths).toBe('');
}

it('keeps repository tests and their private fixtures out of the package image', excludesTests);

async function executesMemoryCheck(name: 'invalidation' | 'unrelatedActivity' | 'requesterIsolation' | 'sessionIsolation'): Promise<void> {
  const fixture = await natsFixture();
  const containerName = `private-memory-image-test-${randomUUID()}`;
  try {
    const settings = fixture.env();
    const directory = dirname(settings.NATS_CA_FILE);
    const hash = createHash('sha256');
    hash.update('test');
    const siloId = `sha256:${hash.digest('hex')}`;
    const source = `
      import { checkMemory } from './scripts/private-memory-qualification/memory-checks.ts';
      import { memoryAdmission } from './apps/server/src/chat/memory-admission.ts';
      import assert from 'node:assert/strict';
      import { mkdirSync } from 'node:fs';
      mkdirSync('/run/memory-keys', { mode: 0o700 });
      await checkMemory(${JSON.stringify(name)}, ${JSON.stringify(siloId)});
      assert.equal(memoryAdmission.state, 'disabled');
      process.stdout.write('memory check completed');
    `;
    // Mount only disposable credentials. Load all executable code from the built image.
    const args = ['run', '--name', containerName, '--network=host', '--read-only',
      '--user', `${process.getuid!()}:${process.getgid!()}`, '--cpus=0.5',
      '--tmpfs', '/run:mode=1777', '--mount', `type=bind,src=${directory},dst=${directory},readonly`,
      '-e', 'SILO_ID=test', '-e', 'MEMORY_KEY_DIRECTORY=/run/memory-keys'];
    for (const [key, value] of Object.entries(settings)) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(imageTag, 'nice', '-n', '10', 'node', '--experimental-strip-types',
      '--input-type=module', '--eval', source);
    const result = await docker(args);
    expect(result).toBe('memory check completed');
    const position = await fixture.store.head();
    const changes: string[] = [];
    let invalidations = 0;
    for (let sequence = 1; sequence <= position; sequence += 1) {
      const row = await fixture.store.readEvent(sequence);
      if (['memory.corrected', 'memory.forgotten'].includes(row.event.type)) {
        changes.push(row.event.type);
      }
      if (row.event.type === 'agent.memory_context_recorded') {
        const event = memoryContextRecordedEventSchema.parse(row.event);
        if (event.data.action === 'invalidated') {
          invalidations += 1;
        }
      }
    }
    expect(changes).toEqual(['memory.corrected', 'memory.forgotten']);
    const expectedInvalidations = name === 'unrelatedActivity' ? 0 : 2;
    expect(invalidations).toBe(expectedInvalidations);
  } finally {
    try {
      await docker(['rm', '-f', '-v', containerName]);
    } finally {
      await fixture.close();
    }
  }
}

it.each(['invalidation', 'unrelatedActivity', 'requesterIsolation', 'sessionIsolation'] as const)(
  'executes %s from the package image against disposable NATS', executesMemoryCheck, 45_000);
