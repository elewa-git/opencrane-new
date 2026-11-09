import { lstatSync, readFileSync, readdirSync, statfsSync, statSync } from 'node:fs';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeInventoryProcess } from './live-inventory-probe.ts';
import { pinnedNativeBinary, proveNativePair } from './native-process-proof.ts';
import { checkLiveService, readProcessIdentity } from './private-processes.ts';

vi.mock('node:fs', { spy: true });
vi.mock('./native-process-proof.ts', { spy: true });
vi.mock('./private-processes.ts', { spy: true });

const challenge = '11111111-1111-4111-8111-111111111111';
const recordName = 'opencrane-native-22222222-2222-4222-8222-222222222222.identity';
const binary = '/opt/native/codex';
const identity = { pid: 123, startTime: '456', executable: '/usr/local/bin/node',
  uid: 1003, cgroup: '0::/computer\n', containerIdentity: 'pid:[1234]',
  commandLine: '/usr/local/bin/node\0--disable-sigusr1\0' +
    '/usr/local/bin/codex\0app-server\0--stdio\0' };

function procStat(parent: number): string {
  const fields = ['S', String(parent), ...Array<string>(18).fill('1')];
  return `123 (node) ${fields.join(' ')}`;
}

function trustNativeRecord(): void {
  const record = Object.assign(statSync(import.meta.filename), {
    uid: 0, mode: 0o100600, nlink: 1, size: 50,
  });
  vi.mocked(lstatSync).mockReturnValue(record);
}

beforeEach(function reset(): void {
  vi.mocked(readFileSync).mockReset();
  vi.mocked(readdirSync).mockReset();
  vi.mocked(lstatSync).mockReset();
  vi.mocked(statfsSync).mockReset();
  vi.mocked(readProcessIdentity).mockReset();
  vi.mocked(checkLiveService).mockReset();
  vi.mocked(proveNativePair).mockReset();
  vi.mocked(pinnedNativeBinary).mockReset();
});

function checksNativeLaunch(): void {
  const record = `${challenge} 123 456 124 457\n`;
  trustNativeRecord();
  // The reader calls the names overload; Vitest types its final Dirent overload.
  // @ts-expect-error Stub the string names returned by the actual call.
  vi.mocked(readdirSync).mockReturnValue([recordName]);
  vi.mocked(readFileSync).mockReturnValueOnce(record).mockReturnValueOnce(record)
    .mockReturnValueOnce(procStat(77));
  vi.mocked(pinnedNativeBinary).mockReturnValue(binary);
  vi.mocked(proveNativePair).mockReturnValue(true);
  vi.mocked(readProcessIdentity).mockReturnValue(identity);
  expect(probeInventoryProcess('nativeWrapper', challenge)).toMatchObject({
    pid: 123, executable: '/usr/local/bin/node', protected: true,
  });
  expect(proveNativePair).toHaveBeenCalledWith({ challengeId: challenge,
    wrapperPid: 123, childPid: 124, runnerPid: 77,
    recordPath: `/run/${recordName}`, childBinary: binary });
}
it('discovers the native wrapper from its protected launch record', checksNativeLaunch);

function refusesNativeExec(): void {
  const record = `${challenge} 123 456 124 457\n`;
  trustNativeRecord();
  // The reader calls the names overload; Vitest types its final Dirent overload.
  // @ts-expect-error Stub the string names returned by the actual call.
  vi.mocked(readdirSync).mockReturnValue([recordName]);
  vi.mocked(readFileSync).mockReturnValueOnce(record).mockReturnValueOnce(record)
    .mockReturnValueOnce(procStat(77));
  vi.mocked(pinnedNativeBinary).mockReturnValue(binary);
  vi.mocked(proveNativePair).mockReturnValue(true);
  vi.mocked(readProcessIdentity).mockReturnValue({ ...identity, executable: '/usr/bin/other' });
  expect(probeInventoryProcess('nativeWrapper', challenge)).toBeUndefined();
}
it('refuses a native exec after protection with the same PID and start time',
  refusesNativeExec);

function refusesCopiedNativeLink(): void {
  const link = Object.assign(statSync(import.meta.filename), {
    isFile: function no(): boolean { return false; },
  });
  // The reader calls the names overload; Vitest types its final Dirent overload.
  // @ts-expect-error Stub the string names returned by the actual call.
  vi.mocked(readdirSync).mockReturnValue([recordName]);
  vi.mocked(lstatSync).mockReturnValue(link);
  expect(probeInventoryProcess('nativeWrapper', challenge)).toBeUndefined();
  expect(readFileSync).not.toHaveBeenCalled();
}
it('refuses a copied native launch link before reading it', refusesCopiedNativeLink);

function checksHelperLaunch(): void {
  const image = `sha256:${'a'.repeat(64)}`;
  const installation = `sha256:${'b'.repeat(64)}`;
  const record = `${challenge} 123 456 77 455 ${image} ${installation}\n`;
  const directory = Object.assign(statSync(import.meta.filename), {
    uid: 0, mode: 0o40700, isDirectory: function yes(): boolean { return true; },
  });
  const file = Object.assign(statSync(import.meta.filename), {
    uid: 0, mode: 0o100600, nlink: 1, size: record.length,
    isFile: function yes(): boolean { return true; },
  });
  vi.mocked(lstatSync).mockReturnValueOnce(directory).mockReturnValueOnce(file);
  const filesystem = Object.assign(statfsSync('/run'), { type: 0x01021994 });
  vi.mocked(statfsSync).mockReturnValue(filesystem);
  vi.mocked(readFileSync).mockReturnValueOnce(record).mockReturnValueOnce(procStat(77));
  const helper = { ...identity, uid: 0, commandLine: '/usr/local/bin/node\0' +
    '--experimental-strip-types\0/app/scripts/private-memory-qualification/journey.mjs\0' };
  const supervisor = { ...identity, pid: 77, uid: 0, startTime: '455',
    commandLine: '/usr/local/bin/node\0--input-type=module\0--eval\0source\0' };
  function processForPid(pid: number): typeof helper {
    return pid === 123 ? helper : supervisor;
  }
  vi.mocked(readProcessIdentity).mockImplementation(processForPid);
  vi.mocked(checkLiveService).mockReturnValue(true);
  expect(probeInventoryProcess('canaryHelper', challenge, image, installation)).toMatchObject({
    pid: 123, uid: 0, protected: true,
  });
  expect(checkLiveService).toHaveBeenCalledWith('canaryHelper', helper);
}
it('binds the helper to its supervisor and live protection reply', checksHelperLaunch);
