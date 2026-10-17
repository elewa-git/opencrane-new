import { issueMinioLease } from './minio-tokens.ts';
import { Client } from 'minio';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { open, readFile, realpath, rm, stat } from 'node:fs/promises';
import { setPriority } from 'node:os';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { tokenIssuer } from '@opencrane/auth';
import { stackId, secondary, project, namespace, ports as defaultPorts, localOrigin } from './identity.ts';
import { checkPorts } from './ports.ts';
import { modelFirewall } from './model-network.ts';
import { createStore } from '@opencrane/authz';
import { connectEventStore } from '@opencrane/event-store';
import { envelope } from '@opencrane/models';
import { catalogueDigest } from '@opencrane/events/mcp-catalogue';
import { base, directory, exists, generate, readEnv, root, save, writeEnv, prepareDirectory, authEnv } from './config.ts';
import { approvalJourneyTool } from './journey-tool-policy.ts';
import { installPackage, packagedSlotIsBusy, preparePackage, removePackage,
  verifyPackageOwner } from './packaged.ts';

const exec = promisify(execFile);
// Keep a claim for 15 minutes because claim.sh exits before stack startup can finish.
const CLAIM_GRACE_PERIOD_MS = 15 * 60 * 1000;
const memoryKeyDirectory = process.env['MEMORY_KEY_DIRECTORY']?.trim();
const names = ['members', 'mcp-catalogue', 'computers', 'conversations', 'files', 'budgets', 'audit', 'minio-tokens', 'model-stub', 'models', 'dispatcher', 'server', 'web'].filter(name => !secondary || !['models', 'model-stub'].includes(name));
if (memoryKeyDirectory) {
  names.push('memory');
}
async function run(command: string, args: string[], env: Record<string, string> = base, timeout = 180_000) {
  // Capture output in private files: database URLs and provider errors can contain secrets.
  try { return (await exec(command, command === 'kubectl' ? ['--context=k3d-ocn', ...args] : args, { cwd: root, env, timeout, maxBuffer: 8 * 1024 * 1024 })).stdout; }
  catch (error) {
    await save('last-error.log', String(error));
    throw new Error(`${command} failed; see the private last-error.log`);
  }
}
async function compose(...args: string[]) {
  return run('docker', ['compose', '--project-name', project, '--env-file', `${directory}/settings.env`, '-f', 'infra/dev-stack/compose.yaml', ...(secondary ? ['-f', 'infra/dev-stack/compose.secondary.yaml'] : []), ...args]);
}
async function wait(check: () => Promise<boolean>, name: string) {
  // Allow two minutes for secondary startup on the shared host.
  for (let i = 0; i < (secondary ? 240 : 120); i++) {
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
async function processNiceValue(pid: number): Promise<number> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return Number(fields[16]);
}
async function processId(name: string) {
  const file = `${directory}/${name}.pid`;
  if (!(await exists(file))) return undefined;
  const [pid, start] = (await readFile(file, 'utf8')).split(' ');
  return start && await fingerprint(Number(pid)) === start ? Number(pid) : undefined;
}
type StackOwner = {
  worktree: string;
  startedAt: number;
  pid?: number;
  processStart?: string;
};
function ownerField(line: string) {
  const separator = line.indexOf('=');
  return [line.slice(0, separator), line.slice(separator + 1)];
}
async function readStackOwner(): Promise<StackOwner | undefined> {
  const ownerFile = `${directory}/stack-owner`;
  if (!await exists(ownerFile)) return undefined;
  const contents = await readFile(ownerFile, 'utf8');
  if (!contents.startsWith('worktree=')) {
    return { worktree: contents, startedAt: 0 };
  }
  const trimmedContents = contents.trim();
  const lines = trimmedContents.split('\n');
  const entries = lines.map(ownerField);
  const fields = Object.fromEntries(entries);
  if (!fields['worktree']) throw new Error('Invalid secondary stack owner file');
  let startedAt = 0;
  if (fields['startedAt']) {
    startedAt = Date.parse(fields['startedAt']);
    if (!Number.isFinite(startedAt)) {
      throw new Error('Invalid secondary stack owner file');
    }
  }
  const pid = Number(fields['pid']);
  const processStart = fields['processStart'];
  return {
    worktree: fields['worktree']!,
    startedAt,
    ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
    ...(processStart ? { processStart } : {}),
  };
}
async function stackOwnerRecord(pid: number) {
  const processStart = await fingerprint(pid);
  const startRecord = processStart ? `processStart=${processStart}\n` : '';
  return `worktree=${root}\npid=${pid}\nstartedAt=${new Date().toISOString()}\n${startRecord}`;
}
async function ownerProcessIsRunning(owner: StackOwner | undefined) {
  if (!owner?.pid) return false;
  if (owner.processStart) return await fingerprint(owner.pid) === owner.processStart;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    throw error;
  }
}
async function stackProcessIsRunning() {
  const pids = await Promise.all(names.map(processId));
  if (pids.some((pid) => pid !== undefined)) return true;
  try {
    const dockerArguments = [
      'ps', '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'status=running', '--quiet',
    ];
    const result = await exec('docker', dockerArguments, { env: base, timeout: 10_000 });
    return result.stdout.trim().length > 0;
  } catch {
    // Treat an unavailable Docker daemon as busy; reclaim only when containers are checked.
    return true;
  }
}
async function slotIsFree() {
  const owner = await readStackOwner();
  if (!owner && await stat(directory).then(() => true, () => false)) return false;
  if (owner && Date.now() - owner.startedAt < CLAIM_GRACE_PERIOD_MS) {
    return false;
  }
  if (await ownerProcessIsRunning(owner)) return false;
  if (await packagedSlotIsBusy()) return false;
  return !await stackProcessIsRunning();
}
async function start(name: string, args: string[], env: Record<string, string>) {
  if (await processId(name)) return;
  const log = await open(`${directory}/${name}.log`, 'a', 0o600);
  try {
    const child = spawn(process.execPath, args, { cwd: name === 'web' ? `${root}/apps/web` : root, env: { ...base, ...(secondary ? { NODE_OPTIONS: `--max-old-space-size=${name === 'web' ? 768 : 256}` } : {}), ...env }, detached: true,
      stdio: ['ignore', log.fd, log.fd] });
    await once(child, 'spawn');
    const pid = child.pid!;
    if (name === 'web') {
      const niceValue = await processNiceValue(pid);
      // Avoid changing a priority the parent already lowered for this web process.
      if (niceValue < 10) setPriority(pid, 10);
    }
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
  if (!secondary && await exists(`${directory}/settings.env`)) {
    const settings = await readEnv('settings');
    const ownership = await serveOwnership(settings);
    if (ownership === 'foreign') throw new Error(`Refusing to remove HTTPS :443 Serve handler: expected ${settings['ORIGIN']} to map to 127.0.0.1:${settings['WEB_PORT']}`);
    if (ownership === 'owned') await run('sudo', ['-n', 'tailscale', 'serve', '--https=443', 'off']);
  }
  await rm(`${directory}/serve-owned`, { force: true });
  await stopProcesses([...names].reverse());
  if (!secondary) await modelFirewall(false);
  if (await exists(`${directory}/settings.env`)) await compose('down', '--remove-orphans');
}
async function stopProcesses(processes: string[]) {
  for (const name of processes) {
    const pid = await processId(name);
    if (pid) {
      process.kill(-pid, 'SIGTERM');
      await wait(async () => !(await processId(name)), name);
    }
    await rm(`${directory}/${name}.pid`, { force: true });
  }
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
function prefixed(values: Record<string, string>, prefix: string) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`${prefix}${name}`, value]));
}
async function provisionComputers(settings: Record<string, string>) {
  if (!(await run('kubectl', ['get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'])).trim()) {
    await run('kubectl', ['create', 'namespace', namespace]);
  }
  if (secondary) {
    // Keep one extra disk so a repeat can retain saved data and start a new shared assistant.
    const quota = {
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'journey-limit', namespace },
      spec: {
        hard: {
          pods: '6',
          'limits.memory': '3Gi',
          persistentvolumeclaims: '6',
          'requests.storage': '6Gi',
        },
      },
    };
    await save('quota.json', JSON.stringify(quota));
    await run('kubectl', ['apply', '-f', `${directory}/quota.json`]);
  }
  await run('node', ['infra/dev-stack/computer-admission.mjs', namespace]);
  await run('kubectl', ['-n', namespace, 'apply', '-f', 'infra/dev-stack/computer-worker-rbac.yaml']);
  await run('kubectl', ['-n', namespace, 'apply', '-f', 'apps/computer/sandbox-template.json']);
  await run('kubectl', ['-n', namespace, 'apply', '-f', 'apps/computer/network-policy.json']);
  await run('kubectl', ['-n', namespace, 'apply', '-f', 'infra/dev-stack/computer-pool.json']);
  // Keep service Pods, such as the model gateway, outside the namespace whose admission policy
  // only accepts Pods that match the computer template.
  const gatewayNamespace = `${namespace}-gateway`;
  if (!(await run('kubectl', ['get', 'namespace', gatewayNamespace, '--ignore-not-found', '-o', 'name'])).trim()) {
    await run('kubectl', ['create', 'namespace', gatewayNamespace]);
  }
  let modelHost = `host.k3d.internal:${settings['MODEL_GATEWAY_PORT'] ?? '43000'}`;
  if (secondary) {
    const container = (await compose('ps', '-q', 'nats')).trim();
    const address = (await run('docker', ['inspect', '--format', '{{(index .NetworkSettings.Networks "k3d-ocn").IPAddress}}', container])).trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/u.test(address)) throw new Error('Missing private model address');
    modelHost = `${address}:${settings['MODEL_GATEWAY_PORT']}`;
  }
  await save('gateway.yaml', (await readFile(`${root}/infra/dev-stack/gateway.yaml`, 'utf8'))
    .replace('host.k3d.internal:43000', modelHost));
  await run('kubectl', ['-n', gatewayNamespace, 'apply', '-f', `${directory}/gateway.yaml`]);
  await run('kubectl', ['-n', gatewayNamespace, 'rollout', 'status', 'deployment/gateway', '--timeout=120s']);
  const address = (await run('kubectl', ['-n', gatewayNamespace, 'get', 'service/gateway', '-o', 'jsonpath={.spec.clusterIP}'])).trim();
  await save('computer-runtime.json', JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: 'computer-runtime', namespace }, data: { gateway: `http://${address}:3000` } }));
  await run('kubectl', ['apply', '-f', `${directory}/computer-runtime.json`]);
  await save('model-egress.json', JSON.stringify({ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: { name: 'model-gateway', namespace }, spec: { podSelector: { matchLabels: { app: 'computer' } },
      policyTypes: ['Egress'], egress: [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': gatewayNamespace } },
        podSelector: { matchLabels: { app: 'opencrane-gateway' } } }], ports: [{ protocol: 'TCP', port: 3000 }] }] } }));
  await run('kubectl', ['apply', '-f', `${directory}/model-egress.json`]);
  const raw = JSON.parse(await run('kubectl', ['config', 'view', '--raw', '--minify', '-o', 'json'])) as {
    clusters: Array<{ cluster: unknown }>;
  };
  const token = (await run('kubectl', ['-n', namespace, 'create', 'token', 'computer-lifecycle', '--duration=24h'])).trim();
  await save('computer-kubeconfig.json', JSON.stringify({ apiVersion: 'v1', kind: 'Config',
    clusters: [{ name: 'ocn', cluster: raw.clusters[0]?.cluster }], users: [{ name: 'lifecycle', user: { token } }],
    contexts: [{ name: 'ocn', context: { cluster: 'ocn', user: 'lifecycle', namespace } }], 'current-context': 'ocn' }));
  return { namespace, kubeconfig: `${directory}/computer-kubeconfig.json` };
}
async function removeComputers() {
  await run('kubectl', ['delete', 'namespace', namespace, `${namespace}-gateway`, '--ignore-not-found', '--wait=true', '--timeout=180s']);
  if (secondary) for (const kind of ['validatingadmissionpolicybindings', 'validatingadmissionpolicies']) {
    await run('kubectl', ['delete', kind, ...['sandbox', 'pod', 'claim'].map(suffix => `${namespace}-computer-${suffix}`), '--ignore-not-found']);
  }
}
async function up(fresh: boolean) {
  const tail = secondary ? { Self: { DNSName: '', TailscaleIPs: [] } } : JSON.parse(await run('tailscale', ['status', '--json'])) as { Self: { DNSName: string, TailscaleIPs: string[] } };
  const origin = secondary ? localOrigin : `https://${tail.Self.DNSName.replace(/\.$/u, '')}`;
  await run('flock', ['--close', `/tmp/opencrane-dev-stack-zitadel-${process.getuid!()}.lock`,
    process.execPath, '--experimental-strip-types', 'infra/dev-stack/zitadel-setup.ts', ...(secondary ? [] : ['--restore-owner-app'])],
  { ...base, ...(process.env['ZITADEL_KEY_FILE'] ? { ZITADEL_KEY_FILE: process.env['ZITADEL_KEY_FILE'] } : {}) });
  await generate(origin);
  if (secondary && !await exists(`${directory}/models.env`)) await writeEnv('models', {});
  if (fresh) {
    await stop();
    // Rebuild local workspace packages after the daily checkout changes their exports.
    if (secondary) {
      await rm(`${root}/apps/web/.angular/cache`, { recursive: true, force: true });
    }
    await compose('down', '--volumes', '--remove-orphans');
    await removeComputers();
    // Use the owner record to make sure this worktree only removes its own stack directory.
    const files = await import('node:fs/promises').then((fs) => fs.readdir(directory));
    for (const file of files) if (file !== 'stack-owner' && !file.startsWith('zitadel-') && file !== 'zitadel.json') await rm(`${directory}/${file}`, { recursive: true });
    await generate(origin);
    if (secondary) await writeEnv('models', {});
  }
  const settings = { ...defaultPorts, ...await readEnv('settings') };
  await checkPorts(settings, await Promise.all(names.map(processId)), project);
  if (settings['ORIGIN'] !== origin) throw new Error('Tailnet name changed; use --fresh');
  await compose('up', '-d', '--wait', 'postgres', 'nats', 'minio', 'clamav');
  const computer = await provisionComputers(settings);
  await initialiseDatabase();
  await compose('up', '-d', 'openfga');
  await wait(() => healthy(`${settings['OPENFGA_API_URL']}/healthz`), 'OpenFGA');
  await wait(() => healthy(`http://127.0.0.1:${settings['MINIO_PORT']}/minio/health/live`), 'MinIO');
  // Keep decision services and event writers stopped during migrations, including on repeat starts.
  await stopProcesses(['server', 'dispatcher', 'models']);
  if (secondary) await compose('stop', 'models');
  const minio = await readEnv('minio');
  const credentials = { accessKey: minio['MINIO_ROOT_USER']!, secretKey: minio['MINIO_ROOT_PASSWORD']! };
  const objects = new Client({ endPoint: '127.0.0.1', port: Number(settings['MINIO_PORT']), useSSL: false, ...credentials });
  for (const bucket of ['quarantine', 'files']) if (!await objects.bucketExists(bucket)) await objects.makeBucket(bucket);
  await issueMinioLease();
  await start('minio-tokens', ['--experimental-strip-types', 'infra/dev-stack/minio-tokens.ts'], { DEV_STACK_DIR: directory });
  await objects.setBucketLifecycle('quarantine', { Rule: [{ ID: 'abandoned-uploads', Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: 1 } }] });
  await run('npm', ['run', 'provision'], { ...base, ...await readEnv('command') });
  if (secondary) {
    // Stop keeps reservations whose outcome is unknown, so leave room for each stub journey.
    const events = await connectEventStore(await readEnv('command'));
    try {
      const subject = `budget-${settings['SILO_ID']!}`;
      let exists = false;
      for await (const _stored of events.store.readStream(subject)) { exists = true; break; }
      if (!exists) {
        const event = envelope(settings['SILO_ID']!, subject, 'budget.ceiling_set',
          { scope: 'global', ceilingCents: 100000, dailyCeilingCents: 100000, setBy: 'dev-only-stub-journey' });
        event.source = 'dev-stack-stub-fixture'; event.principal = { kind: 'system', id: 'dev-only-stub-journey' };
        if ((await events.store.append({ event, expectedSequence: 0 })).status !== 'appended') throw new Error('Stub budget seed conflict');
      }
    } finally { await events.close(); }
  }
  await run('npm', ['run', 'migrate:model-grants', '-w', 'apps/ops'],
    { ...base, ...await readEnv('command'), SILO_ID: settings['SILO_ID']! });
  const events = await connectEventStore(await readEnv('command'));
  try {
    const silo = settings['SILO_ID']!, subject = `budget-${silo}`;
    // Set the test budget before its writer starts. Stop keeps uncertain reservations, so leave
    // enough room for both fresh and repeat runs.
    if (!await events.store.head(subject)) {
      const event = envelope(silo, subject, 'budget.ceiling_set', {
        scope: 'global', dailyCeilingCents: 4000, ceilingCents: 20000, setBy: 'dev-stack-stub',
      });
      if ((await events.store.append({ event, expectedSequence: 0 })).status !== 'appended') throw new Error('Stub budget seed failed');
    }
  } finally { await events.close(); }
  await run('npm', ['run', 'migrate:budget-default', '-w', 'apps/ops'],
    { ...base, ...await readEnv('command'), SILO_ID: settings['SILO_ID']!,
      DEFAULT_PAYING_GROUP_ID: process.env['DEFAULT_PAYING_GROUP_ID'] ?? 'installation-default' });
  if (!(await exists(`${directory}/binding.env`))) {
    const binding = await createStore(settings['OPENFGA_API_URL']!, settings['SILO_ID']!);
    await writeEnv('binding', { SILO_ID: binding.silo, OPENFGA_API_URL: binding.apiUrl,
      OPENFGA_STORE_ID: binding.storeId, OPENFGA_MODEL_ID: binding.authorizationModelId });
  }
  const binding = await readEnv('binding');
  for (const name of ['members', 'mcp-catalogue', 'computers', 'conversations', 'files', 'budgets',
    'audit', 'memory']) {
    const projectionEnv = await readEnv('projection');
    if (memoryKeyDirectory) {
      projectionEnv['MEMORY_KEY_DIRECTORY'] = memoryKeyDirectory;
    }
    await start(name, ['--experimental-strip-types', 'apps/ops/src/worker.ts', name], projectionEnv);
  }
  const issuer = await tokenIssuer({ privateKeyPath: `${directory}/token-signing-key.pem`, issuer: `${settings['ORIGIN']}/` });
  await save('model-jwks.json', JSON.stringify(issuer.jwks));
  await save('model-stub-key', 'dev-stack-stub-only');
  const approvalRoute = { serverId: 'approval-journey', connectionId: 'installed',
    upstream: `127.0.0.1:${settings['MODEL_STUB_PORT']}`, generation: randomUUID(),
    revisionHeader: 'x-opencrane-mcp-revision' };
  const approvalRevision = catalogueDigest([approvalJourneyTool()]);
  if (!secondary) await modelFirewall(true);
  if (!secondary) {
    const stubEnvironment = { MODEL_STUB_PORT: settings['MODEL_STUB_PORT']!,
      MODEL_STUB_MCP_GENERATION: approvalRoute.generation,
      MODEL_STUB_MCP_REVISION: approvalRevision };
    await start('model-stub', ['--experimental-strip-types', 'infra/dev-stack/model-stub.ts'],
      stubEnvironment);
  }
  await run('flock', ['--close', `/tmp/opencrane-dev-stack-tools-${process.getuid!()}.lock`, 'bash', 'spikes/s0-1c-real-model-smoke/scripts/fetch-tools.sh']);
  const models = {
    ...binding, ...await readEnv('command'), DATABASE_URL: (await readEnv('projection'))['DATABASE_URL']!,
    DEFAULT_PAYING_GROUP_ID: process.env['DEFAULT_PAYING_GROUP_ID'] ?? 'installation-default',
    MODEL_STATE_DIR: `${directory}/models`, MODEL_JWKS_FILE: `${directory}/model-jwks.json`, TOKEN_ISSUER: `${settings['ORIGIN']}/`,
    CONVERSATION_KEYS_DIR: `${directory}/conversation-keys`,
    MODEL_GATEWAY_CONTROL_PORT: settings['MODEL_GATEWAY_CONTROL_PORT']!,
    MODEL_STUB_MCP_GENERATION: approvalRoute.generation,
    MODEL_STUB_MCP_REVISION: approvalRevision,
    MODEL_UPSTREAM: `127.0.0.1:${settings['MODEL_STUB_PORT']}`, MODEL_KEY_FILE: `${directory}/model-stub-key`,
    AGENTGATEWAY_BINARY: `${root}/spikes/s0-1c-real-model-smoke/.tools/agentgateway-linux-amd64`,
    MODEL_DECISION_PORT: settings['MODEL_DECISION_PORT']!, MODEL_GATEWAY_PORT: settings['MODEL_GATEWAY_PORT']!, MODEL_READINESS_PORT: settings['MODEL_READINESS_PORT']!, MODEL_STUB_PORT: settings['MODEL_STUB_PORT']!,
  };
  if (secondary) {
    const database = new URL(models.DATABASE_URL); database.hostname = 'postgres'; database.port = '5432';
    await writeEnv('models', { ...base, ...models, DATABASE_URL: database.href, NATS_URL: 'tls://127.0.0.1:4222',
      OPENFGA_API_URL: 'http://openfga:8080', MODEL_STUB_PAUSE_ON_STOP: '1', NODE_OPTIONS: '--max-old-space-size=256' });
    await compose('up', '-d', 'models');
  } else await start('models', ['--experimental-strip-types', 'apps/server/src/models-main.ts'], models);
  await wait(() => healthy(`http://127.0.0.1:${settings['MODEL_READINESS_PORT']}/healthz/ready`), 'model gateway');
  await start('dispatcher', ['--experimental-strip-types', 'apps/ops/src/worker.ts', 'dispatcher'],
    { ...await readEnv('dispatcher'), ...binding, MODEL_DECISION_URL: `http://127.0.0.1:${settings['MODEL_DECISION_PORT']}`, ...prefixed(await readEnv('command'), 'COMMAND_'),
      KUBECONFIG: computer.kubeconfig, KUBE_NAMESPACE: computer.namespace,
      TOKEN_SIGNING_KEY_FILE: `${directory}/token-signing-key.pem`, TOKEN_ISSUER: `${settings['ORIGIN']}/`,
      ...(secondary ? { COMPUTER_STORAGE: '1Gi' } : {}),
      COMPUTER_IDLE_MS: process.env['COMPUTER_IDLE_MS'] ?? '900000' });
  const tokenBootstrap = secondary && process.env['DEV_OWNER_BOOTSTRAP'] === '0';
  if (!tokenBootstrap) {
    const events = await connectEventStore(await readEnv('command'));
    let seedSequence: number;
    try {
      seedSequence = await events.store.head(`ownership-${settings['SILO_ID']!}`);
    } finally {
      await events.close();
    }
    if (seedSequence === 0) {
      const bootstrapArgs = [
        '--experimental-strip-types', 'infra/dev-stack/owner-bootstrap.ts',
      ];
      const bootstrapEnv = { ...base, DEV_STACK_DIR: directory };
      console.log((await run(process.execPath, bootstrapArgs, bootstrapEnv)).trim());
    }
  }
  await start('server', ['--experimental-strip-types', 'apps/server/src/main.ts'],
    { ...await readEnv('command'), ...await authEnv(), ...await readEnv('server'), ...binding,
      ...(tokenBootstrap ? { BOOTSTRAP_TOKEN_FILE: `${directory}/bootstrap-token.json` } : {}),
      MODEL_DECISION_URL: `http://127.0.0.1:${settings['MODEL_DECISION_PORT']}`,
      MINIO_URL: `http://127.0.0.1:${settings['MINIO_PORT']}`, MINIO_CREDENTIALS_FILE: `${directory}/minio-lease.json`, CLAMD_PORT: settings['CLAMD_PORT'] ?? '43310',
      ...(memoryKeyDirectory ? { MEMORY_KEY_DIRECTORY: memoryKeyDirectory } : {}),
      CONVERSATION_KEYS_DIR: `${directory}/conversation-keys`,
      PROVIDER_SECRETS_DIR: `${directory}/provider-secrets`,
      KUBECONFIG: computer.kubeconfig, KUBE_NAMESPACE: computer.namespace,
      TOKEN_SIGNING_KEY_FILE: `${directory}/token-signing-key.pem`, TOKEN_ISSUER: `${settings['ORIGIN']}/` });
  await wait(() => healthy(`http://127.0.0.1:${settings['SERVER_PORT']}/healthz`), 'server');
  await start('web', [`${root}/node_modules/@angular/cli/bin/ng.js`, 'serve', '--project', 'web', '--host', '127.0.0.1',
    '--port', settings['WEB_PORT']!, '--proxy-config', `${directory}/proxy.json`], { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(origin).hostname, ...(secondary ? { NG_BUILD_MAX_WORKERS: '2' } : {}) });
  await wait(() => healthy(`http://127.0.0.1:${settings['WEB_PORT']}/org/integrations`), 'web');
  if (!secondary) {
    const ownership = await serveOwnership(settings);
    if (ownership === 'foreign') throw new Error(`Refusing to replace HTTPS :443 Serve handler: expected ${origin} to map to 127.0.0.1:${settings['WEB_PORT']}`);
    if (ownership === 'absent') {
      await run('sudo', ['-n', 'tailscale', 'serve', '--bg', '--https=443', `http://127.0.0.1:${settings['WEB_PORT']}`]);
    }
  }
  await wait(() => healthy(`${origin}/org/integrations`), 'web origin');
  if (!tokenBootstrap) await journey();
  const after = await run('ss', ['-H', '-ltnp']);
  await save('listeners-after.txt', after);
  const pids = await Promise.all(names.map(processId));
  for (let i = 0; i < names.length; i++) if (!pids[i]) throw new Error(`${names[i]} stopped`);
  const ports = new Set(Object.entries(settings).filter(([name]) => name.endsWith('_PORT')).map(([, port]) => port));
  if (!secondary) ports.add('443');
  const allowed = new Set(['127.0.0.1', '::1', ...tail.Self.TailscaleIPs]);
  for (const line of after.trim().split('\n')) {
    const address = line.trim().split(/\s+/u)[3]!;
    const match = /^(?:\[(.*)\]|([^:]*)):(\d+)$/u.exec(address);
    const ownedProcess = pids.some((pid) => line.includes(`pid=${pid},`));
    if (ownedProcess && !match) throw new Error(`Cannot verify stack listener address: ${address}`);
    // The verified IPv4/IPv6 firewall restricts this wildcard listener to loopback, tailnet and k3d.
    if (!secondary && match?.[3] === settings['MODEL_GATEWAY_PORT']) continue;
    if ((ownedProcess || ports.has(match?.[3] ?? '')) && !allowed.has(match?.[1] ?? match?.[2] ?? '')) {
      throw new Error(`Stack listener is not on loopback or Tailscale: ${address}`);
    }
  }
  if (!secondary) await modelFirewall(true);
  console.log(secondary ? 'PASS listener check: all secondary host ports on loopback'
    : 'PASS listener check: loopback/Tailscale; model port firewalled to loopback, tailnet and private k3d');
  console.log(`Stack ready: ${origin}/org/integrations (Zitadel sign-in)`);
}
async function journey() {
  const output = await run(process.execPath, ['--experimental-strip-types', 'infra/dev-stack/journey.ts'],
    { ...base, DEV_STACK_DIR: directory,
      ...(process.env['P4_JOURNEY_ATTEMPT']
        ? { P4_JOURNEY_ATTEMPT: process.env['P4_JOURNEY_ATTEMPT'] } : {}) }, 1_200_000);
  console.log(output.trim());
}
async function status() {
  if (secondary && await slotIsFree()) {
    console.log('free');
    return;
  }
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
      `${settings['ORIGIN']}/org/integrations`,
      ...(secondary ? [`http://127.0.0.1:${settings['MODEL_READINESS_PORT']}/healthz/ready`] : [])]) {
      const up = await healthy(url);
      console.log(`${up ? 'healthy' : 'unavailable'}: ${url}`);
      if (!up) ok = false;
    }
  }
  if (!secondary) console.log(await run('tailscale', ['serve', 'status']));
  if (!ok) process.exitCode = 1;
}
let prepared = false;
try {
  const [action, flag, extra] = process.argv.slice(2);
  if (extra || (flag && !(action === 'up' && flag === '--fresh') &&
      !(action === 'package-up' && flag))) {
    throw new Error('Usage: up.sh [--fresh], down.sh, status.sh, journey.sh');
  }
  const directoryPresent = await stat(directory).then(() => true, () => false);
  if (secondary && directoryPresent && await realpath(directory) !== directory) {
    throw new Error('Secondary stack directory must not be a symlink');
  }
  if (action === 'claim') {
    if (!secondary) process.exit(1);
    const owner = await readStackOwner();
    if (directoryPresent && !owner) process.exit(1);
    const sameWorktree = owner?.worktree === root;
    let reclaimingStaleSlot = directoryPresent && !sameWorktree;
    if (directoryPresent && sameWorktree && !await slotIsFree()) {
      console.log(stackId);
      process.exit(0);
    }
    if (directoryPresent && !sameWorktree && !await slotIsFree()) process.exit(1);
    if (directoryPresent && sameWorktree) reclaimingStaleSlot = true;
    if (!directoryPresent && await stackProcessIsRunning()) process.exit(1);
    await checkPorts(defaultPorts);
    const ownerRecord = await stackOwnerRecord(
      Number(process.env['DEV_STACK_CLAIM_PID'] ?? process.pid),
    );
    await prepareDirectory(ownerRecord, reclaimingStaleSlot);
    await save('stack-owner', ownerRecord);
    if (reclaimingStaleSlot) console.error(`Reclaimed stale slot ${stackId}.`);
    console.log(stackId);
    process.exit(0);
  }
  if (action?.startsWith('package-')) {
    if (action === 'package-prepare') await preparePackage();
    else if (action === 'package-up' && flag) await installPackage(flag);
    else if (action === 'package-down') await removePackage();
    else if (action === 'package-check') await verifyPackageOwner();
    else throw new Error('Unknown package action');
    process.exit(0);
  }
  if (action === 'down' && secondary && directoryPresent) {
    const owner = await readStackOwner();
    if (owner?.worktree !== root) throw new Error('This worktree does not own the slot');
    await removePackage();
  }
  if (action === 'up') {
    if (secondary && await packagedSlotIsBusy()) {
      throw new Error('A Helm package already uses this secondary slot');
    }
    const ownerRecord = secondary
      ? await stackOwnerRecord(Number(process.env['DEV_STACK_CLAIM_PID'] ?? process.pid))
      : undefined;
    await prepareDirectory(ownerRecord);
    if (ownerRecord) await save('stack-owner', ownerRecord);
    prepared = true;
  } else {
    prepared = directoryPresent;
  }
  switch (action) {
    case 'up': await up(flag === '--fresh'); break;
    case 'down':
      if (!directoryPresent) {
        if (secondary) console.log('free');
        break;
      }
      await stop();
      if (secondary) {
        if (await exists(`${directory}/settings.env`)) await compose('down', '--volumes', '--remove-orphans');
        await removeComputers();
        await rm(directory, { recursive: true });
      }
      break;
    case 'status': await status(); break;
    case 'journey': await journey(); break;
    default: throw new Error('Unknown stack action');
  }
} catch (error) {
  // Error causes may contain database passwords; never print raw dependency errors.
  if (prepared) await save('failure.log', String(error));
  if (process.argv[2]?.startsWith('package-')) {
    console.error('Package command refused; check pins, named secrets and slot ownership');
  } else {
    console.error(prepared ? `Dev stack failed; inspect private logs in ${directory}` : 'DEV_STACK_DIR must be an empty dedicated directory outside the repository, or owned by this worktree');
  }
  process.exitCode = 1;
}
