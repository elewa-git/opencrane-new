import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { createStore } from '@opencrane/authz';
import { base, directory, exists, generate, readEnv, root, save, writeEnv, prepareDirectory } from './config.ts';

const exec = promisify(execFile);
const names = ['members', 'mcp-catalogue', 'dispatcher', 'server', 'web'];
async function run(command: string, args: string[], env: Record<string, string> = base) {
  // Capture output in private files: database URLs and provider errors can contain secrets.
  try { return (await exec(command, args, { cwd: root, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    await save('last-error.log', String(error));
    throw new Error(`${command} failed; see the private last-error.log`);
  }
}
async function compose(...args: string[]) {
  return run('docker', ['compose', '--env-file', `${directory}/settings.env`, '-f', 'infra/dev-stack/compose.yaml', ...args]);
}
async function wait(check: () => Promise<boolean>, name: string) {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${name}`);
}
async function healthy(url: string) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
async function fingerprint(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}
async function processId(name: string) {
  const file = `${directory}/${name}.pid`;
  if (!(await exists(file))) return undefined;
  const [pid, start] = (await readFile(file, 'utf8')).split(' ');
  return start && await fingerprint(Number(pid)) === start ? Number(pid) : undefined;
}
async function start(name: string, args: string[], env: Record<string, string>) {
  if (await processId(name)) return;
  const log = await open(`${directory}/${name}.log`, 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, { cwd: name === 'web' ? `${root}/apps/web` : root, env: { ...base, ...env }, detached: true,
      stdio: ['ignore', log.fd, log.fd] });
    await once(child, 'spawn');
    const pid = child.pid!;
    await save(`${name}.pid`, `${pid} ${await fingerprint(pid)}`);
    child.unref();
  } finally { await log.close(); }
}
type ServeStatus = { TCP?: Record<string, unknown>, Web?: Record<string, { Handlers?: Record<string, unknown> }> };
async function serveOwnership(settings: Record<string, string>) {
  const status = JSON.parse(await run('tailscale', ['serve', 'status', '--json'])) as ServeStatus;
  const web = Object.entries(status.Web ?? {}).filter(([address]) => address.endsWith(':443'));
  if (status.TCP?.['443'] === undefined && !web.length) return 'absent';
  const expected = `http://127.0.0.1:${settings['WEB_PORT']}`;
  const tcp = status.TCP?.['443'] as { HTTPS?: boolean } | undefined;
  const handlers = web[0]?.[1].Handlers;
  const handler = handlers?.['/'] as { Proxy?: string } | undefined;
  return tcp?.HTTPS === true && Object.keys(tcp).length === 1
    && web.length === 1 && web[0]?.[0] === `${new URL(settings['ORIGIN']!).hostname}:443`
    && handlers && Object.keys(handlers).length === 1
    && handler?.Proxy === expected && Object.keys(handler).length === 1 ? 'owned' : 'foreign';
}
async function stop() {
  if (await exists(`${directory}/settings.env`)) {
    const settings = await readEnv('settings');
    const ownership = await serveOwnership(settings);
    if (ownership === 'foreign') throw new Error(`Refusing to remove HTTPS :443 Serve handler: expected ${settings['ORIGIN']} to map to 127.0.0.1:${settings['WEB_PORT']}`);
    if (ownership === 'owned') await run('sudo', ['-n', 'tailscale', 'serve', '--https=443', 'off']);
  }
  await rm(`${directory}/serve-owned`, { force: true });
  for (const name of [...names].reverse()) {
    const pid = await processId(name);
    if (pid) {
      process.kill(-pid, 'SIGTERM');
      await wait(async () => !(await processId(name)), name);
    }
    await rm(`${directory}/${name}.pid`, { force: true });
  }
  if (await exists(`${directory}/settings.env`)) await compose('down', '--remove-orphans');
}
async function initialiseDatabase() {
  if (await exists(`${directory}/database-ready`)) return;
  const env = await readEnv('admin');
  const pool = new Pool({ connectionString: env['DATABASE_URL'] });
  try {
    const passwords = JSON.parse(await readFile(`${directory}/passwords.json`, 'utf8')) as Record<string, string>;
    for (const role of ['projection', 'server', 'dispatcher', 'openfga']) {
      if (!(await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rows.length) {
        const password = passwords[role];
        if (!password || !/^[a-f0-9]{64}$/u.test(password)) throw new Error('Invalid generated password');
        await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      }
    }
    for (const [db, owner] of [['projections', 'projection'], ['handlers', 'dispatcher'], ['openfga', 'openfga']]) {
      if (!(await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', [db])).rows.length) {
        await pool.query(`CREATE DATABASE ${db} OWNER ${owner}`);
      }
      await pool.query(`REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC`);
      await pool.query(`GRANT CONNECT ON DATABASE ${db} TO ${owner}${db === 'projections' ? ', server' : ''}`);
    }
  } finally { await pool.end(); }
  const projection = new Pool({ connectionString: (await readEnv('projection'))['DATABASE_URL'] });
  try {
    await projection.query('GRANT USAGE ON SCHEMA public TO server');
    await projection.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO server');
  } finally { await projection.end(); }
  await save('database-ready', 'ready');
}
async function up(fresh: boolean) {
  const tail = JSON.parse(await run('tailscale', ['status', '--json'])) as { Self: { DNSName: string, TailscaleIPs: string[] } };
  const origin = `https://${tail.Self.DNSName.replace(/\.$/u, '')}`;
  await generate(origin);
  if (fresh) {
    await stop();
    await compose('down', '--volumes', '--remove-orphans');
    // The ownership marker fences this directory to this worktree.
    const files = await import('node:fs/promises').then((fs) => fs.readdir(directory));
    for (const file of files) if (file !== 'stack-owner') await rm(`${directory}/${file}`);
    await generate(origin);
  }
  const settings = await readEnv('settings');
  if (settings['ORIGIN'] !== origin) throw new Error('Tailnet name changed; use --fresh');
  await compose('up', '-d', '--wait', 'postgres', 'nats', 'minio');
  await initialiseDatabase();
  await compose('up', '-d', 'openfga');
  await wait(() => healthy(`${settings['OPENFGA_API_URL']}/healthz`), 'OpenFGA');
  await wait(() => healthy(`http://127.0.0.1:${settings['MINIO_PORT']}/minio/health/live`), 'MinIO');
  await run('npm', ['run', 'provision'], { ...base, ...await readEnv('command') });
  if (!(await exists(`${directory}/binding.env`))) {
    const binding = await createStore(settings['OPENFGA_API_URL']!, settings['SILO_ID']!);
    await writeEnv('binding', { SILO_ID: binding.silo, OPENFGA_API_URL: binding.apiUrl,
      OPENFGA_STORE_ID: binding.storeId, OPENFGA_MODEL_ID: binding.authorizationModelId });
  }
  const binding = await readEnv('binding');
  for (const name of ['members', 'mcp-catalogue']) {
    await start(name, ['--experimental-strip-types', 'apps/ops/src/worker.ts', name], await readEnv('projection'));
  }
  await start('dispatcher', ['--experimental-strip-types', 'apps/ops/src/worker.ts', 'dispatcher'],
    { ...await readEnv('dispatcher'), ...binding });
  await start('server', ['--experimental-strip-types', 'apps/server/src/main.ts'],
    { ...await readEnv('command'), ...await readEnv('auth'), ...await readEnv('server'), ...binding });
  await wait(() => healthy(`http://127.0.0.1:${settings['SERVER_PORT']}/healthz`), 'server');
  await start('web', [`${root}/node_modules/@angular/cli/bin/ng.js`, 'serve', '--project', 'web', '--host', '127.0.0.1',
    '--port', settings['WEB_PORT']!, '--proxy-config', `${directory}/proxy.json`], { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(origin).hostname });
  await wait(() => healthy(`http://127.0.0.1:${settings['WEB_PORT']}/org/integrations`), 'web');
  const ownership = await serveOwnership(settings);
  if (ownership === 'foreign') throw new Error(`Refusing to replace HTTPS :443 Serve handler: expected ${origin} to map to 127.0.0.1:${settings['WEB_PORT']}`);
  if (ownership === 'absent') {
    await run('sudo', ['-n', 'tailscale', 'serve', '--bg', '--https=443', `http://127.0.0.1:${settings['WEB_PORT']}`]);
  }
  await wait(() => healthy(`${origin}/org/integrations`), 'tailnet HTTPS');
  await journey();
  const after = await run('ss', ['-H', '-ltnp']);
  await save('listeners-after.txt', after);
  const pids = await Promise.all(names.map(processId));
  for (let i = 0; i < names.length; i++) if (!pids[i]) throw new Error(`${names[i]} stopped`);
  const ports = new Set(['443', ...['PG_PORT', 'NATS_PORT', 'FGA_PORT', 'MINIO_PORT', 'MINIO_CONSOLE_PORT', 'SERVER_PORT', 'WEB_PORT']
    .map((name) => settings[name]!)]);
  const allowed = new Set(['127.0.0.1', '::1', ...tail.Self.TailscaleIPs]);
  for (const line of after.trim().split('\n')) {
    const address = line.trim().split(/\s+/u)[3]!;
    const match = /^(?:\[(.*)\]|([^:]*)):(\d+)$/u.exec(address);
    const ownedProcess = pids.some((pid) => line.includes(`pid=${pid},`));
    if (ownedProcess && !match) throw new Error(`Cannot verify stack listener address: ${address}`);
    if ((ownedProcess || ports.has(match?.[3] ?? '')) && !allowed.has(match?.[1] ?? match?.[2] ?? '')) {
      throw new Error(`Stack listener is not on loopback or Tailscale: ${address}`);
    }
  }
  console.log('PASS listener check: every stack listener is on loopback or Tailscale');
  console.log(`Stack ready: ${origin}/org/integrations (dev-only test sessions; OIDC pending #11)`);
}
async function journey() {
  const output = await run(process.execPath, ['--experimental-strip-types', 'infra/dev-stack/journey.ts'],
    { ...base, DEV_STACK_DIR: directory });
  console.log(output.trim());
}
async function status() {
  let ok = true;
  for (const name of names) {
    const pid = await processId(name);
    console.log(`${name}: ${pid ? `running (${pid})` : 'stopped'}`);
    if (!pid) ok = false;
  }
  if (await exists(`${directory}/settings.env`)) {
    console.log(await compose('ps'));
    const settings = await readEnv('settings');
    for (const url of [`http://127.0.0.1:${settings['SERVER_PORT']}/healthz`,
      `${settings['OPENFGA_API_URL']}/healthz`, `http://127.0.0.1:${settings['MINIO_PORT']}/minio/health/live`,
      `${settings['ORIGIN']}/org/integrations`]) {
      const up = await healthy(url);
      console.log(`${up ? 'healthy' : 'unavailable'}: ${url}`);
      if (!up) ok = false;
    }
  }
  console.log(await run('tailscale', ['serve', 'status']));
  if (!ok) process.exitCode = 1;
}
let prepared = false;
try {
  await prepareDirectory();
  prepared = true;
  const [action, flag, extra] = process.argv.slice(2);
  if (extra || (flag && !(action === 'up' && flag === '--fresh'))) throw new Error('Usage: up.sh [--fresh], down.sh, status.sh, journey.sh');
  switch (action) {
    case 'up': await up(flag === '--fresh'); break;
    case 'down': await stop(); break;
    case 'status': await status(); break;
    case 'journey': await journey(); break;
    default: throw new Error('Unknown stack action');
  }
} catch (error) {
  // Error causes may contain database passwords; never print raw dependency errors.
  if (prepared) await save('failure.log', String(error));
  console.error(prepared ? `Dev stack failed; inspect private logs in ${directory}` : 'DEV_STACK_DIR must be an empty dedicated directory outside the repository, or owned by this worktree');
  process.exitCode = 1;
}
