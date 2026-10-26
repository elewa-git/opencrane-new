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
  vi.resetAllMocks();
  for (const target of targets.splice(0)) {
    await target.connection.close();
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

const refusal = new Error('Recovery event target refused');
const cleanupRefusal = new Error('Recovery event target cleanup refused');

function filesystemFailure(code: string) {
  const error = new Error(`${code}: '/private/recovery-path-canary'`);
  return Object.assign(error, { code });
}

async function createdDirectory() {
  const directory = await vi.mocked(files.mkdtemp).mock.results[0]!.value;
  if (typeof directory !== 'string') throw new Error('Expected a fixture directory');
  return directory;
}

async function refusesDirectoryFailure(code: string) {
  vi.mocked(files.mkdtemp).mockRejectedValueOnce(filesystemFailure(code));
  await expect(provisionRecoveryEventTarget('test')).rejects.toEqual(refusal);
  expect(processes.spawn).not.toHaveBeenCalled();
  expect(files.rm).not.toHaveBeenCalled();
}
it.each(['ENOSPC', 'EACCES'])('withholds the path when directory creation fails: %s',
  refusesDirectoryFailure);

async function refusesConfigurationFailure(code: string) {
  vi.mocked(files.writeFile).mockRejectedValueOnce(filesystemFailure(code));
  await expect(provisionRecoveryEventTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  expect(processes.spawn).not.toHaveBeenCalled();
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  await expect(files.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(['ENOSPC', 'EACCES'])('withholds the path and removes failed configuration: %s',
  refusesConfigurationFailure);

async function preservesConfigurationRefusal() {
  vi.mocked(files.writeFile).mockRejectedValueOnce(filesystemFailure('ENOSPC'));
  vi.mocked(files.rm).mockRejectedValueOnce(filesystemFailure('EACCES'));
  await expect(provisionRecoveryEventTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  expect(processes.spawn).not.toHaveBeenCalled();
}
it('keeps the setup refusal when directory cleanup also fails', preservesConfigurationRefusal);

async function preservesStartupRefusal() {
  vi.mocked(files.rm).mockRejectedValue(filesystemFailure('EACCES'));
  await expect(provisionRecoveryEventTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  expect(files.rm).toHaveBeenCalledWith(`${directory}/server.conf`);
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  const child = vi.mocked(processes.spawn).mock.results[0]!.value;
  expect(child.signalCode).toBe('SIGKILL');
}
it('keeps the startup refusal and stops NATS when both removals fail', preservesStartupRefusal);

async function refusesDirectoryCleanup() {
  const target = await provisionRecoveryEventTarget('test');
  targets.push(target);
  const directory = await createdDirectory();
  vi.mocked(files.rm).mockRejectedValueOnce(filesystemFailure('EACCES'));
  await expect(target.close()).rejects.toEqual(cleanupRefusal);
  expect(target.connection.isClosed()).toBe(true);
  const child = vi.mocked(processes.spawn).mock.results[0]!.value;
  expect(child.signalCode).toBe('SIGKILL');
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
}
it('withholds the private path when explicit directory cleanup fails', refusesDirectoryCleanup);

async function cleansAfterConnectionFailure() {
  const target = await provisionRecoveryEventTarget('test');
  targets.push(target);
  const directory = await createdDirectory();
  vi.spyOn(target.connection, 'close').mockRejectedValueOnce(filesystemFailure('EACCES'));
  await expect(target.close()).rejects.toEqual(cleanupRefusal);
  const child = vi.mocked(processes.spawn).mock.results[0]!.value;
  expect(child.signalCode).toBe('SIGKILL');
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  await expect(files.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
it('still stops NATS and removes its files after a connection close failure',
  cleansAfterConnectionFailure);
