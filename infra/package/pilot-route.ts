import { execFile } from 'node:child_process';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { localOrigin, secondary } from '../dev-stack/identity.ts';
import { packageConnectionArgs, verifyPackageOwner } from '../dev-stack/packaged.ts';

export interface PilotRouteSettings {
  host: string;
  demoTarget: string;
  pilotTarget: string;
  savedRoute: string;
  redirect: string;
  logoutRedirect: string;
}

export interface PilotRouteControls {
  deviceName(): Promise<string>;
  serveStatus(): Promise<unknown>;
  healthyForwarder(origin: string): Promise<boolean>;
  serve(origin: string): Promise<void>;
}

const execute = promisify(execFile);
const tailnetName = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.){2,}ts\.net$/u;
const loopbackTarget = /^http:\/\/(?:127\.0\.0\.1|localhost):[1-9][0-9]{0,4}$/u;
const serveStatusSchema = z.object({
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
  Web: z.record(z.string(), z.object({
    Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() }).passthrough()),
  })).nullish(),
});
const deviceSchema = z.object({ Self: z.object({ DNSName: z.string().max(254) }) });
const valuesSchema = z.object({
  exposure: z.object({ public: z.object({ enabled: z.literal(true), host: z.string() }) }),
  secrets: z.object({ runtime: z.string().min(1) }),
});
const healthSchema = z.object({ authenticated: z.literal(false) });

class RouteRefused extends Error {}

async function checkedDeviceName(controls: PilotRouteControls): Promise<string> {
  const dnsName = await controls.deviceName();
  const hostname = dnsName.replace(/\.$/u, '');
  if (!tailnetName.test(hostname)) {
    throw new RouteRefused('This device needs its own tailnet DNS name');
  }
  return hostname;
}

async function currentTarget(host: string, controls: PilotRouteControls) {
  const config = serveStatusSchema.parse(await controls.serveStatus());
  const funnel = Object.values(config.AllowFunnel ?? {});
  if (funnel.includes(true)) {
    throw new RouteRefused('Turn off Tailscale Funnel before changing the pilot route');
  }
  const handler = config.Web?.[`${host}:443`]?.Handlers['/'];
  if (handler && (!handler.Proxy || Object.keys(handler).length !== 1)) {
    throw new RouteRefused('The current Serve target is not a single proxy');
  }
  return handler?.Proxy;
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
  if (settings.demoTarget === settings.pilotTarget || !loopbackTarget.test(settings.demoTarget)) {
    throw new RouteRefused('The expected demo Serve target must be a separate loopback address');
  }
}

export async function switchPilot(settings: PilotRouteSettings, controls: PilotRouteControls) {
  const host = await checkedDeviceName(controls);
  checkPilotAddress(host, settings);
  const saved = await readSavedRoute(settings.savedRoute);
  if (saved !== undefined && saved !== settings.demoTarget) {
    throw new RouteRefused('The saved Serve target differs from the expected demo target');
  }
  if (!await controls.healthyForwarder(settings.pilotTarget)) {
    throw new RouteRefused('The claimed slot’s pilot forwarder did not pass its sign-in check');
  }

  const current = await currentTarget(host, controls);
  if (current === settings.pilotTarget && saved === settings.demoTarget) {
    return;
  }
  if (current !== settings.demoTarget) {
    throw new RouteRefused('The current Serve target differs from the expected demo target');
  }
  if (saved === undefined) {
    // Keep the first demo route through a repeat or an interrupted switch.
    await writeFile(settings.savedRoute, `${current}\n`, { flag: 'wx', mode: 0o600 });
  }
  await controls.serve(settings.pilotTarget);
  const switched = await currentTarget(host, controls);
  if (switched !== settings.pilotTarget) {
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
  return { host: values.exposure.public.host, redirect, logoutRedirect };
}

type RollbackAction = 'pause' | 'restore' | 'check-demo';

export async function rollbackPilotRoute(action: RollbackAction,
  route: { savedRoute: string; pilotTarget: string }, controls: PilotRouteControls) {
  const { pilotTarget, savedRoute } = route;
  const demoTarget = await readSavedRoute(savedRoute);
  if (!demoTarget || !loopbackTarget.test(demoTarget) || demoTarget === pilotTarget) {
    throw new RouteRefused('The saved demo Serve target is missing or invalid');
  }
  const host = await checkedDeviceName(controls);
  const current = await currentTarget(host, controls);
  if (current !== undefined && current !== demoTarget && current !== pilotTarget) {
    throw new RouteRefused('The current Serve target differs from the saved demo and the pilot');
  }
  if (action === 'pause') {
    if (current === pilotTarget) {
      await controls.serve('off');
      if (await currentTarget(host, controls) !== undefined) {
        throw new RouteRefused('Tailscale Serve did not remove the pilot route');
      }
    }
    return;
  }
  if (action === 'restore' && current !== demoTarget) {
    await controls.serve(demoTarget);
  }
  if (await currentTarget(host, controls) !== demoTarget) {
    throw new RouteRefused('Tailscale Serve does not report the saved demo target');
  }
}

async function main() {
  const [action, valuesFile] = process.argv.slice(2);
  if (!secondary) {
    throw new RouteRefused('Set DEV_STACK_ID to the secondary pilot slot');
  }
  const savedRoute = await savedRoutePath();
  const controls = { deviceName, serveStatus, healthyForwarder, serve };
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
  const installed = await packageSettings(valuesFile);
  await switchPilot({ ...installed, demoTarget, pilotTarget: localOrigin, savedRoute }, controls);
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
