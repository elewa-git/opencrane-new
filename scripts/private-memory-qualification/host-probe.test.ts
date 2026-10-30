import { readFileSync, readdirSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeHost } from './host-probe.ts';

vi.mock('node:fs', { spy: true });
const zeroLimits = 'Max core file size        0                    0                    bytes\n';
let files: Map<string, string>;
function read(path: unknown): string {
  const value = files.get(String(path));
  if (value === undefined) throw new Error('private observation unavailable');
  return value;
}
function prepare(): void {
  files = new Map([
    ['/proc/swaps', 'Filename\tType\tSize\tUsed\tPriority\n'],
    ['/proc/sys/kernel/core_pattern', '\n'],
    ['/proc/sys/kernel/core_uses_pid', '0\n'],
    ['/proc/sys/fs/suid_dumpable', '0\n'],
    ['/sys/kernel/kexec_crash_loaded', '0\n'],
    ['/proc/self/limits', zeroLimits],
    ['/proc/1/limits', zeroLimits],
    ['/proc/2/limits', zeroLimits],
    ['/proc/3/limits', zeroLimits],
  ]);
  vi.mocked(readFileSync).mockImplementation(read);
  // Represent server, bridge and proxy processes without reading their arguments or data.
  vi.mocked(readdirSync).mockReturnValue(['1', '2', '3', 'self'] as never);
}
beforeEach(prepare);

function safeHost(): void {
  expect(probeHost()).toBe(true);
  for (const path of files.keys()) expect(readFileSync).toHaveBeenCalledWith(path, 'utf8');
}
it('passes only the host probe with disabled swap, dumps and all visible core limits', safeHost);

const unsafe: [string, string][] = [
  ['/proc/swaps', 'Filename Type Size Used Priority\n/private/swap file 1 0 -2\n'],
  ['/proc/swaps', ''],
  ['/proc/swaps', 'unknown\n'],
  ['/proc/sys/kernel/core_pattern', '|/private/collector %p\n'],
  ['/proc/sys/kernel/core_pattern', 'core\n'],
  ['/proc/sys/kernel/core_pattern', ' \n'],
  ['/proc/sys/kernel/core_uses_pid', '1\n'],
  ['/proc/sys/fs/suid_dumpable', '2\n'],
  ['/sys/kernel/kexec_crash_loaded', '1\n'],
  ['/proc/self/limits', 'Max core file size 0 unlimited bytes\n'],
  ['/proc/1/limits', 'Max core file size unlimited unlimited bytes\n'],
  ['/proc/2/limits', 'Max core file size 0 1 bytes\n'],
  ['/proc/3/limits', 'Max core file size 1 0 bytes\n'],
  ['/proc/3/limits', `${zeroLimits}${zeroLimits}`],
  ['/proc/3/limits', ''],
];
function refusesUnsafe(path: string, value: string): void {
  files.set(path, value);
  expect(probeHost()).toBe(false);
}
it.each(unsafe)('refuses unsafe or unknown observation %s: %s', refusesUnsafe);

function refusesUnreadable(path: string): void {
  files.delete(path);
  expect(probeHost()).toBe(false);
}
it.each(['/proc/swaps', '/proc/sys/kernel/core_pattern', '/proc/sys/kernel/core_uses_pid',
  '/proc/sys/fs/suid_dumpable', '/sys/kernel/kexec_crash_loaded', '/proc/self/limits',
  '/proc/1/limits', '/proc/2/limits', '/proc/3/limits'])(
  'refuses an unreadable observation at %s', refusesUnreadable);

function refusesProcessList(entries: string[]): void {
  vi.mocked(readdirSync).mockReturnValue(entries as never);
  expect(probeHost()).toBe(false);
}
it.each([[[]], [['self']], [['../private']], [['1', '../../private']]])(
  'refuses an incomplete or injected process list %j', refusesProcessList);
