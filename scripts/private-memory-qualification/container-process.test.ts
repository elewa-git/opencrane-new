import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runInContainer } from './container-process.ts';

let containerId: string;
const image = 'node:22.23.1-bookworm-slim';
const descendant = `
  require('node:fs').writeFileSync('/run/fixture-grandchild', 'started');
  setInterval(() => {}, 1000);
`;
const child = `
  const { spawn } = require('node:child_process');
  spawn(process.execPath, ['--eval', ${JSON.stringify(descendant)}, 'fixture-grandchild']);
  setInterval(() => {}, 1000);
`;
const journey = `
  const { spawn } = require('node:child_process');
  const { writeFileSync } = require('node:fs');
  spawn(process.execPath, ['--eval', ${JSON.stringify(child)}, 'fixture-child']);
  writeFileSync('/run/fixture-ready', 'ready');
  setInterval(() => {}, 1000);
`;

function docker(args: string[]): string {
  const options = { encoding: 'utf8' as const, timeout: 20_000, stdio: 'pipe' as const };
  const output = execFileSync('/usr/bin/docker', args, options);
  return output.trim();
}
function startContainer(): void {
  containerId = docker(['run', '-d', '--init', '--network=none', '--read-only',
    '--tmpfs', '/run', '--workdir', '/app', '--cpus=0.5', image, 'sleep', 'infinity']);
}
function removeContainer(): void {
  docker(['rm', '-f', '-v', containerId]);
}
beforeEach(startContainer, 30_000);
afterEach(removeContainer, 30_000);

function processes(): string {
  return docker(['top', containerId, '-eo', 'pid,args']);
}
function isGrandchild(line: string): boolean {
  return line.endsWith('fixture-grandchild');
}
async function waitForDescendants(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = processes();
    const lines = output.split('\n');
    if (lines.some(isGrandchild)) {
      return;
    }
    await delay(100);
  }
  throw new Error('fixture descendants did not start');
}
async function assertNoJourney(): Promise<void> {
  // Allow Docker to finish forwarding stdin closure after the collector dies.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!processes().includes('/usr/local/bin/node')) {
      break;
    }
    await delay(100);
  }
  assertNoRunningJourney();
}
function assertNoRunningJourney(): void {
  const output = processes();
  expect(output).not.toContain('/usr/local/bin/node');
  expect(output).not.toContain('fixture-child');
  expect(output).not.toContain('fixture-grandchild');
}
async function cancelledJourney(source: string): Promise<void> {
  let failed = false;
  try {
    await runInContainer(containerId, ['/usr/local/bin/node', '--eval', source]);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  assertNoRunningJourney();
  docker(['exec', containerId, 'test', '-f', '/run/fixture-grandchild']);
}
async function cancelsTimeout(): Promise<void> {
  await cancelledJourney(journey);
}
it('kills the journey and its descendants before reporting timeout', cancelsTimeout, 140_000);

async function cancelsOverflow(stream: string): Promise<void> {
  const flood = `${journey}\nsetTimeout(() => process.${stream}.write('x'.repeat(70_000)), 1000);`;
  await cancelledJourney(flood);
}
it.each(['stdout', 'stderr'])(
  'kills the journey and descendants on %s overflow', cancelsOverflow, 30_000,
);

async function cancelsCollectorExit(signal: NodeJS.Signals): Promise<void> {
  const moduleUrl = new URL('./container-process.ts', import.meta.url).href;
  const source = `
    import { runInContainer } from ${JSON.stringify(moduleUrl)};
    await runInContainer(${JSON.stringify(containerId)},
      ['/usr/local/bin/node', '--eval', ${JSON.stringify(journey)}]);
  `;
  const options = { stdio: 'ignore' as const };
  const collector = spawn(process.execPath, ['--experimental-strip-types',
    '--input-type=module', '--eval', source], options);
  try {
    await waitForDescendants();
    const retry = "require('node:fs').writeFileSync('/run/retry-started', 'started');";
    await expect(runInContainer(containerId, ['/usr/local/bin/node', '--eval', retry]))
      .rejects.toThrow();
    docker(['exec', containerId, 'test', '!', '-e', '/run/retry-started']);
    const exited = once(collector, 'exit');
    collector.kill(signal);
    await exited;
    await assertNoJourney();
    const result = await runInContainer(containerId, ['/usr/local/bin/node', '--eval',
      'process.stdout.write(JSON.stringify({ complete: true }));']);
    expect(result).toEqual({ complete: true });
  } finally {
    collector.kill('SIGKILL');
  }
}
it.each(['SIGTERM', 'SIGKILL'] as const)(
  'kills the journey and descendants when the collector receives %s', cancelsCollectorExit, 30_000,
);

async function cleansUpSuccessfulJourney(): Promise<void> {
  const complete = `${journey}
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ result: 'PASS' }));
      process.exit(0);
    }, 1000);
  `;
  const result = await runInContainer(containerId, ['/usr/local/bin/node', '--eval', complete]);
  expect(result).toEqual({ result: 'PASS' });
  assertNoRunningJourney();
  docker(['exec', containerId, 'test', '-f', '/run/fixture-grandchild']);
}
it('returns complete output only after stopping leftover children', cleansUpSuccessfulJourney, 30_000);

async function preservesHostRefusal(): Promise<void> {
  const refusal = `${journey}
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ result: 'FAIL', reason: 'host_refused' }));
      process.exit(1);
    }, 1000);
  `;
  const args = ['/usr/local/bin/node', '--eval', refusal];
  const result = await runInContainer(containerId, args);
  const expected = { result: 'FAIL', reason: 'host_refused' };
  expect(result).toEqual(expected);
  assertNoRunningJourney();
  docker(['exec', containerId, 'test', '-f', '/run/fixture-grandchild']);
  docker(['exec', containerId, 'test', '!', '-e', '/run/opencrane-memory-qualification.lock']);
}
it('returns a host refusal only after stopping leftover children', preservesHostRefusal, 30_000);

async function refusesOtherFailedOutput(output: string): Promise<void> {
  const source = `process.stdout.write(${JSON.stringify(output)}); process.exit(1);`;
  const args = ['/usr/local/bin/node', '--eval', source];
  await expect(runInContainer(containerId, args)).rejects.toThrow('container_process_failed');
  assertNoRunningJourney();
}
const failedOutputs = [
  '{"result":"FAIL","reason":"host_refused","protectionFailure":"/private/helper"}',
  '{"result":"FAIL","reason":"host_refused","protectionFailure":null}',
  '{"result":"FAIL","reason":"host_refused","protectionFailure":"helper_unavailable","extra":1}',
  '{"result":"PASS"}',
  '{"result":"FAIL","reason":"journey_failed"}',
  '{"result":"FAIL","reason":"host_refused","private":"/private/setting"}',
  '{"result":"FAIL","reason":"host_refused"',
];
it.each(failedOutputs)(
  'rejects other failed process output %s', refusesOtherFailedOutput, 30_000);

async function forwardsProtectionFailure(protectionFailure: string): Promise<void> {
  const refusal = { result: 'FAIL', reason: 'host_refused', protectionFailure };
  const output = JSON.stringify(refusal);
  const source = `process.stdout.write(${JSON.stringify(output)}); process.exit(1);`;
  const args = ['/usr/local/bin/node', '--eval', source];
  expect(await runInContainer(containerId, args)).toEqual(refusal);
  assertNoRunningJourney();
  docker(['exec', containerId, 'test', '!', '-e', '/run/opencrane-memory-qualification.lock']);
}
it.each(['swap_measurement_failed', 'swap_not_disabled', 'memory_limit_unproved',
  'crash_kernel_unproved', 'core_limit_measurement_failed', 'core_limit_not_zero',
  'dumpability_measurement_failed', 'dumpability_protection_failed', 'process_dumpable',
  'process_identity_changed', 'helper_unavailable', 'core_pattern_unreadable',
  'suid_dumpable_unreadable', 'core_helper_enabled'])(
  'forwards only the fixed protection category %s after cleanup', forwardsProtectionFailure, 30_000);

async function forwardsIncompleteProcessRefusal(): Promise<void> {
  const refusal = { result: 'FAIL', reason: 'host_refused',
    protectionFailure: 'private_process_missing', complete: false };
  const output = JSON.stringify(refusal);
  const source = `process.stdout.write(${JSON.stringify(output)}); process.exit(1);`;
  const args = ['/usr/local/bin/node', '--eval', source];
  expect(await runInContainer(containerId, args)).toEqual(refusal);
  assertNoRunningJourney();
}
it('forwards the incomplete private process refusal after cleanup',
  forwardsIncompleteProcessRefusal, 30_000);
