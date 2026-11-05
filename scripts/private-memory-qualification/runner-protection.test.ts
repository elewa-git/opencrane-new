import { createRequire } from 'node:module';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('node:module', { spy: true });
let loaded: unknown;
let protectedResult: unknown;
let checkedResult: unknown;
function protect(): unknown {
  return protectedResult;
}
function check(): unknown {
  return checkedResult;
}
function load(): unknown {
  return loaded;
}
function prepare(): void {
  vi.resetModules();
  protectedResult = true;
  checkedResult = true;
  loaded = { protect, check };
  const require = Object.assign(load, createRequire(import.meta.url));
  vi.mocked(createRequire).mockReturnValue(require);
}
beforeEach(prepare);
async function preservesNativeFailure(failure: string): Promise<void> {
  checkedResult = failure;
  const { runnerProtected } = await import('./runner-protection.ts');
  expect(runnerProtected()).toBe(failure);
}
it.each(['core_limit_measurement_failed', 'core_limit_not_zero',
  'dumpability_measurement_failed', 'process_dumpable', 'process_identity_changed'])(
  'preserves the native helper failure %s', preservesNativeFailure);
async function refusesProtectionFailure(): Promise<void> {
  protectedResult = 'dumpability_protection_failed';
  const { runnerProtected } = await import('./runner-protection.ts');
  expect(runnerProtected()).toBe('dumpability_protection_failed');
  protectedResult = true;
  expect(runnerProtected()).toBe('dumpability_protection_failed');
}
it('retains failed dump protection without trying to repair it', refusesProtectionFailure);
async function refusesMissingHelper(value: unknown): Promise<void> {
  loaded = value;
  const { runnerProtected } = await import('./runner-protection.ts');
  expect(runnerProtected()).toBe('helper_unavailable');
}
it.each([null, {}, { protect }, { check }])(
  'names an unavailable or malformed helper %#', refusesMissingHelper);
async function refusesInvalidResult(value: unknown): Promise<void> {
  checkedResult = value;
  const { runnerProtected } = await import('./runner-protection.ts');
  expect(runnerProtected()).toBe('helper_unavailable');
}
it.each([false, 1, 'true', '/private/helper', null])(
  'refuses a helper result outside the allowlist %#', refusesInvalidResult);
async function refusesThrownCall(): Promise<void> {
  function unavailable(): never {
    throw new Error('/private/helper');
  }
  loaded = { protect, check: unavailable };
  const { runnerProtected } = await import('./runner-protection.ts');
  expect(runnerProtected()).toBe('helper_unavailable');
}
it('sanitises a thrown helper error', refusesThrownCall);
async function measuresWithoutRepair(): Promise<void> {
  const { runnerProtected } = await import('./runner-protection.ts');
  expect(runnerProtected()).toBe(true);
  protectedResult = 'dumpability_protection_failed';
  checkedResult = 'process_dumpable';
  expect(runnerProtected()).toBe('process_dumpable');
}
it('checks protection again without resetting dumpability', measuresWithoutRepair);
