import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { z } from 'zod';
import { localOrigin, secondary } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';
import { ownsPackageForwarder, packageForwardArgs, readForwardTarget } from './package-forwarder.ts';

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
  serveStatus(): Promise<ServeSnapshot>;
  serve(origin: string, checked: CheckedRoute): Promise<void>;
}

type ServeSnapshot = { configuration: unknown; etag: string };

export interface PilotRouteControls extends ServeControls {
  ownsForwarder(origin: string): Promise<boolean>;
  healthyForwarder(origin: string): Promise<boolean>;
}

const execute = promisify(execFile);
const tailnetName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}ts\.net$/u;
const loopbackTarget = /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})$/u;
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
type CheckedRoute = {
  configuration: z.infer<typeof serveStatusSchema>; etag: string;
  host: string; target: string | undefined;
};

function hasFunnel(session: ServeSession) {
  const funnel = Object.values(session.AllowFunnel ?? {});
  return funnel.includes(true);
}

function hasServices(session: ServeSession) {
  const services = Object.keys(session.Services ?? {});
  return services.length > 0;
}

function hasServeHandlers(session: ServeSession) {
  const ports = Object.keys(session.TCP ?? {});
  const sites = Object.keys(session.Web ?? {});
  return hasServices(session) || ports.length > 0 || sites.length > 0;
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
  // An empty route can be restored. An active root must already have its HTTPS listener.
  if (paths.length !== 1 || !handler.success || !config.TCP?.['443']) {
    throw unexpectedHandler();
  }
  return handler.data.Proxy;
}

async function checkedRoute(host: string, controls: ServeControls): Promise<CheckedRoute> {
  const snapshot = await controls.serveStatus();
  const config = serveStatusSchema.parse(snapshot.configuration ?? {});
  const foreground = Object.values(config.Foreground ?? {});
  if (hasFunnel(config) || foreground.some(hasFunnel)) {
    throw new RouteRefused('Turn off Tailscale Funnel before changing the pilot route');
  }
  if (hasServices(config) || foreground.some(hasServeHandlers)) {
    throw unexpectedHandler();
  }
  return { configuration: config, etag: snapshot.etag, target: rootTarget(host, config), host };
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
  if (!origin) {
    return undefined;
  }
  const match = loopbackTarget.exec(origin);
  if (!match) {
    return undefined;
  }
  const port = Number(match[1]);
  if (port <= 65535) {
    return port;
  }
  return undefined;
}

function sameLoopbackAddress(first: string | undefined, second: string) {
  // Treat the two local names as the same route only when both ports are valid and equal.
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
      !loopbackPort(settings.pilotTarget) ||
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
  if (!await controls.healthyForwarder(settings.pilotTarget)) {
    throw new RouteRefused('The claimed slot’s pilot forwarder did not pass its sign-in check');
  }
  if (!await controls.ownsForwarder(settings.pilotTarget)) {
    throw new RouteRefused('The claimed slot’s pilot forwarder is not listening on its port');
  }
  const current = await checkedRoute(host, controls);
  if (sameLoopbackAddress(current.target, settings.pilotTarget) && saved !== undefined) {
    return;
  }
  if (!current.target || !sameLoopbackAddress(current.target, settings.demoTarget)) {
    throw new RouteRefused('The current Serve target differs from the expected demo target');
  }
  if (saved === undefined) {
    // Keep the first demo route through a repeat or an interrupted switch.
    await writeFile(settings.savedRoute, `${current.target}\n`, { flag: 'wx', mode: 0o600 });
  }
  // Check the listener after the file and network reads, just before the conditional write.
  if (!await controls.ownsForwarder(settings.pilotTarget)) {
    throw new RouteRefused('The claimed slot’s pilot forwarder changed before switching');
  }
  await controls.serve(settings.pilotTarget, current);
  try {
    const switched = await checkedRoute(host, controls);
    if (sameLoopbackAddress(switched.target, settings.pilotTarget)) return;
    throw new Error('Tailscale Serve reported a different target');
  } catch (cause) {
    throw new RouteRefused('Tailscale Serve switch unconfirmed. Stop and run the saved demo recovery',
      { cause });
  }
}

async function deviceName() {
  const response = await execute('tailscale', ['status', '--json'], { timeout: 5000 });
  const status = deviceSchema.parse(JSON.parse(response.stdout));
  return status.Self.DNSName;
}

const serveEndpoint = ['--silent', '--show-error', '--include', '--noproxy', '*',
  '--unix-socket', '/var/run/tailscale/tailscaled.sock',
  'http://local-tailscaled.sock/localapi/v0/serve-config'];
const responseHeader = /\r?\n\r?\n/u;

async function serveRequest(args: string[]) {
  const result = await execute('sudo', ['-n', 'curl', '--disable', ...serveEndpoint, ...args],
    { timeout: 5000, maxBuffer: 1024 * 1024 });
  const split = responseHeader.exec(result.stdout);
  if (!split) throw new RouteRefused('Tailscale did not return a Serve response');
  const headers = result.stdout.slice(0, split.index);
  const body = result.stdout.slice(split.index + split[0].length);
  const status = /^HTTP\/1\.[01] (\d{3})(?: |\r?$)/mu.exec(headers)?.[1];
  return { status, headers, body };
}

async function serveStatus(): Promise<ServeSnapshot> {
  const response = await serveRequest([]);
  const etag = /^etag: ([a-f0-9]{64})\r?$/imu.exec(response.headers)?.[1];
  if (response.status !== '200' || !etag) {
    throw new RouteRefused('Tailscale did not return a checked Serve configuration');
  }
  return { configuration: JSON.parse(response.body) as unknown, etag };
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

async function serve(origin: string, checked: CheckedRoute) {
  const configuration = { ...checked.configuration };
  if (origin === 'off') {
    delete configuration.TCP;
    delete configuration.Web;
  } else {
    configuration.TCP = { '443': { HTTPS: true } };
    configuration.Web = { [`${checked.host}:443`]: { Handlers: { '/': { Proxy: origin } } } };
  }
  const args = ['--request', 'POST', '--header', `If-Match: ${checked.etag}`,
    '--header', 'Content-Type: application/json', '--data-binary', JSON.stringify(configuration)];
  let response: Awaited<ReturnType<typeof serveRequest>>;
  try {
    response = await serveRequest(args);
  } catch (cause) {
    throw new RouteRefused('Tailscale Serve write unconfirmed. Check the saved demo recovery',
      { cause });
  }
  if (response.status === '412') {
    throw new RouteRefused('Tailscale Serve configuration changed after it was checked');
  }
  if (response.status !== '200') {
    throw new RouteRefused('Tailscale Serve could not confirm the change. Check the saved demo recovery');
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
  return { host: values.exposure.public.host, redirect, logoutRedirect, forwardArgs, owner };
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
  const current = await checkedRoute(host, controls);
  const showingDemo = sameLoopbackAddress(current.target, demoTarget);
  const showingPilot = sameLoopbackAddress(current.target, pilotTarget);
  if (current.target !== undefined && !showingDemo && !showingPilot) {
    throw new RouteRefused('The current Serve target differs from the saved demo and the pilot');
  }
  if (action === 'pause') {
    if (showingPilot) {
      await controls.serve('off', current);
      const paused = await checkedRoute(host, controls);
      if (paused.target !== undefined) {
        throw new RouteRefused('Tailscale Serve did not remove the pilot route');
      }
    }
    return;
  }
  if (action === 'restore' && !showingDemo) {
    await controls.serve(demoTarget, current);
  }
  const restored = await checkedRoute(host, controls);
  if (!sameLoopbackAddress(restored.target, demoTarget)) {
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
  const { forwardArgs, owner, ...installed } = await packageSettings(valuesFile);
  async function ownsForwarder(origin: string) {
    try {
      const connection = await packageConnectionArgs(owner);
      const target = await readForwardTarget(connection, owner.namespace, owner.namespaceUid);
      return await ownsPackageForwarder(origin, forwardArgs, target);
    } catch (cause) {
      throw new RouteRefused('Could not check which process owns the pilot port', { cause });
    }
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
