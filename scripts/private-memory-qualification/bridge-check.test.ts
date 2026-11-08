import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest';
import { checkBridge } from './bridge-check.ts';
import { probeContainer } from './container-probe.ts';
import { bridgeIdentity, checkLiveService, readProcessIdentity,
  type ProcessIdentity } from './private-processes.ts';

vi.mock('./container-probe.ts', { spy: true });
vi.mock('./private-processes.ts', { spy: true });

const runner: ProcessIdentity = {
  pid: 9, startTime: '100', executable: '/usr/local/bin/node', uid: 0,
  cgroup: '0::/computer\n', containerIdentity: 'pid:[123]', commandLine: 'node\0check\0',
};
const bridge: ProcessIdentity = {
  ...runner, pid: 42, startTime: '200', uid: 1000,
  commandLine: 'node\0--disable-sigusr1\0--experimental-strip-types\0/app/src/bridge.ts\0',
};
let uid: MockInstance<() => number>;

function reset(): void {
  uid = vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.mocked(readProcessIdentity).mockReturnValue(runner);
  vi.mocked(bridgeIdentity).mockReturnValue(bridge);
  vi.mocked(checkLiveService).mockReturnValue(true);
  vi.mocked(probeContainer).mockReturnValue(true);
}
beforeEach(reset);
afterEach(function restoreUid() { uid.mockRestore(); });

function acceptsOnlyLiveBridge(): void {
  expect(checkBridge()).toEqual({ result: true, pid: 42, startTime: '200' });
  expect(bridgeIdentity).toHaveBeenCalledTimes(3);
  expect(probeContainer).toHaveBeenCalledTimes(2);
  expect(checkLiveService).toHaveBeenCalledWith('bridge', bridge);
}
it('checks the launch record and live bridge around swap and dump measurements',
  acceptsOnlyLiveBridge);

function refusesUntrustedCaller(): void {
  uid.mockReturnValue(1000);
  expect(checkBridge()).toEqual({ result: 'private_process_unreadable' });
  expect(bridgeIdentity).not.toHaveBeenCalled();
}
it('refuses a non-root caller inside the computer container', refusesUntrustedCaller);

function refusesMissingBridge(): void {
  vi.mocked(bridgeIdentity).mockReturnValue(undefined);
  expect(checkBridge()).toEqual({ result: 'private_process_missing' });
}
it('refuses a missing or forged root launch record', refusesMissingBridge);

function refusesChangedStart(): void {
  vi.mocked(bridgeIdentity).mockReturnValueOnce(bridge).mockReturnValueOnce({
    ...bridge, startTime: '201',
  });
  expect(checkBridge()).toEqual({ result: 'private_process_identity_changed' });
  expect(bridgeIdentity).toHaveBeenCalledTimes(2);
  expect(checkLiveService).toHaveBeenCalledWith('bridge', bridge);
}
it('refuses a reused bridge PID after the live exchange', refusesChangedStart);

function refusesChangedFinalIdentity(change: Partial<ProcessIdentity>): void {
  vi.mocked(bridgeIdentity).mockReturnValueOnce(bridge).mockReturnValueOnce(bridge)
    .mockReturnValueOnce({ ...bridge, ...change });
  expect(checkBridge()).toEqual({ result: 'private_process_identity_changed' });
  expect(bridgeIdentity).toHaveBeenCalledTimes(3);
  expect(probeContainer).toHaveBeenCalledTimes(2);
}
it.each([
  { executable: '/other/node' }, { uid: 1002 }, { cgroup: '0::/other\n' },
  { containerIdentity: 'pid:[456]' }, { commandLine: 'node\0other\0' },
])('refuses a bridge that changes identity after discovery: %j', refusesChangedFinalIdentity);

function refusesChangedRunner(): void {
  vi.mocked(readProcessIdentity).mockReturnValueOnce(runner)
    .mockReturnValueOnce({ ...runner, startTime: '101' });
  expect(checkBridge()).toEqual({ result: 'private_process_identity_changed' });
  expect(readProcessIdentity).toHaveBeenCalledTimes(2);
  expect(bridgeIdentity).toHaveBeenCalledTimes(3);
}
it('refuses a replaced probe process', refusesChangedRunner);

function refusesDeniedProc(): void {
  vi.mocked(bridgeIdentity).mockImplementation(function denied() {
    throw new Error('private path and raw proc denial');
  });
  expect(checkBridge()).toEqual({ result: 'private_process_unreadable' });
}
it('keeps a raw proc error out of the response', refusesDeniedProc);

function refusesSwapOrDump(failure: 'swap_not_disabled' | 'core_limit_not_zero'): void {
  vi.mocked(probeContainer).mockReturnValueOnce(true).mockReturnValueOnce(failure);
  expect(checkBridge()).toEqual({ result: failure });
  expect(probeContainer).toHaveBeenCalledTimes(2);
  expect(checkLiveService).toHaveBeenCalledWith('bridge', bridge);
}
it.each(['swap_not_disabled', 'core_limit_not_zero'] as const)(
  'refuses changed container protection: %s', refusesSwapOrDump);
