import * as processes from 'node:child_process';
import * as files from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { provisionDisposableObjectTarget } from '../../../infra/package/disposable-object-target.ts';

async function processModule(importOriginal: () => Promise<typeof processes>) {
  const actual = await importOriginal();
  const utilities = await import('node:util');
  const execute = vi.fn(utilities.promisify(actual.execFile));
  const execFile = actual.execFile.bind(actual);
  Object.defineProperty(execFile, utilities.promisify.custom, { value: execute });
  return { ...actual, execFile };
}
vi.mock('node:child_process', processModule);
vi.mock('node:fs/promises', { spy: true });

const execute = vi.mocked(promisify(processes.execFile));

async function clean() {
  const createdDirectories = [...vi.mocked(files.mkdtemp).mock.results];
  const commands = [...execute.mock.calls];
  vi.restoreAllMocks();
  vi.resetAllMocks();
  const actual = await vi.importActual<typeof processes>('node:child_process');
  const cleanContainer = promisify(actual.execFile);
  for (const command of commands) {
    const args = command[1];
    if (!args || args[0] !== 'run') {
      continue;
    }
    const nameIndex = args.indexOf('--name');
    const name = args[nameIndex + 1];
    if (nameIndex >= 0 && name) {
      await cleanContainer('docker', ['rm', '-f', '-v', name]);
    }
  }
  for (const result of createdDirectories) {
    if (result.type !== 'return') {
      continue;
    }
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

const refusal = new Error('Disposable storage provisioning refused');
const cleanupRefusal = new Error('Disposable storage cleanup refused');

function filesystemFailure(code: string) {
  const error = new Error(`${code}: '/private/object-target-path-canary'`);
  return Object.assign(error, { code });
}

function failDocker(): never {
  throw filesystemFailure('EACCES');
}

async function createdDirectory() {
  const result = vi.mocked(files.mkdtemp).mock.results[0];
  if (!result || result.type !== 'return') {
    throw new Error('Expected directory creation to return a promise');
  }
  const directory = await result.value;
  if (typeof directory !== 'string') {
    throw new Error('Expected a fixture directory');
  }
  return directory;
}

function expectContainerRemoval(name: string) {
  expect(execute).toHaveBeenCalledWith('docker', ['rm', '-f', '-v', name],
    expect.any(Object));
}

async function hidesPrivateArguments() {
  const target = await provisionDisposableObjectTarget('test');
  const directory = await createdDirectory();
  expect(await target.client.bucketExists('opencrane-restore')).toBe(true);
  const environment = vi.mocked(files.writeFile).mock.calls[0]![1];
  expect(typeof environment).toBe('string');
  if (typeof environment !== 'string') {
    throw new Error('Expected fixture environment text');
  }
  const credentials = environment.trim().split('\n');
  for (const command of execute.mock.calls) {
    const argumentsText = JSON.stringify(command.slice(0, 2));
    expect(argumentsText).not.toContain(directory);
    for (const credential of credentials) {
      const value = credential.split('=')[1];
      expect(value).toBeTruthy();
      expect(argumentsText).not.toContain(value);
    }
  }
  const launch = execute.mock.calls[0]!;
  expect(launch[1]).toContain('environment');
  expect(launch[2]).toMatchObject({ cwd: directory });
  await expect(files.stat(`${directory}/environment`)).rejects.toMatchObject({ code: 'ENOENT' });
  await target.close();
  expectContainerRemoval(target.name);
  await expect(files.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
it('starts usable storage without private paths or credentials in Docker argv',
  hidesPrivateArguments, 60_000);

async function refusesDirectoryFailure(code: string) {
  vi.mocked(files.mkdtemp).mockRejectedValueOnce(filesystemFailure(code));
  await expect(provisionDisposableObjectTarget('test')).rejects.toEqual(refusal);
  expect(execute).not.toHaveBeenCalled();
  expect(files.rm).not.toHaveBeenCalled();
}
it.each(['ENOSPC', 'EACCES'])('withholds the path when directory creation fails: %s',
  refusesDirectoryFailure);

async function refusesEnvironmentFailure(code: string) {
  vi.mocked(files.writeFile).mockRejectedValueOnce(filesystemFailure(code));
  await expect(provisionDisposableObjectTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  expect(execute).not.toHaveBeenCalled();
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  await expect(files.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
}
it.each(['ENOSPC', 'EACCES'])('withholds the path and removes failed environment files: %s',
  refusesEnvironmentFailure);

async function preservesEnvironmentRefusal() {
  vi.mocked(files.writeFile).mockRejectedValueOnce(filesystemFailure('ENOSPC'));
  vi.mocked(files.rm).mockRejectedValueOnce(filesystemFailure('EACCES'));
  await expect(provisionDisposableObjectTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  expect(execute).not.toHaveBeenCalled();
}
it('keeps the setup refusal when directory cleanup also fails', preservesEnvironmentRefusal);

async function preservesStartupRefusal() {
  vi.mocked(files.rm).mockRejectedValue(filesystemFailure('EACCES'));
  await expect(provisionDisposableObjectTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  const launch = execute.mock.calls[0]![1];
  if (!launch) {
    throw new Error('Expected Docker launch arguments');
  }
  const name = launch[launch.indexOf('--name') + 1]!;
  expectContainerRemoval(name);
  expect(files.rm).toHaveBeenCalledWith(`${directory}/environment`);
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
}
it('keeps the startup refusal and removes the container when both file removals fail',
  preservesStartupRefusal);

async function preservesRefusalWithAllCleanupFailures() {
  const actual = await vi.importActual<typeof processes>('node:child_process');
  execute.mockImplementationOnce(promisify(actual.execFile));
  execute.mockImplementationOnce(failDocker);
  execute.mockImplementationOnce(failDocker);
  vi.mocked(files.rm).mockResolvedValueOnce(undefined);
  vi.mocked(files.rm).mockRejectedValueOnce(filesystemFailure('EACCES'));
  await expect(provisionDisposableObjectTarget('test')).rejects.toEqual(refusal);
  const directory = await createdDirectory();
  expect(execute).toHaveBeenCalledTimes(3);
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
}
it('keeps the provisioning refusal when Docker fails and both cleanup steps also fail',
  preservesRefusalWithAllCleanupFailures);

async function refusesDirectoryCleanup() {
  const target = await provisionDisposableObjectTarget('test');
  const directory = await createdDirectory();
  vi.mocked(files.rm).mockRejectedValueOnce(filesystemFailure('EACCES'));
  await expect(target.close()).rejects.toEqual(cleanupRefusal);
  expectContainerRemoval(target.name);
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
}
it('withholds the private path when explicit directory cleanup fails', refusesDirectoryCleanup,
  60_000);

async function refusesContainerCleanup(directoryFails: boolean) {
  const target = await provisionDisposableObjectTarget('test');
  const directory = await createdDirectory();
  execute.mockImplementationOnce(failDocker);
  if (directoryFails) {
    vi.mocked(files.rm).mockRejectedValueOnce(filesystemFailure('EACCES'));
  }
  await expect(target.close()).rejects.toEqual(cleanupRefusal);
  expectContainerRemoval(target.name);
  expect(files.rm).toHaveBeenCalledWith(directory, { recursive: true, force: true });
  if (!directoryFails) {
    await expect(files.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}
it.each([false, true])('still attempts file cleanup after Docker close fails (files fail: %s)',
  refusesContainerCleanup, 60_000);
