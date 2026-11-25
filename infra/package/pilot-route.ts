import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { localOrigin, secondary } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';
import { ownsPackageForwarder, packageForwardArgs } from './package-forwarder.ts';

export interface PilotRouteSettings {
  host: string;
  demoTarget: string;
  pilotTarget: string;
  savedRoute: string;
  redirect: string;
  logoutRedirect: string;
}

interface ServeControls {
  deviceName(): Promise<string>;
  serveStatus(): Promise<unknown>;
  serve(origin: string): Promise<void>;
}

export interface PilotRouteControls extends ServeControls {
  ownsForwarder(origin: string): Promise<boolean>;
  healthyForwarder(origin: string): Promise<boolean>;
}

const execute = promisify(execFile);
const tailnetName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}ts\.net$/u;
const loopbackTarget = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/u;
const serveSessionSchema = z.object({
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.unknown()),
  }).strict()).nullish(),
  TCP: z.record(z.string(), z.unknown()).nullish(),
  Services: z.record(z.string(), z.unknown()).nullish(),
}).strict();
const serveStatusSchema = serveSessionSchema.extend({
  Foreground: z.record(z.string(), serveSessionSchema).nullish(),
});
const rootProxySchema = z.object({ Proxy: z.string().min(1) }).strict();
const deviceSchema = z.object({ Self: z.object({ DNSName: z.string().max(254) }) });
const valuesSchema = z.object({
  exposure: z.object({ public: z.object({ enabled: z.literal(true), host: z.string() }) }),
  secrets: z.object({ runtime: z.string().min(1) }),
});
const healthSchema = z.object({ authenticated: z.literal(false) });

class RouteRefused extends Error {}

async function checkedDeviceName(controls: ServeControls): Promise<string> {
  const dnsName = await controls.deviceName();
  const hostname = dnsName.replace(/\.$/u, '');
  if (!tailnetName.test(hostname)) {
    throw new RouteRefused('This device needs its own tailnet DNS name');
  }
  return hostname;
}

type ServeSession = z.infer<typeof serveSessionSchema>;

function hasFunnel(session: ServeSession) {
  const funnel = Object.values(session.AllowFunnel ?? {});
  return funnel.includes(true);
}

function hasServices(session: ServeSession) {
  return Object.keys(session.Services ?? {}).length > 0;
}

function hasServeHandlers(session: ServeSession) {
  return hasServices(session) || Object.keys(session.TCP ?? {}).length > 0 ||
    Object.keys(session.Web ?? {}).length > 0;
}

function unexpectedHandler() {
  return new RouteRefused('Tailscale Serve must have only the expected root HTTPS proxy');
}

function rootTarget(host: string, config: ServeSession) {
  for (const [port, handler] of Object.entries(config.TCP ?? {})) {
    if (port !== '443' || !isDeepStrictEqual(handler, { HTTPS: true })) {
      throw unexpectedHandler();
    }
  }
  const web = Object.entries(config.Web ?? {});
  const [site] = web;
  if (!site) {
    return undefined;
  }
  const [address, { Handlers }] = site;
  if (web.length !== 1 || address !== `${host}:443`) {
    throw unexpectedHandler();
  }
  const paths = Object.keys(Handlers);
  if (paths.length === 0) {
    return undefined;
  }
  const handler = rootProxySchema.safeParse(Handlers['/']);
  if (paths.length !== 1 || !handler.success) {
    throw unexpectedHandler();
  }
  return handler.data.Proxy;
}

async function currentTarget(host: string, controls: ServeControls) {
  const config = serveStatusSchema.parse(await controls.serveStatus());
  const foreground = Object.values(config.Foreground ?? {});
  if (hasFunnel(config) || foreground.some(hasFunnel)) {
    throw new RouteRefused('Turn off Tailscale Funnel before changing the pilot route');
  }
  if (hasServices(config) || foreground.some(hasServeHandlers)) {
    throw unexpectedHandler();
  }
  return rootTarget(host, config);
}

async function readSavedRoute(path: string): Promise<string | undefined> {
  try {
    const saved = await readFile(path, 'utf8');
    return saved.trim();
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
      return undefined;
    }
    throw cause;
  }
}

function loopbackPort(origin: string | undefined) {
  if (!origin || !loopbackTarget.test(origin)) {
    return undefined;
  }
  const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
  if (port <= 65535) {
    return port;
  }
  return undefined;
}

function sameLoopbackAddress(first: string | undefined, second: string) {
  const port = loopbackPort(first);
  return port !== undefined && port === loopbackPort(second);
}

function checkPilotAddress(host: string, settings: PilotRouteSettings) {
  if (settings.host !== host) {
    throw new RouteRefused('The configured host differs from this device’s tailnet DNS name');
  }
  if (settings.redirect !== `https://${host}/auth/callback`) {
    throw new RouteRefused('The sign-in redirect differs from this device’s tailnet address');
  }
  if (settings.logoutRedirect !== `https://${host}/`) {
    throw new RouteRefused('The sign-out redirect differs from this device’s tailnet address');
  }
  if (!loopbackPort(settings.demoTarget) ||
      sameLoopbackAddress(settings.demoTarget, settings.pilotTarget)) {
    throw new RouteRefused('The expected demo Serve target must be a separate loopback address');
  }
}

export async function switchPilot(settings: PilotRouteSettings, controls: PilotRouteControls) {
  const host = await checkedDeviceName(controls);
  checkPilotAddress(host, settings);
  const saved = await readSavedRoute(settings.savedRoute);
  if (saved !== undefined && !sameLoopbackAddress(saved, settings.demoTarget)) {
    throw new RouteRefused('The saved Serve target differs from the expected demo target');
  }
  const current = await currentTarget(host, controls);
  if (!await controls.healthyForwarder(settings.pilotTarget)) {
    throw new RouteRefused('The claimed slot’s pilot forwarder did not pass its sign-in check');
  }
  if (!await controls.ownsForwarder(settings.pilotTarget)) {
    throw new RouteRefused('The claimed slot’s pilot forwarder is not listening on its port');
  }
  if (sameLoopbackAddress(current, settings.pilotTarget) && saved !== undefined) {
    return;
  }
  if (!current || !sameLoopbackAddress(current, settings.demoTarget)) {
    throw new RouteRefused('The current Serve target differs from the expected demo target');
  }
  if (saved === undefined) {
    // Keep the first demo route through a repeat or an interrupted switch.
    await writeFile(settings.savedRoute, `${current}\n`, { flag: 'wx', mode: 0o600 });
  }
  await controls.serve(settings.pilotTarget);
  const switched = await currentTarget(host, controls);
  if (!sameLoopbackAddress(switched, settings.pilotTarget)) {
    throw new RouteRefused('Tailscale Serve did not report the pilot target after switching');
  }
}

async function deviceName() {
  const response = await execute('tailscale', ['status', '--json'], { timeout: 5000 });
  const status = deviceSchema.parse(JSON.parse(response.stdout));
  return status.Self.DNSName;
}

async function serveStatus(): Promise<unknown> {
  const response = await execute('tailscale', ['serve', 'status', '--json'], { timeout: 5000 });
  return JSON.parse(response.stdout) as unknown;
}

async function healthyForwarder(origin: string) {
  try {
    const response = await fetch(`${origin}/auth/me`, {
      redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    return response.ok && healthSchema.safeParse(await response.json()).success;
  } catch (cause) {
    throw new RouteRefused('The claimed slot’s pilot forwarder did not answer', { cause });
  }
}

async function serve(origin: string) {
  const args = ['-n', 'tailscale', 'serve', '--bg', '--https=443', '--set-path=/', origin];
  try {
    await execute('sudo', args, { timeout: 30_000 });
  } catch (cause) {
    throw new RouteRefused('Tailscale Serve could not change the route', { cause });
  }
}

async function savedRoutePath() {
  const directory = process.env['PRIVATE_DIR'];
  if (!directory || !isAbsolute(directory)) {
    throw new RouteRefused('Set PRIVATE_DIR to an absolute private directory');
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.uid !== process.getuid?.() ||
      (details.mode & 0o7777) !== 0o700) {
    throw new RouteRefused('PRIVATE_DIR needs mode 0700 and must belong to the current user');
  }
  return join(directory, 'demo-serve-target');
}

async function packageSettings(valuesFile: string) {
  const values = valuesSchema.parse(JSON.parse(await readFile(valuesFile, 'utf8')));
  const owner = await verifyPackageOwner();
  const connection = await packageConnectionArgs(owner);
  const fields = 'jsonpath={.data.OIDC_REDIRECT_URI}{"\\n"}{.data.OIDC_POST_LOGOUT_REDIRECT_URI}';
  const args = [...connection.args, '-n', owner.namespace, 'get', 'secret',
    values.secrets.runtime, '-o', fields];
  const result = await execute('kubectl', args, { env: connection.environment, timeout: 10_000 });
  const [encodedSignIn, encodedSignOut] = result.stdout.split('\n');
  const redirect = Buffer.from(encodedSignIn ?? '', 'base64').toString('utf8');
  const logoutRedirect = Buffer.from(encodedSignOut ?? '', 'base64').toString('utf8');
  const forwardArgs = packageForwardArgs(connection.args, owner.namespace, localOrigin);
  return { host: values.exposure.public.host, redirect, logoutRedirect, forwardArgs };
}

type RollbackAction = 'pause' | 'restore' | 'check-demo';

export async function rollbackPilotRoute(action: RollbackAction,
  route: { savedRoute: string; pilotTarget: string }, controls: ServeControls) {
  const { pilotTarget, savedRoute } = route;
  const demoTarget = await readSavedRoute(savedRoute);
  if (!demoTarget || !loopbackPort(demoTarget) || sameLoopbackAddress(demoTarget, pilotTarget)) {
    throw new RouteRefused('The saved demo Serve target is missing or invalid');
  }
  const host = await checkedDeviceName(controls);
  const current = await currentTarget(host, controls);
  const showingDemo = sameLoopbackAddress(current, demoTarget);
  const showingPilot = sameLoopbackAddress(current, pilotTarget);
  if (current !== undefined && !showingDemo && !showingPilot) {
    throw new RouteRefused('The current Serve target differs from the saved demo and the pilot');
  }
  if (action === 'pause') {
    if (showingPilot) {
      await controls.serve('off');
      if (await currentTarget(host, controls) !== undefined) {
        throw new RouteRefused('Tailscale Serve did not remove the pilot route');
      }
    }
    return;
  }
  if (action === 'restore' && !showingDemo) {
    await controls.serve(demoTarget);
  }
  const restored = await currentTarget(host, controls);
  if (!sameLoopbackAddress(restored, demoTarget)) {
    throw new RouteRefused('Tailscale Serve does not report the saved demo target');
  }
}

async function main() {
  const [action, valuesFile] = process.argv.slice(2);
  if (!secondary) {
    throw new RouteRefused('Set DEV_STACK_ID to the secondary pilot slot');
  }
  const savedRoute = await savedRoutePath();
  const controls = { deviceName, serveStatus, serve };
  if ((action === 'pause' || action === 'restore' || action === 'check-demo') && !valuesFile) {
    await rollbackPilotRoute(action, { savedRoute, pilotTarget: localOrigin }, controls);
    if (action !== 'pause') {
      console.log('PASS Tailscale Serve reports the saved demo target');
    }
    return;
  }
  const demoTarget = process.env['PILOT_DEMO_TARGET'];
  if (action !== 'switch' || !valuesFile || !demoTarget || process.argv.length !== 4) {
    throw new RouteRefused('For a switch, set PILOT_DEMO_TARGET and pass the package values file');
  }
  const { forwardArgs, ...installed } = await packageSettings(valuesFile);
  function ownsForwarder(origin: string) {
    return ownsPackageForwarder(origin, forwardArgs);
  }
  const settings = { ...installed, demoTarget, pilotTarget: localOrigin, savedRoute };
  await switchPilot(settings, { ...controls, ownsForwarder, healthyForwarder });
  console.log('PASS pilot route is active and the demo target is saved');
}

function failed(cause: unknown) {
  const message = cause instanceof RouteRefused
    ? cause.message : 'Could not check the device, package settings or saved route';
  console.error(`Pilot route refused. ${message}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(failed);
}
