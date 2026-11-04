import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { acceptPrivateLaunch, launchLine, requestPrivateLaunch } from '../src/private-launch.ts';
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

async function checksLaunchExchange(fault: string) {
  const key = randomBytes(32).toString('hex');
  const caller = randomBytes(32).toString('hex');
  let accepted = 0;
  let matches = false;
  const sockets: Socket[] = [];
  function incoming(socket: Socket) {
    sockets.push(socket);
    function started(value: string) {
      accepted++;
      matches = value === caller;
      socket.destroy();
    }
    function failed() { socket.destroy(); }
    void acceptPrivateLaunch(socket, key).then(started, failed);
  }
  const server = createServer(incoming);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const client = connect(address.port, '127.0.0.1');
  sockets.push(client);
  try {
    await once(client, 'connect');
    if (fault === 'matching') {
      await requestPrivateLaunch(client, key, caller);
      expect(accepted).toBe(1);
      expect(matches).toBe(true);
    } else {
      await launchLine(client);
      const closed = once(client, 'close');
      if (fault === 'disconnect') client.destroy();
      else {
        let reply = JSON.stringify({ caller, env: { NODE_OPTIONS: 'injected' } });
        if (fault === 'reused challenge') {
          const mac = createHmac('sha256', key);
          mac.update(`${'a'.repeat(64)}:${caller}`);
          reply = `${caller}:${mac.digest('hex')}`;
        }
        client.end(`${reply}\n`);
        client.resume();
      }
      await closed;
      expect(accepted).toBe(0);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}
it.each(['matching', 'environment injection', 'reused challenge', 'disconnect'])(
  'checks the one-use private launch exchange with %s', checksLaunchExchange);
