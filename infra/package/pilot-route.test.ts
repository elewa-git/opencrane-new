import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { ownsPackageForwarder, packageForwardArgs } from './package-forwarder.ts';
import {
  healthyForwarder, rollbackPilotRoute, switchPilot, type PilotRouteSettings,
} from './pilot-route.ts';

const host = 'node.tailnet.ts.net';
const demoTarget = 'http://127.0.0.1:44200';
const pilotTarget = 'http://127.0.0.1:25106';
const execute = promisify(execFile);

function routeFixture(savedRoute: string) {
  const settings: PilotRouteSettings = { host, demoTarget, pilotTarget, savedRoute,
    redirect: `https://${host}/auth/callback`, logoutRedirect: `https://${host}/` };
  let target: string | undefined = demoTarget;
  let writes = 0;
  let etag = 'original';
  let changeAtWrite: string | undefined;
  let confirmationMissing = false;
  let listenerReplacedAfterStatus = false;
  let ignoreWrite = false;
  const tailscale = { dnsName: `${host}.`, funnel: {} as Record<string, boolean>,
    foreground: {}, extraHandlers: {}, extraHosts: {}, extraPorts: {}, services: {},
    extraFields: {}, webFields: {}, https: true };
  let forwarder = true;
  let listenerOwned = true;
  async function deviceName() {
    return tailscale.dnsName;
  }
  async function serveStatus() {
    if (listenerReplacedAfterStatus) listenerOwned = false;
    const visible = confirmationMissing && writes > 0 ? undefined : target;
    const root = visible ? { '/': { Proxy: visible } } : {};
    const Handlers = { ...root, ...tailscale.extraHandlers };
    const Web = { [`${host}:443`]: { Handlers, ...tailscale.webFields }, ...tailscale.extraHosts };
    const https = tailscale.https ? { '443': { HTTPS: true } } : {};
    const configuration = { AllowFunnel: tailscale.funnel, Web, Foreground: tailscale.foreground,
      TCP: { ...https, ...tailscale.extraPorts }, Services: tailscale.services,
      ...tailscale.extraFields };
    return { configuration, etag };
  }
  async function ownsForwarder(origin: string) {
    assert.equal(origin, pilotTarget);
    return listenerOwned;
  }
  async function healthyForwarder(origin: string) {
    assert.equal(origin, pilotTarget);
    return forwarder;
  }
  async function serve(origin: string, checked?: { etag: string }) {
    if (changeAtWrite) {
      target = changeAtWrite;
      etag = 'changed';
    }
    if (checked && checked.etag !== etag) throw new Error('Serve configuration changed');
    writes++;
    if (!ignoreWrite) target = origin === 'off' ? undefined : origin;
  }
  function stopForwarder() {
    forwarder = false;
  }
  function replaceListener() {
    listenerOwned = false;
  }
  function replaceListenerAfterStatus() {
    listenerReplacedAfterStatus = true;
  }
  function changeAtWriteTo(origin: string) {
    changeAtWrite = origin;
  }
  function hideConfirmation() {
    confirmationMissing = true;
  }
  function ignoreRouteWrite() {
    ignoreWrite = true;
  }
  function externalChange(origin: string) {
    target = origin;
  }
  function current() {
    return target;
  }
  function changes() {
    return writes;
  }
  const controls = { deviceName, serveStatus, ownsForwarder, healthyForwarder, serve };
  return {
    settings, controls, tailscale, stopForwarder, replaceListener, replaceListenerAfterStatus,
    changeAtWriteTo, hideConfirmation, ignoreRouteWrite, externalChange, current, changes,
  };
}

async function withRoute(action: (fixture: ReturnType<typeof routeFixture>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
  try {
    const fixture = routeFixture(join(directory, 'demo-target'));
    await action(fixture);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function refusesMissingHttps() {
  async function check(fixture: ReturnType<typeof routeFixture>) {
    fixture.tailscale.https = false;
    await assert.rejects(switchPilot(fixture.settings, fixture.controls), /root HTTPS/u);
    assert.equal(fixture.current(), demoTarget);
    assert.equal(fixture.changes(), 0);
  }
  await withRoute(check);
}

async function refusesReplacedListener() {
  async function check(fixture: ReturnType<typeof routeFixture>) {
    fixture.replaceListenerAfterStatus();
    await assert.rejects(switchPilot(fixture.settings, fixture.controls), /forwarder/u);
    assert.equal(fixture.current(), demoTarget);
    assert.equal(fixture.changes(), 0);
  }
  await withRoute(check);
}

async function keepsInterveningRoute() {
  async function check(fixture: ReturnType<typeof routeFixture>) {
    const replacement = 'http://127.0.0.1:29996';
    fixture.changeAtWriteTo(replacement);
    await assert.rejects(switchPilot(fixture.settings, fixture.controls), /configuration changed/u);
    assert.equal(fixture.current(), replacement);
    assert.equal(fixture.changes(), 0);
  }
  await withRoute(check);
}

async function reportsFailedConfirmation() {
  async function check(fixture: ReturnType<typeof routeFixture>) {
    fixture.hideConfirmation();
    const { settings, controls } = fixture;
    await assert.rejects(switchPilot(settings, controls), /run the saved demo recovery/u);
    assert.equal(fixture.current(), pilotTarget);
    assert.equal(await readFile(settings.savedRoute, 'utf8'), `${demoTarget}\n`);
  }
  await withRoute(check);
}

test('a root proxy requires a TCP HTTPS listener', refusesMissingHttps);
test('a listener replaced after reading Serve leaves the demo mapped', refusesReplacedListener);
test('a concurrent Serve change keeps its mapping', keepsInterveningRoute);
test('a switch without confirmation reports how to restore the saved demo', reportsFailedConfirmation);

type RouteFixture = ReturnType<typeof routeFixture>;

const prerequisites: Record<string, { error: RegExp; change(fixture: RouteFixture): void }> = {
  'device name': {
    error: /This device needs its own tailnet DNS name/u,
    change(fixture) {
      fixture.tailscale.dnsName = 'node.example.test.';
    },
  },
  'configured host': {
    error: /configured host/u,
    change(fixture) {
      fixture.settings.host = 'pilot.example.test';
    },
  },
  'sign-in redirect': {
    error: /sign-in redirect/u,
    change(fixture) {
      fixture.settings.redirect = 'https://wrong.tailnet.ts.net/auth/callback';
    },
  },
  'sign-out redirect': {
    error: /sign-out redirect/u,
    change(fixture) {
      fixture.settings.logoutRedirect = 'https://wrong.tailnet.ts.net/';
    },
  },
  'background Funnel': {
    error: /Funnel/u,
    change(fixture) {
      fixture.tailscale.funnel[`${host}:443`] = true;
    },
  },
  'foreground Funnel': {
    error: /Funnel/u,
    change(fixture) {
      fixture.tailscale.foreground = { terminal: { AllowFunnel: { [`${host}:8443`]: true } } };
    },
  },
  'extra Serve path': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraHandlers = { '/old': { Proxy: demoTarget } };
    },
  },
  'extra Serve host': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraHosts = { [`${host}:8443`]: demoWebHandler() };
    },
  },
  'foreground Serve': {
    error: /Serve.+root/u,
    change(fixture) {
      setForegroundWeb(fixture);
    },
  },
  'TCP forwarding': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraPorts = { '8443': { TCPForward: '127.0.0.1:44200' } };
    },
  },
  'Tailscale service': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.services = { 'svc:demo': { Tun: true } };
    },
  },
  'foreground TCP': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.foreground = { terminal: { TCP: { '8443': { HTTPS: true } } } };
    },
  },
  'foreground service': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.foreground = { terminal: { Services: { 'svc:demo': { Tun: true } } } };
    },
  },
  'unexpected policy field': {
    error: /Unrecognized key/u,
    change(fixture) {
      fixture.tailscale.extraFields = { UnknownPolicy: true };
    },
  },
  'unexpected web field': {
    error: /Unrecognized key/u,
    change(fixture) {
      fixture.tailscale.webFields = { UnknownHandler: true };
    },
  },
  'extra root handler field': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraHandlers = { '/': { Proxy: demoTarget, Path: '/unexpected' } };
    },
  },
  'root handler without a proxy': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraHandlers = { '/': { Path: '/unexpected' } };
    },
  },
  'other hostname at port 443': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraFields = { Web: { 'other.tailnet.ts.net:443': demoWebHandler() } };
    },
  },
  'extra TCP port': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraPorts = { '8443': { HTTPS: true } };
    },
  },
  'wrong TCP handler at port 443': {
    error: /Serve.+root/u,
    change(fixture) {
      fixture.tailscale.extraPorts = { '443': { HTTP: true } };
    },
  },
  'non-local demo': {
    error: /separate loopback/u,
    change(fixture) {
      fixture.settings.demoTarget = 'http://192.0.2.1:44200';
    },
  },
  'demo port out of range': {
    error: /separate loopback/u,
    change(fixture) {
      fixture.settings.demoTarget = 'http://127.0.0.1:65536';
    },
  },
  'pilot port out of range': {
    error: /separate loopback/u,
    change(fixture) {
      fixture.settings.pilotTarget = 'http://127.0.0.1:65536';
    },
  },
  'shared port': {
    error: /separate loopback/u,
    change(fixture) {
      fixture.settings.demoTarget = 'http://localhost:25106';
    },
  },
  'unowned listener': {
    error: /pilot forwarder.+listen/u,
    change(fixture) {
      fixture.replaceListener();
    },
  },
  'demo mapping': {
    error: /Serve target/u,
    change(fixture) {
      fixture.settings.demoTarget = 'http://127.0.0.1:44444';
    },
  },
  'forwarder': {
    error: /forwarder/u,
    change(fixture) {
      fixture.stopForwarder();
    },
  },
};

function demoWebHandler() {
  const root = { Proxy: demoTarget };
  return { Handlers: { '/': root } };
}

function setForegroundWeb(fixture: ReturnType<typeof routeFixture>) {
  const web = { [`${host}:8443`]: demoWebHandler() };
  fixture.tailscale.foreground = { terminal: { Web: web } };
}

for (const [check, prerequisite] of Object.entries(prerequisites)) {
  async function refusesSwitch() {
    async function checkRoute(fixture: ReturnType<typeof routeFixture>) {
      prerequisite.change(fixture);
      await assert.rejects(switchPilot(fixture.settings, fixture.controls), prerequisite.error);
      assert.equal(fixture.current(), demoTarget);
      assert.equal(fixture.changes(), 0);
      await assert.rejects(readFile(fixture.settings.savedRoute), { code: 'ENOENT' });
    }
    await withRoute(checkRoute);
  }
  test(`a failed ${check} check leaves the demo mapped`, refusesSwitch);
}

async function saveDemo(fixture: RouteFixture, origin = demoTarget) {
  await writeFile(fixture.settings.savedRoute, `${origin}\n`, { mode: 0o600 });
}

async function checkOriginalRoute(fixture: RouteFixture) {
  const { settings, controls } = fixture;
  await switchPilot(settings, controls);
  assert.equal(fixture.current(), pilotTarget);
  await switchPilot(settings, controls);
  assert.equal(fixture.changes(), 1);
  assert.equal(await readFile(settings.savedRoute, 'utf8'), `${demoTarget}\n`);
  const foreign = 'http://127.0.0.1:29999';
  fixture.externalChange(foreign);
  await assert.rejects(switchPilot(settings, controls), /Serve target/u);
  assert.equal(fixture.current(), foreign);
  assert.equal(fixture.changes(), 1);
  assert.equal(await readFile(settings.savedRoute, 'utf8'), `${demoTarget}\n`);
}

async function checkUnsavedPilotRoute(fixture: RouteFixture) {
  const { settings, controls } = fixture;
  fixture.externalChange(pilotTarget);
  await assert.rejects(switchPilot(settings, controls), /Serve target/u);
  assert.equal(fixture.current(), pilotTarget);
  assert.equal(fixture.changes(), 0);
  await assert.rejects(readFile(settings.savedRoute), { code: 'ENOENT' });
}

async function checkDemoAlias(fixture: RouteFixture) {
  await saveDemo(fixture, 'http://localhost:44200');
  const { settings, controls } = fixture;
  await rollbackPilotRoute('check-demo', settings, controls);
  assert.equal(fixture.changes(), 0);
}

async function checkRollback(fixture: RouteFixture) {
  const { settings, controls } = fixture;
  await switchPilot(settings, controls);
  await rollbackPilotRoute('restore', settings, controls);
  await rollbackPilotRoute('check-demo', settings, controls);
  assert.equal(fixture.current(), demoTarget);

  await switchPilot(settings, controls);
  await rollbackPilotRoute('pause', settings, controls);
  assert.equal(fixture.current(), undefined);
  await rollbackPilotRoute('restore', settings, controls);
  await rollbackPilotRoute('check-demo', settings, controls);
  assert.equal(fixture.current(), demoTarget);
  assert.equal(await readFile(settings.savedRoute, 'utf8'), `${demoTarget}\n`);
}

async function checkSavedMismatch(fixture: RouteFixture) {
  await saveDemo(fixture, 'http://localhost:29999');
  await assert.rejects(switchPilot(fixture.settings, fixture.controls), /saved Serve target/u);
  assert.equal(fixture.current(), demoTarget);
  assert.equal(fixture.changes(), 0);
}

async function checkForeignRollback(fixture: RouteFixture) {
  const foreign = 'http://127.0.0.1:29999';
  fixture.externalChange(foreign);
  await saveDemo(fixture);
  await assert.rejects(rollbackPilotRoute('restore', fixture.settings, fixture.controls),
    /differs from the saved demo and the pilot/u);
  assert.equal(fixture.current(), foreign);
  assert.equal(fixture.changes(), 0);
}

async function checkRepeatMissingHttps(fixture: RouteFixture) {
  await switchPilot(fixture.settings, fixture.controls);
  fixture.tailscale.https = false;
  await assert.rejects(switchPilot(fixture.settings, fixture.controls), /root HTTPS/u);
  assert.equal(fixture.current(), pilotTarget);
  assert.equal(fixture.changes(), 1);
}

async function checkDemoMissingHttps(fixture: RouteFixture) {
  await saveDemo(fixture);
  fixture.tailscale.https = false;
  await assert.rejects(rollbackPilotRoute('check-demo', fixture.settings, fixture.controls),
    /root HTTPS/u);
  assert.equal(fixture.current(), demoTarget);
  assert.equal(fixture.changes(), 0);
}

const routeChecks = [
  ['repeating a switch keeps the original demo route', checkOriginalRoute],
  ['repeat switching still requires the HTTPS listener', checkRepeatMissingHttps],
  ['rollback confirmation still requires the HTTPS listener', checkDemoMissingHttps],
  ['switch refuses a pilot mapping with no saved demo route', checkUnsavedPilotRoute],
  ['rollback accepts the two loopback names for the same port', checkDemoAlias],
  ['rollback can restore a running demo or pause before starting one', checkRollback],
  ['switch keeps the demo mapped when its saved address differs', checkSavedMismatch],
  ['rollback leaves an unrelated route alone', checkForeignRollback],
] as const;
for (const [description, check] of routeChecks) {
  async function checkRoute() {
    await withRoute(check);
  }
  test(description, checkRoute);
}

const invalidSavedRoutes = [
  ['missing', undefined], ['non-local', 'http://192.0.2.1:44200'],
  ['outside the port range', 'http://localhost:65536'], ['on the pilot port', 'http://localhost:25106'],
] as const;
for (const [description, origin] of invalidSavedRoutes) {
  async function refusesSavedRoute() {
    async function checkRoute(fixture: RouteFixture) {
      if (origin !== undefined) await saveDemo(fixture, origin);
      fixture.externalChange(pilotTarget);
      await assert.rejects(rollbackPilotRoute('restore', fixture.settings, fixture.controls),
        /saved demo Serve target is missing or invalid/u);
      assert.equal(fixture.current(), pilotTarget);
      assert.equal(fixture.changes(), 0);
    }
    await withRoute(checkRoute);
  }
  test(`rollback refuses a saved address that is ${description}`, refusesSavedRoute);
}

for (const action of ['pause', 'restore'] as const) {
  async function detectsUnappliedRollback() {
    async function checkRoute(fixture: RouteFixture) {
      await saveDemo(fixture);
      fixture.externalChange(pilotTarget);
      fixture.ignoreRouteWrite();
      const message = action === 'pause' ? /did not remove the pilot route/u : /saved demo target/u;
      await assert.rejects(rollbackPilotRoute(action, fixture.settings, fixture.controls), message);
      assert.equal(fixture.current(), pilotTarget);
      assert.equal(fixture.changes(), 1);
    }
    await withRoute(checkRoute);
  }
  test(`${action} reports a write that left the pilot mapped`, detectsUnappliedRollback);
}

for (const health of ['anonymous', 'failure', 'authenticated', 'redirect']) {
  async function checksAnonymousHealth() {
    const origin = await openHealthListener(health);
    try {
      const check = healthyForwarder(origin.url);
      if (health === 'redirect') {
        await assert.rejects(check, /did not answer/u);
      } else {
        assert.equal(await check, health === 'anonymous');
      }
    } finally {
      await origin.close();
    }
  }
  test(`the forwarder health check handles a ${health} response`, checksAnonymousHealth);
}

async function openHealthListener(health: string) {
  function respond(request: IncomingMessage, reply: ServerResponse) {
    if (health === 'redirect' && request.url === '/auth/me') {
      reply.writeHead(302, { Location: '/ready' });
      reply.end();
      return;
    }
    const authenticated = health === 'authenticated';
    reply.statusCode = health === 'failure' ? 503 : 200;
    reply.setHeader('Content-Type', 'application/json');
    reply.end(JSON.stringify({ authenticated }));
  }
  const server = createServer(respond);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  async function close() {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  return { url, close };
}

test('an OpenCrane sign-in response on the loopback port does not prove listener ownership',
  refusesStaleListener);

async function refusesStaleListener() {
  const origin = await openHealthListener('anonymous');
  try {
    assert.equal(await healthyForwarder(origin.url), true);
    const args = packageForwardArgs(['--context=disposable'], 'test-package', origin.url);
    const target = { clusterUid: 'disposable-cluster', namespaceUid: 'disposable-package' };
    assert.equal(await ownsPackageForwarder(origin.url, args, target), false);
  } finally {
    await origin.close();
  }
}

const localServe = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const path = process.env.PRIVATE_DIR + '/serve-fixture.json';
const state = JSON.parse(readFileSync(path, 'utf8'));
function save() {
  writeFileSync(path, JSON.stringify(state));
}
function http(status, body, headers = '') {
  process.stdout.write('HTTP/1.1 ' + status + ' Fixture\\r\\n' + headers + '\\r\\n' + body);
}
if (args.join(' ') === 'status --json') {
  process.stdout.write(JSON.stringify({ Self: { DNSName: state.host } }));
} else if (!args.includes('http://local-tailscaled.sock/localapi/v0/serve-config')) {
  process.exit(2);
} else if (args.includes('POST')) {
  state.sent = args[args.indexOf('--header') + 1];
  if (state.concurrent) {
    state.tag = 'c'.repeat(64);
    state.target = 'http://127.0.0.1:29999';
  }
  if (state.sent !== 'If-Match: ' + state.tag) {
    save();
    http(412, '');
  } else {
    const config = JSON.parse(args[args.indexOf('--data-binary') + 1]);
    state.target = config.Web[state.host + ':443'].Handlers['/'].Proxy;
    state.tag = 'b'.repeat(64);
    save();
    http(200, '');
  }
} else {
  const config = { TCP: { '443': { HTTPS: true } },
    Web: { [state.host + ':443']: { Handlers: { '/': { Proxy: state.target } } } } };
  http(200, JSON.stringify(config), 'Etag: ' + state.tag + '\\r\\n');
}
`;

for (const concurrent of [false, true]) {
  async function usesCheckedEtag() {
    const directory = await mkdtemp(join(tmpdir(), 'pilot-local-api-'));
    try {
      await writeFile(join(directory, 'tailscale'), localServe, { mode: 0o700 });
      await writeFile(join(directory, 'sudo'), localServe, { mode: 0o700 });
      await writeFile(join(directory, 'demo-serve-target'), `${demoTarget}\n`, { mode: 0o600 });
      const path = join(directory, 'serve-fixture.json');
      const initial = { host, target: pilotTarget, tag: 'a'.repeat(64), concurrent };
      await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
      const env = { ...process.env, PRIVATE_DIR: directory, DEV_STACK_ID: '1',
        PATH: `${directory}:${process.env['PATH']}` };
      const args = ['--experimental-strip-types', 'infra/package/pilot-route.ts', 'restore'];
      const command = execute(process.execPath, args, { env });
      if (concurrent) {
        await assert.rejects(command, { stderr: /configuration changed/u });
      } else {
        const result = await command;
        assert.match(result.stdout, /PASS Tailscale Serve reports the saved demo/u);
      }
      const state = JSON.parse(await readFile(path, 'utf8')) as { sent: string; target: string };
      assert.equal(state.sent, `If-Match: ${initial.tag}`);
      const expected = concurrent ? 'http://127.0.0.1:29999' : demoTarget;
      assert.equal(state.target, expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  test(`the command sends the checked Tailscale ETag when concurrent=${concurrent}`, usesCheckedEtag);
}
