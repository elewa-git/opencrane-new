import { beforeEach, expect, it, vi } from 'vitest';
import { probeContainer } from './container-probe.ts';
import {
  checkLiveService, readProcessIdentity, sameProcessIdentity, supervisorIdentity,
  type ProcessIdentity,
} from './private-processes.ts';
import { checkSupervisor } from './supervisor-check.ts';

vi.mock('./container-probe.ts', { spy: true });
vi.mock('./private-processes.ts', { spy: true });

const supervisor: ProcessIdentity = {
  pid: 1, startTime: '123', executable: '/usr/local/bin/node', uid: 0,
  cgroup: '0::/computer\n', containerIdentity: 'pid:[1234]',
  commandLine: '/usr/local/bin/node\0--disable-sigusr1\0' +
    '--experimental-strip-types\0/app/src/entrypoint.ts\0',
};
const inspector = { ...supervisor, pid: 20, startTime: '456',
  commandLine: '/usr/local/bin/node\0--experimental-strip-types\0' +
    '/scripts/private-memory-qualification/supervisor-check.ts\0' };

function identitiesMatch(first: ProcessIdentity, second: ProcessIdentity): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function prepare(): void {
  vi.clearAllMocks();
  vi.mocked(supervisorIdentity).mockReturnValue(supervisor);
  vi.mocked(readProcessIdentity).mockReturnValue(inspector);
  vi.mocked(sameProcessIdentity).mockImplementation(identitiesMatch);
  vi.mocked(probeContainer).mockReturnValue(true);
  vi.mocked(checkLiveService).mockReturnValue(true);
  vi.spyOn(process, 'getuid').mockReturnValue(0);
}
beforeEach(prepare);

function provesRootSupervisor(): void {
  expect(checkSupervisor()).toEqual({ result: true, pid: 1, startTime: '123' });
  expect(checkLiveService).toHaveBeenCalledWith('supervisor', supervisor);
  expect(supervisorIdentity).toHaveBeenCalledTimes(2);
  expect(probeContainer).toHaveBeenCalledTimes(2);
}
it('checks the launched root supervisor before and after its live protection reply',
  provesRootSupervisor);

function refusesMissingSupervisor(): void {
  vi.mocked(supervisorIdentity).mockReturnValue(undefined);
  expect(checkSupervisor()).toEqual({ result: 'private_process_missing' });
}
it('refuses a missing supervisor', refusesMissingSupervisor);

function refusesForeignIdentity(): void {
  for (const change of [
    { executable: '/usr/bin/other' }, { uid: 1000 },
    { containerIdentity: 'pid:[9999]' },
    { commandLine: '/usr/local/bin/node\0/other/script.ts\0' },
  ]) {
    vi.mocked(supervisorIdentity).mockReturnValue({ ...supervisor, ...change });
    expect(checkSupervisor()).toEqual({ result: 'private_process_identity_changed' });
  }
}
it('refuses another executable, UID, start time, namespace or script',
  refusesForeignIdentity);

function refusesProtectionAllowance(): void {
  vi.mocked(probeContainer).mockReturnValueOnce('swap_not_disabled');
  expect(checkSupervisor()).toEqual({ result: 'swap_not_disabled' });
  vi.mocked(probeContainer).mockReturnValue(true);
  vi.mocked(checkLiveService).mockReturnValue('process_dumpable');
  expect(checkSupervisor()).toEqual({ result: 'process_dumpable' });
}
it('refuses swap and dump allowance using the existing readers', refusesProtectionAllowance);

function refusesChangedLaunch(): void {
  const identityMock = vi.mocked(supervisorIdentity);
  identityMock.mockReturnValueOnce(supervisor);
  identityMock.mockReturnValueOnce({ ...supervisor, startTime: '124' });
  expect(checkSupervisor()).toEqual({ result: 'private_process_identity_changed' });
}
it('refuses a replaced supervisor after the live reply', refusesChangedLaunch);

function refusesLostInspection(): void {
  vi.mocked(checkLiveService).mockReturnValue('private_process_unreadable');
  expect(checkSupervisor()).toEqual({ result: 'private_process_unreadable' });
}
it('refuses an unavailable live inspection', refusesLostInspection);
