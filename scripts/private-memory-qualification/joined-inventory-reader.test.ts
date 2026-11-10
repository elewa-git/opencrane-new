import { execFileSync } from 'node:child_process';
import { beforeEach, expect, it, vi } from 'vitest';
import { readCurrentInventory, type InventoryContext } from './joined-inventory.ts';

vi.mock('node:child_process', { spy: true });

const serverId = 'a'.repeat(64);
const computerId = 'b'.repeat(64);
const serverInstallationId = `sha256:${'c'.repeat(64)}`;
const computerInstallationId = `sha256:${'d'.repeat(64)}`;
const context: InventoryContext = {
  serverInstallationId,
  computerInstallationId,
  serverImageDigest: `sha256:${'e'.repeat(64)}`,
  computerImageDigest: `sha256:${'f'.repeat(64)}`,
  challengeId: '11111111-1111-4111-8111-111111111111',
  generationId: computerInstallationId,
  helperIds: ['11111111-1111-4111-8111-111111111111'],
};
const probeReply = Buffer.from(JSON.stringify({
  pid: 100, startTime: '1000', pidNamespace: 'pid:[4026531836]',
  executable: '/usr/local/bin/node', uid: 1000, cgroup: '0::/test\n',
  protected: true,
}));

beforeEach(function resetDockerMock(): void {
  vi.mocked(execFileSync).mockReset();
  vi.mocked(execFileSync).mockReturnValue(probeReply);
});

function refusesInvalidContainerId(which: 'serverId' | 'computerId'): void {
  const containers = { serverId, computerId, [which]: 'untrusted-container-name' };
  expect(function readInvalidContainer(): void {
    readCurrentInventory(context, containers);
  }).toThrow();
  expect(execFileSync).not.toHaveBeenCalled();
}
it.each(['serverId', 'computerId'] as const)(
  'refuses an invalid %s before starting Docker', refusesInvalidContainerId);

function usesBoundedFixedDockerCommand(): void {
  readCurrentInventory(context, { serverId, computerId });
  expect(execFileSync).toHaveBeenCalledTimes(7);
  for (const [binary, args, options] of vi.mocked(execFileSync).mock.calls) {
    expect(binary).toBe('/usr/bin/docker');
    expect(args).toContain('--host');
    expect(args).toContain('unix:///var/run/docker.sock');
    expect(args).toContain('/usr/local/bin/node');
    expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 4096, stdio: 'pipe' });
  }
}
it('runs each live probe through the fixed Docker binary with bounds',
  usesBoundedFixedDockerCommand);
