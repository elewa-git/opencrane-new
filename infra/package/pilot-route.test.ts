import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rollbackPilotRoute, switchPilot,
  type PilotRouteControls, type PilotRouteSettings } from './pilot-route.ts';

const host = 'node.tailnet.ts.net';
const demoTarget = 'http://127.0.0.1:44200';
const pilotTarget = 'http://127.0.0.1:25106';

function routeFixture(savedRoute: string) {
  const settings: PilotRouteSettings = { host, demoTarget, pilotTarget, savedRoute,
    redirect: `https://${host}/auth/callback`, logoutRedirect: `https://${host}/` };
  let target: string | undefined = demoTarget;
  let writes = 0;
  const tailscale = { dnsName: `${host}.`, funnel: {} as Record<string, boolean> };
  let forwarder = true;
  async function deviceName() {
    return tailscale.dnsName;
  }
  async function serveStatus() {
    const Handlers = target ? { '/': { Proxy: target } } : {};
    return { AllowFunnel: tailscale.funnel, Web: { [`${host}:443`]: { Handlers } } };
  }
  async function healthyForwarder(origin: string) {
    assert.equal(origin, pilotTarget);
    return forwarder;
  }
  async function serve(origin: string) {
    writes++;
    target = origin === 'off' ? undefined : origin;
  }
  const controls: PilotRouteControls = { deviceName, serveStatus, healthyForwarder, serve };
  return {
    settings, controls, tailscale,
    stopForwarder() { forwarder = false; },
    externalChange(origin: string) { target = origin; },
    current() { return target; },
    changes() { return writes; },
  };
}

const prerequisites = [
  ['device name', /device.*tailnet/u],
  ['configured host', /configured host/u],
  ['sign-in redirect', /sign-in redirect/u],
  ['sign-out redirect', /sign-out redirect/u],
  ['Funnel', /Funnel/u],
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
    case 'Funnel':
      fixture.tailscale.funnel[`${host}:443`] = true;
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
