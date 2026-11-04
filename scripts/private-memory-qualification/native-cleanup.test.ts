import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { z } from 'zod';

interface FixtureProcess {
  start: string;
  status: string;
  children: number[];
}

function cleanupFixture() {
  const processes = new Map<number, FixtureProcess>();
  const wrapper = { start: '100', status: 'S', children: [102] };
  const native = { start: '200', status: 'S', children: [] };
  processes.set(101, wrapper);
  processes.set(102, native);
  const signals: string[] = [];
  let retainProcesses = false;
  function kill(pid: number, signal: string): boolean {
    signals.push(`${pid}:${signal}`);
    const current = processes.get(pid);
    if (current === undefined) {
      const missing = Object.assign(new Error('missing'), { code: 'ESRCH' });
      throw missing;
    }
    if (signal === 'SIGSTOP') {
      current.status = 'T';
    }
    if (signal === 'SIGKILL' && !retainProcesses) {
      processes.delete(pid);
      wrapper.children = [];
    }
    return true;
  }
  function read(path: string): string {
    const pid = Number(path.split('/')[2]);
    const current = processes.get(pid);
    if (current === undefined) {
      const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw missing;
    }
    if (path.endsWith('/children')) {
      return current.children.join(' ');
    }
    assert(path.endsWith('/stat'));
    const fields = Array<string>(20).fill('0');
    fields[0] = current.status;
    fields[1] = '99';
    fields[2] = '88';
    fields[19] = current.start;
    return `${pid} (fixture) ${fields.join(' ')}`;
  }
  function exists(path: string): boolean {
    const pid = Number(path.split('/')[2]);
    return processes.has(pid);
  }
  function killWrapper(signal: string): boolean {
    return kill(101, signal);
  }
  function destroy(): void {
    // Keep this in-memory fixture free of streams and real process signals.
  }
  async function delay(): Promise<void> {
    await Promise.resolve();
  }
  const child = { pid: 101, stdin: { destroy }, kill: killWrapper };
  const state = {
    failed: false, nativePid: 102, wrapperStart: '101:100', nativeStart: '102:200',
    cleanup: undefined as Promise<void> | undefined,
  };
  const supervised = { child, state, stopped: Promise.resolve() };
  const source = readFileSync(new URL('./native-checks.ts', import.meta.url), 'utf8');
  // Execute the real private functions against a simulated Linux process table.
  const withoutImports = source.replace(/^import[\s\S]*?from '[^']+';\n/gmu, '');
  const withoutExports = withoutImports.replace('export async function', 'async function');
  const javascript = stripTypeScriptTypes(withoutExports);
  const context = {
    assert, z, Error, readFileSync: read, existsSync: exists, process: { kill }, delay,
  };
  const functions = runInNewContext(`${javascript}\n({ stopChild });`, context) as {
    stopChild: (value: typeof supervised) => Promise<void>;
  };
  function stop(): Promise<void> {
    return functions.stopChild(supervised);
  }
  function reuse(pid: number): FixtureProcess {
    const replacement = { start: '999', status: 'S', children: [] };
    processes.set(pid, replacement);
    wrapper.children = [];
    return replacement;
  }
  function retain(): void {
    retainProcesses = true;
  }
  return { stop, reuse, signals, processes, retain };
}

async function repeatedCleanup(): Promise<void> {
  const fixture = cleanupFixture();
  await fixture.stop();
  expect(fixture.processes.size).toBe(0);
  const replacementWrapper = fixture.reuse(101);
  const replacementNative = fixture.reuse(102);
  await fixture.stop();
  expect(fixture.processes.get(101)).toBe(replacementWrapper);
  expect(fixture.processes.get(102)).toBe(replacementNative);
  expect(replacementWrapper.status).toBe('S');
  expect(replacementNative.status).toBe('S');
  expect(fixture.signals).toEqual(['101:SIGSTOP', '102:SIGKILL', '101:SIGKILL']);
}
it('leaves reused wrapper and native PIDs alone on a second cleanup', repeatedCleanup);

async function reusedNative(): Promise<void> {
  const fixture = cleanupFixture();
  const replacement = fixture.reuse(102);
  await fixture.stop();
  expect(fixture.processes.get(102)).toBe(replacement);
  expect(replacement.status).toBe('S');
  expect(fixture.processes.has(101)).toBe(false);
  expect(fixture.signals).toEqual(['101:SIGSTOP', '101:SIGKILL']);
}
it('does not kill a retained native PID whose start identity has changed', reusedNative);

async function reusedWrapper(): Promise<void> {
  const fixture = cleanupFixture();
  const replacement = fixture.reuse(101);
  await fixture.stop();
  expect(fixture.processes.get(101)).toBe(replacement);
  expect(replacement.status).toBe('S');
  expect(fixture.processes.has(102)).toBe(false);
  expect(fixture.signals).toEqual(['102:SIGKILL']);
}
it('does not freeze or kill a wrapper PID whose start identity has changed', reusedWrapper);

async function failedCleanup(): Promise<void> {
  const fixture = cleanupFixture();
  fixture.retain();
  await expect(fixture.stop()).rejects.toThrow('native_cleanup_failed');
  const replacementWrapper = fixture.reuse(101);
  const replacementNative = fixture.reuse(102);
  await expect(fixture.stop()).rejects.toThrow('native_cleanup_failed');
  expect(fixture.processes.get(101)).toBe(replacementWrapper);
  expect(fixture.processes.get(102)).toBe(replacementNative);
  expect(replacementWrapper.status).toBe('S');
  expect(replacementNative.status).toBe('S');
  expect(fixture.signals).toEqual(['101:SIGSTOP', '102:SIGKILL', '101:SIGKILL']);
}
it('retains a failed cleanup result without signalling reused PIDs again', failedCleanup);
