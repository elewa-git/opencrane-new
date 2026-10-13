import { expect, it } from 'vitest';
import { privateCodexLaunch } from '../src/private-codex.ts';

function launchesPinnedCodexWithDebuggingDisabled() {
  const launch = privateCodexLaunch('/home/private/turn-4', 'caller-token');
  const wrapper = '/usr/local/bin/codex';

  expect(launch.command).toBe('/usr/bin/setpriv');
  expect(launch.args).toEqual([
    '--reuid=1003',
    '--regid=1003',
    '--clear-groups',
    '--no-new-privs',
    '--',
    '/usr/local/bin/node',
    '--disable-sigusr1',
    wrapper,
    'app-server',
    '--stdio',
  ]);
  expect(launch.options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
  expect(Object.keys(launch.options.env).sort()).toEqual([
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'HOME',
    'PATH',
    'PROXY_CALLER_TOKEN',
    'TMPDIR',
  ]);
  expect(launch.options.env['HOME']).toBe('/home/private/turn-4');
  expect(launch.options.env['CODEX_HOME']).toBe('/home/private/turn-4/codex');
  expect(launch.options.env['CODEX_SQLITE_HOME']).toBe('/home/private/turn-4/codex');
  expect(launch.options.env['TMPDIR']).toBe('/home/private/turn-4/tmp');
  expect(launch.options.env['PROXY_CALLER_TOKEN']).toBe('caller-token');
}

it('disables Node debugging before starting the pinned Codex process',
  launchesPinnedCodexWithDebuggingDisabled);
