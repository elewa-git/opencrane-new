import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { checkBridge, checkProxy } from './bridge-check.ts';
import { checkSupervisor } from './supervisor-check.ts';
import { checkLiveService, readProcessIdentity, serverIdentity } from './private-processes.ts';
import { probeInventoryProcess } from './live-inventory-probe.ts';
import { joinInventory, readCurrentInventory, type InventoryContext } from './joined-inventory.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('./bridge-check.ts', { spy: true });
vi.mock('./supervisor-check.ts', { spy: true });
vi.mock('./private-processes.ts', { spy: true });

const serverId = 'a'.repeat(64);
const computerId = 'b'.repeat(64);
const context: InventoryContext = {
  serverInstallationId: `sha256:${'c'.repeat(64)}`,
  computerInstallationId: `sha256:${'d'.repeat(64)}`,
  serverImageDigest: `sha256:${'e'.repeat(64)}`,
  computerImageDigest: `sha256:${'f'.repeat(64)}`,
  challengeId: '11111111-1111-4111-8111-111111111111',
  generationId: `sha256:${'d'.repeat(64)}`,
  helperIds: ['22222222-2222-4222-8222-222222222222'],
};
const identity = {
  pid: 123, startTime: '456', containerIdentity: 'pid:[4026531836]',
  executable: '/usr/local/bin/node', uid: 1000, cgroup: '0::/test\n', commandLine: 'node\0',
};

beforeEach(function resetProbes(): void {
  vi.mocked(checkBridge).mockReset();
  vi.mocked(checkProxy).mockReset();
  vi.mocked(checkSupervisor).mockReset();
  vi.mocked(checkLiveService).mockReset();
  vi.mocked(serverIdentity).mockReset();
  vi.mocked(readProcessIdentity).mockReset();
  vi.mocked(execFileSync).mockReset();
  vi.mocked(serverIdentity).mockReturnValue(identity);
  vi.mocked(checkLiveService).mockReturnValue(true);
  function proveBridge(observeIdentity?: (value: typeof identity) => void) {
    observeIdentity?.(identity);
    return { result: true as const, pid: 123, startTime: '456' };
  }
  function proveSupervisor(observeIdentity?: (value: typeof identity) => void) {
    observeIdentity?.({ ...identity, pid: 1 });
    return { result: true as const, pid: 1, startTime: '456' };
  }
  vi.mocked(checkBridge).mockImplementation(proveBridge);
  vi.mocked(checkProxy).mockImplementation(proveBridge);
  vi.mocked(checkSupervisor).mockImplementation(proveSupervisor);
  function readIdentity(pid: number): typeof identity {
    return { ...identity, pid };
  }
  vi.mocked(readProcessIdentity).mockImplementation(readIdentity);
});

function callsRealProbes(): void {
  expect(probeInventoryProcess('serverDelivery')).toMatchObject({ pid: 123 });
  expect(serverIdentity).toHaveBeenCalledOnce();
  expect(checkLiveService).toHaveBeenCalledWith('serverDelivery', identity);
  expect(probeInventoryProcess('supervisor')).toMatchObject({ pid: 1 });
  expect(checkSupervisor).toHaveBeenCalledOnce();
  expect(probeInventoryProcess('bridge')).toMatchObject({ pid: 123 });
  expect(checkBridge).toHaveBeenCalledOnce();
  expect(probeInventoryProcess('proxy')).toMatchObject({ pid: 123 });
  expect(checkProxy).toHaveBeenCalledOnce();
}
it('asks each existing live service probe for its process', callsRealProbes);

function refusesUnprotectedProcess(): void {
  vi.mocked(checkLiveService).mockReturnValue('process_dumpable');
  expect(probeInventoryProcess('serverDelivery')).toBeUndefined();
  vi.mocked(checkBridge).mockReturnValue({ result: 'private_process_missing' });
  expect(probeInventoryProcess('bridge')).toBeUndefined();
}
it('does not report a process whose live protection probe refused', refusesUnprotectedProcess);

function refusesExecAfterComputerProof(group: 'supervisor' | 'bridge' | 'proxy'): void {
  const replacement = { ...identity, executable: '/usr/bin/other', uid: 1001,
    cgroup: '0::/other\n', containerIdentity: 'pid:[4026531999]',
    commandLine: '/usr/bin/other\0' };
  function replacedIdentity(pid: number): typeof identity {
    return { ...replacement, pid };
  }
  vi.mocked(readProcessIdentity).mockImplementation(replacedIdentity);
  expect(probeInventoryProcess(group)).toBeUndefined();
}
it.each(['supervisor', 'bridge', 'proxy'] as const)(
  'refuses %s when exec changes the image after protection was checked',
  refusesExecAfterComputerProof,
);

function readsBoundContainers(): void {
  const observed: string[] = [];
  function docker(_binary: unknown, args: unknown): string {
    const command = z.array(z.string()).parse(args);
    observed.push(`${command[11]}:${command.at(-1)}`);
    const group = command.at(-1);
    const pid = group === 'supervisor' ? 1 : 123;
    return JSON.stringify({ pid, startTime: '456',
      pidNamespace: group === 'serverDelivery' ? 'pid:[4026531836]' : 'pid:[4026531837]',
      protected: true });
  }
  vi.mocked(execFileSync).mockImplementation(docker);
  const first = readCurrentInventory(context, { serverId, computerId });
  const final = readCurrentInventory(context, { serverId, computerId });
  expect(first.records).toHaveLength(4);
  expect(final.records).toHaveLength(4);
  expect(joinInventory(context, first, final)).toEqual({ ok: false, group: 'nativeWrapper' });
  expect(observed).toEqual([
    `${serverId}:serverDelivery`, `${computerId}:supervisor`, `${computerId}:bridge`,
    `${computerId}:proxy`, `${serverId}:serverDelivery`, `${computerId}:supervisor`,
    `${computerId}:bridge`, `${computerId}:proxy`,
  ]);
}
it('reads the four live services twice from the bound installation', readsBoundContainers);

function runsProbeAtInstalledComputerPath(): void {
  const dockerfile = readFileSync(new URL('../../apps/computer/Dockerfile', import.meta.url), 'utf8');
  const source = 'scripts/private-memory-qualification/live-inventory-probe.ts';
  const installedPath = '/scripts/private-memory-qualification/live-inventory-probe.ts';
  const copyInstruction = [`COPY --from=project ${source} \\`, `  ${installedPath}`].join('\n');
  expect(dockerfile).toContain(copyInstruction);
  function docker(_binary: unknown, args: unknown): string {
    const command = z.array(z.string()).parse(args);
    expect(command).toContain(installedPath);
    return JSON.stringify({ pid: 123, startTime: '456',
      pidNamespace: 'pid:[4026531836]', protected: true });
  }
  vi.mocked(execFileSync).mockImplementation(docker);
  readCurrentInventory(context, { serverId, computerId });
}
it('runs the live probe at the path installed in the computer image',
  runsProbeAtInstalledComputerPath);

function refusesUnmeasuredOutput(): void {
  function docker(): string {
    return JSON.stringify({ pid: 123, startTime: '456',
      pidNamespace: 'pid:[4026531836]', protected: false });
  }
  vi.mocked(execFileSync).mockImplementation(docker);
  expect(() => readCurrentInventory(context, { serverId, computerId })).toThrow();
  expect(execFileSync).toHaveBeenCalledOnce();
}
it('refuses a process without a measured protection result', refusesUnmeasuredOutput);
