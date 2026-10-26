import * as processes from 'node:child_process';
import * as files from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { provisionRecoveryEventTarget } from '../../../infra/package/recovery-event-target.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('node:fs/promises', { spy: true });

const targets: Awaited<ReturnType<typeof provisionRecoveryEventTarget>>[] = [];

async function clean() {
  const createdDirectories = [...vi.mocked(files.mkdtemp).mock.results];
  vi.restoreAllMocks();
  for (const target of targets.splice(0)) {
    await target.close();
  }
  for (const result of createdDirectories) {
    if (result.type !== 'return') continue;
    let directory: string | Buffer;
    try {
      directory = await result.value;
    } catch {
      // Allow a deliberately failed directory creation to reject during test cleanup.
      continue;
    }
    await files.rm(directory, { recursive: true, force: true });
  }
}
afterEach(clean);

async function hidesPrivateArguments() {
  const target = await provisionRecoveryEventTarget('test');
  targets.push(target);
  const directory = await vi.mocked(files.mkdtemp).mock.results[0]!.value;
  const configuration = vi.mocked(files.writeFile).mock.calls[0]![1];
  expect(typeof configuration).toBe('string');
  const token = /"token":"([a-f0-9]+)"/.exec(String(configuration))?.[1];
  expect(token).toHaveLength(64);
  expect(processes.spawn).toHaveBeenCalledTimes(1);
  const spawnArguments = JSON.stringify(vi.mocked(processes.spawn).mock.calls[0]!.slice(0, 2));
  expect(spawnArguments).not.toContain(directory);
  expect(spawnArguments).not.toContain(token);
  expect(target.connection.isClosed()).toBe(false);
}
it('starts a usable NATS target without private paths or tokens in argv', hidesPrivateArguments);
