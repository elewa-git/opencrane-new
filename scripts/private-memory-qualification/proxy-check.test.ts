import { beforeEach, expect, it, vi } from 'vitest';
import { bridgeIdentity, checkLiveService, readProcessIdentity } from './private-processes.ts';
import { probeContainer } from './container-probe.ts';
import { checkProxy } from './proxy-check.ts';

vi.mock('./private-processes.ts', { spy: true });
vi.mock('./container-probe.ts', { spy: true });

const identity = {
  pid: 24, startTime: '123', executable: '/usr/local/bin/node', uid: 1000,
  cgroup: '0::/computer\n', containerIdentity: 'pid:[123]',
  commandLine: '/usr/local/bin/node\0--disable-sigusr1\0' +
    '--experimental-strip-types\0/app/src/bridge.ts\0',
};
const inspector = { ...identity, pid: 51, uid: 0 };

function prepare(): void {
  vi.clearAllMocks();
  vi.mocked(bridgeIdentity).mockReturnValue(identity);
  vi.mocked(readProcessIdentity).mockReturnValue(inspector);
  vi.mocked(probeContainer).mockReturnValue(true);
  vi.mocked(checkLiveService).mockReturnValue(true);
}
beforeEach(prepare);

function acceptsMeasuredProxy(): void {
  expect(checkProxy()).toEqual({ result: true, pid: 24, startTime: '123' });
  expect(vi.mocked(checkLiveService)).toHaveBeenCalledWith('proxy', identity);
  expect(vi.mocked(bridgeIdentity)).toHaveBeenCalledTimes(3);
  expect(vi.mocked(probeContainer)).toHaveBeenCalledTimes(2);
}
it('proves only the live proxy group in a held native request', acceptsMeasuredProxy);

function missingProxy(): void {
  vi.mocked(bridgeIdentity).mockReturnValue(undefined);
  expect(checkProxy()).toEqual({ result: 'private_process_missing' });
}
it('refuses a missing proxy process', missingProxy);

function wrongIdentity(): void {
  const bad = [
    { ...identity, executable: '/tmp/node' },
    { ...identity, uid: 1003 },
    { ...identity, startTime: '124' },
    { ...identity, containerIdentity: 'pid:[999]' },
    { ...identity, cgroup: '0::/foreign\n' },
    { ...identity, commandLine: '/usr/local/bin/node\0/tmp/stand-in.ts\0' },
  ];
  for (const candidate of bad) {
    vi.mocked(bridgeIdentity).mockReturnValue(candidate);
    expect(checkProxy()).toEqual({ result: 'private_process_identity_changed' });
  }
}
it('refuses wrong executable, UID, start, namespace, group and script', wrongIdentity);

function changedOrVanished(): void {
  vi.mocked(bridgeIdentity).mockReturnValueOnce(identity).mockReturnValueOnce(undefined);
  expect(checkProxy()).toEqual({ result: 'private_process_identity_changed' });
  prepare();
  vi.mocked(bridgeIdentity).mockReturnValueOnce(identity)
    .mockReturnValueOnce({ ...identity, startTime: '124' });
  expect(checkProxy()).toEqual({ result: 'private_process_identity_changed' });
}
it('refuses a vanished or reused process during inspection', changedOrVanished);

function failedProtection(): void {
  vi.mocked(checkLiveService).mockReturnValue('swap_not_disabled');
  expect(checkProxy()).toEqual({ result: 'swap_not_disabled' });
  vi.mocked(checkLiveService).mockReturnValue('process_dumpable');
  expect(checkProxy()).toEqual({ result: 'process_dumpable' });
  vi.mocked(checkLiveService).mockReturnValue('private_process_missing');
  expect(checkProxy()).toEqual({ result: 'private_process_missing' });
}
it('refuses nonzero swap, dump allowance and a lost held-request probe', failedProtection);

function failedInspection(): void {
  vi.mocked(bridgeIdentity).mockImplementation(function unavailable() {
    throw new Error('private script path');
  });
  expect(checkProxy()).toEqual({ result: 'private_process_unreadable' });
}
it('keeps failed inspection details private', failedInspection);
