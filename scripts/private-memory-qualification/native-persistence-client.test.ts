import { ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { startNativePersistenceClient } from './native-persistence-client.ts';

vi.mock('node:child_process', { spy: true });

async function unconfirmedStopMustFail(): Promise<void> {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  vi.mocked(spawn).mockReturnValueOnce(child);
  queueMicrotask(function ready(): void {
    stdout.write('{"ready":true}\n');
  });
  const client = await startNativePersistenceClient('a'.repeat(64), 'challenge');
  stdin.once('finish', function closed(): void {
    child.emit('close', 1, null);
  });
  stdin.once('data', function interrupted(): void {
    child.emit('close', 1, null);
  });
  await expect(client.stop()).rejects.toThrow('native_persistence_stop_failed');
}

it('refuses Stop when the remote runner exits nonzero without cleanup proof',
  unconfirmedStopMustFail);

async function transportErrorMustFail(): Promise<void> {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  vi.mocked(spawn).mockReturnValueOnce(child);
  queueMicrotask(function ready(): void {
    stdout.write('{"ready":true}\n');
  });
  const client = await startNativePersistenceClient('a'.repeat(64), 'challenge');
  child.emit('error', new Error('transport lost'));
  await expect(client.stop()).rejects.toThrow('native_persistence_transport_failed');
}

it('reports transport loss separately from failed remote termination',
  transportErrorMustFail);

async function confirmedStopSucceeds(): Promise<void> {
  const child = new ChildProcess();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, { stdin, stdout, stderr });
  vi.mocked(spawn).mockReturnValueOnce(child);
  queueMicrotask(function ready(): void {
    stdout.write('{"ready":true}\n');
  });
  const client = await startNativePersistenceClient('a'.repeat(64), 'challenge');
  stdin.once('data', function confirm(): void {
    stdout.write('{"stopped":true}\n');
  });
  stdin.once('finish', function closed(): void {
    child.emit('close', 0, null);
  });
  await expect(client.stop()).resolves.toBeUndefined();
}

it('accepts Stop only after remote cleanup proof and clean runner exit',
  confirmedStopSucceeds);

function nativeRunnerIsPackaged(): void {
  const dockerfile = readFileSync('apps/computer/Dockerfile', 'utf8');
  expect(dockerfile).toContain('scripts/private-memory-qualification/native-checks.ts');
  expect(dockerfile).toContain('scripts/private-memory-qualification/native-persistence.ts');
}

it('packages the native runner and its check into the computer image',
  nativeRunnerIsPackaged);
