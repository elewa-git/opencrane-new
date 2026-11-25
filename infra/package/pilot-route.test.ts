import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ownsPackageForwarder, packageForwardArgs } from './package-forwarder.ts';
import { rollbackPilotRoute, switchPilot, type PilotRouteSettings } from './pilot-route.ts';

const host = 'node.tailnet.ts.net';
const demoTarget = 'http://127.0.0.1:44200';
const pilotTarget = 'http://127.0.0.1:25106';

function routeFixture(savedRoute: string) {
  const settings: PilotRouteSettings = { host, demoTarget, pilotTarget, savedRoute,
    redirect: `https://${host}/auth/callback`, logoutRedirect: `https://${host}/` };
  let target: string | undefined = demoTarget;
  let writes = 0;
  let etag = 'original';
  let changeAtWrite: string | undefined;
  let confirmationMissing = false;
  let listenerReplacedAfterStatus = false;
  const tailscale = { dnsName: `${host}.`, funnel: {} as Record<string, boolean>,
    foreground: {}, extraHandlers: {}, extraHosts: {}, extraPorts: {}, services: {}, https: true };
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
    const Web = { [`${host}:443`]: { Handlers }, ...tailscale.extraHosts };
    const https = tailscale.https ? { '443': { HTTPS: true } } : {};
    return { AllowFunnel: tailscale.funnel, Web, Foreground: tailscale.foreground,
      TCP: { ...https, ...tailscale.extraPorts }, Services: tailscale.services };
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
    target = origin === 'off' ? undefined : origin;
  }
  const controls = { deviceName, serveStatus, ownsForwarder, healthyForwarder, serve };
  return {
    settings, controls, tailscale,
    stopForwarder() { forwarder = false; },
    replaceListener() { listenerOwned = false; },
    replaceListenerAfterStatus() { listenerReplacedAfterStatus = true; },
    changeAtWriteTo(origin: string) { changeAtWrite = origin; },
    hideConfirmation() { confirmationMissing = true; },
    externalChange(origin: string) { target = origin; },
    current() { return target; },
    changes() { return writes; },
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

const prerequisites = [
  ['device name', /This device needs its own tailnet DNS name/u],
  ['configured host', /configured host/u],
  ['sign-in redirect', /sign-in redirect/u],
  ['sign-out redirect', /sign-out redirect/u],
  ['background Funnel', /Funnel/u],
  ['foreground Funnel', /Funnel/u],
  ['extra Serve path', /Serve.+root/u],
  ['extra Serve host', /Serve.+root/u],
  ['foreground Serve', /Serve.+root/u],
  ['TCP forwarding', /Serve.+root/u],
  ['Tailscale service', /Serve.+root/u],
  ['unowned listener', /pilot forwarder.+listen/u],
  ['demo mapping', /Serve target/u],
  ['forwarder', /forwarder/u],
] as const;

function breakPrerequisite(fixture: ReturnType<typeof routeFixture>, check: string) {
  switch (check) {
    case 'device name':
      fixture.tailscale.dnsName = 'node.example.test.';
      break;
    case 'configured host':
      fixture.settings.host = 'pilot.example.test';
      break;
    case 'sign-in redirect':
      fixture.settings.redirect = 'https://wrong.tailnet.ts.net/auth/callback';
      break;
    case 'sign-out redirect':
      fixture.settings.logoutRedirect = 'https://wrong.tailnet.ts.net/';
      break;
    case 'background Funnel':
      fixture.tailscale.funnel[`${host}:443`] = true;
      break;
    case 'foreground Funnel':
      fixture.tailscale.foreground = { terminal: { AllowFunnel: { [`${host}:8443`]: true } } };
      break;
    case 'extra Serve path':
      fixture.tailscale.extraHandlers = { '/old': { Proxy: demoTarget } };
      break;
    case 'extra Serve host':
      fixture.tailscale.extraHosts = { [`${host}:8443`]: { Handlers: { '/': { Proxy: demoTarget } } } };
      break;
    case 'foreground Serve':
      fixture.tailscale.foreground = {
        terminal: { Web: { [`${host}:8443`]: { Handlers: { '/': { Proxy: demoTarget } } } } },
      };
      break;
    case 'TCP forwarding':
      fixture.tailscale.extraPorts = { '8443': { TCPForward: '127.0.0.1:44200' } };
      break;
    case 'Tailscale service':
      fixture.tailscale.services = { 'svc:demo': { Tun: true } };
      break;
    case 'unowned listener':
      fixture.replaceListener();
      break;
    case 'demo mapping':
      fixture.settings.demoTarget = 'http://127.0.0.1:44444';
      break;
    case 'forwarder':
      fixture.stopForwarder();
      break;
    default:
      throw new Error('Unknown fixture check');
  }
}

for (const [check, error] of prerequisites) {
  test(`a failed ${check} check leaves the demo mapped`, async function refusesSwitch() {
    const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
    const savedRoute = join(directory, 'demo-target');
    try {
      const fixture = routeFixture(savedRoute);
      breakPrerequisite(fixture, check);
      await assert.rejects(switchPilot(fixture.settings, fixture.controls), error);
      assert.equal(fixture.current(), demoTarget);
      assert.equal(fixture.changes(), 0);
      await assert.rejects(readFile(savedRoute), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('repeating a switch preserves the original demo route',
  async function keepsOriginalRoute() {
    const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
    const savedRoute = join(directory, 'demo-target');
    try {
      const fixture = routeFixture(savedRoute);
      await switchPilot(fixture.settings, fixture.controls);
      assert.equal(fixture.current(), pilotTarget);
      await switchPilot(fixture.settings, fixture.controls);
      assert.equal(fixture.changes(), 1);
      assert.equal(await readFile(savedRoute, 'utf8'), `${demoTarget}\n`);
      fixture.externalChange('http://127.0.0.1:29999');
      await assert.rejects(switchPilot(fixture.settings, fixture.controls), /Serve target/u);
      assert.equal(fixture.changes(), 1);
      assert.equal(await readFile(savedRoute, 'utf8'), `${demoTarget}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test('the pilot mapping is not treated as the demo when the saved route is absent',
  async function refusesUnsavedPilotRoute() {
    const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
    const savedRoute = join(directory, 'demo-target');
    try {
      const fixture = routeFixture(savedRoute);
      fixture.externalChange(pilotTarget);
      await assert.rejects(switchPilot(fixture.settings, fixture.controls), /Serve target/u);
      assert.equal(fixture.changes(), 0);
      await assert.rejects(readFile(savedRoute), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

test('rollback restores a running demo or resumes after pausing a stopped demo', checksRollback);

test('rollback refuses a saved demo address that reaches the pilot listener', refusesSharedPort);

test('rollback accepts the saved demo when Serve spells its loopback address differently',
  acceptsDemoAlias);

async function acceptsDemoAlias() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
  const savedRoute = join(directory, 'demo-target');
  try {
    const fixture = routeFixture(savedRoute);
    await writeFile(savedRoute, 'http://localhost:44200\n', { mode: 0o600 });
    const { settings, controls } = fixture;
    await rollbackPilotRoute('check-demo', settings, controls);
    assert.equal(fixture.changes(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function refusesSharedPort() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
  const savedRoute = join(directory, 'demo-target');
  try {
    const fixture = routeFixture(savedRoute);
    const alias = 'http://localhost:25106';
    await writeFile(savedRoute, `${alias}\n`, { mode: 0o600 });
    fixture.externalChange(pilotTarget);
    const { settings, controls } = fixture;
    await assert.rejects(rollbackPilotRoute('restore', settings, controls), /saved demo/u);
    assert.equal(fixture.current(), pilotTarget);
    assert.equal(fixture.changes(), 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function checksRollback() {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-serve-'));
  const savedRoute = join(directory, 'demo-target');
  try {
    const fixture = routeFixture(savedRoute);
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
    assert.equal(await readFile(savedRoute, 'utf8'), `${demoTarget}\n`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('an OpenCrane sign-in response on the loopback port does not prove listener ownership',
  refusesStaleListener);

async function refusesStaleListener() {
  function anonymous(_request: unknown, reply: ServerResponse) {
    reply.setHeader('Content-Type', 'application/json');
    reply.end('{"authenticated":false}');
  }
  const stale = createServer(anonymous);
  stale.listen(0, '127.0.0.1');
  try {
    await once(stale, 'listening');
    const address = stale.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const answer = await fetch(`${origin}/auth/me`);
    assert.deepEqual(await answer.json(), { authenticated: false });
    const args = packageForwardArgs(['--context=disposable'], 'test-package', origin);
    const target = { clusterUid: 'disposable-cluster', namespaceUid: 'disposable-package' };
    assert.equal(await ownsPackageForwarder(origin, args, target), false);
  } finally {
    await new Promise<void>(function closeStale(resolve) {
      function closed() { resolve(); }
      stale.close(closed);
    });
  }
}
