import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runInContainer } from './container-process.ts';

let containerId: string;
const image = 'node:22.23.1-bookworm-slim';
const descendant = `setInterval(() => {}, 1000);`;
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
  return execFileSync('/usr/bin/docker', args, options).trim();
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
    const lines = processes().split('\n');
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
  expect(processes()).not.toContain('/usr/local/bin/node');
  expect(processes()).not.toContain('fixture-child');
  expect(processes()).not.toContain('fixture-grandchild');
}
async function cancelledJourney(source: string): Promise<void> {
  let failed = false;
  try {
    await runInContainer(containerId, ['/usr/local/bin/node', '--eval', source]);
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
  await assertNoJourney();
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
  const collector = spawn(process.execPath, ['--experimental-strip-types',
    '--input-type=module', '--eval', source], { stdio: 'ignore' });
  try {
    await waitForDescendants();
    const exited = once(collector, 'exit');
    collector.kill(signal);
    await exited;
    await assertNoJourney();
  } finally {
    collector.kill('SIGKILL');
  }
}
it.each(['SIGTERM', 'SIGKILL'] as const)(
  'kills the journey and descendants when the collector receives %s', cancelsCollectorExit, 30_000,
);
