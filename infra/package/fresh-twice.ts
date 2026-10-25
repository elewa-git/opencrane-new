import './fresh-twice-entry.ts';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { directory, readOwnerEmail, root } from '../dev-stack/config.ts';
import { secondary, stackId } from '../dev-stack/identity.ts';
import { requireOwner, verifyPackageOwner } from '../dev-stack/packaged.ts';

import { retainedBrowserFailure } from './browser-capture.ts';

const execute = promisify(execFile);
const namespace = `opencrane-package-${stackId}`;
const installLabel = 'opencrane.dev/install-id';

type DatedObject = { uid?: string; createdAt: string };
type FreshState = {
  installId: string; previousInstallId?: string | undefined; startedAt: string;
  previousPvcUids: readonly string[]; previousStoreId?: string | undefined;
  pvClaims: readonly string[];
  pvcs: readonly (DatedObject & { uid: string })[];
  events: readonly DatedObject[]; storeId: string; memberIds: readonly string[];
  siloEvents: readonly { type: string; time: string }[];
  rowCounts: Record<string, number>;
};
type OwnerState = {
  issuer: string; expectedIssuer: string; subject: string; expectedSubject: string;
  expectedEmail: string;
  identityRows: readonly { memberId: string; issuer: string; subject: string }[];
  providerEmailVerified: boolean; role: string; status: string;
  memberEmail: string; eventTypes: readonly string[];
  ownerEvents: readonly { email: string; role: string; subject: string }[];
  openFgaOwner: boolean;
  authenticated: boolean; authenticatedSubject: string;
};
type KubernetesList = { items: Array<{ metadata?: { uid?: string; creationTimestamp?: string;
  labels?: Record<string, string> }; spec?: { claimRef?: { namespace?: string } } }> };

function pvcUid(pvc: DatedObject) {
  return pvc.uid ?? '';
}

function objectTime(item: KubernetesList['items'][number]): DatedObject {
  return { createdAt: item.metadata?.creationTimestamp ?? '' };
}

function pvcTime(item: KubernetesList['items'][number]): DatedObject & { uid: string } {
  return { uid: item.metadata?.uid ?? '', createdAt: item.metadata?.creationTimestamp ?? '' };
}

function claimedByPackage(volume: KubernetesList['items'][number]) {
  return volume.spec?.claimRef?.namespace === namespace;
}

function signInWidth(signIn: { width: number }) {
  return signIn.width;
}

function requireNewer(time: string, startedAt: string, message: string) {
  const created = Date.parse(time);
  assert(Number.isFinite(created) && created >= Date.parse(startedAt), message);
}

export function checkInstallId(current: string | undefined, previous?: string) {
  assert(current, 'Helm install ID is missing');
  assert(current !== previous, 'Helm install ID was reused');
}

export function checkFresh(state: FreshState) {
  checkInstallId(state.installId, state.previousInstallId);
  assert.equal(state.pvClaims.length, 0, 'A PV remains claimed for this namespace');
  assert(state.pvcs.length > 0, 'The package has no PVCs');
  for (const pvc of state.pvcs) {
    assert(pvc.uid, 'A PVC has no UID');
    assert(!state.previousPvcUids.includes(pvc.uid), 'A PVC UID was reused');
    requireNewer(pvc.createdAt, state.startedAt, 'A PVC predates this run');
  }
  for (const event of state.events) {
    requireNewer(event.createdAt, state.startedAt, 'A Kubernetes event predates this run');
  }
  for (const event of state.siloEvents) {
    requireNewer(event.time, state.startedAt, 'A silo event predates this run');
    assert(!/^(conversation|file|memory)\./u.test(event.type),
      'A conversation, file or memory event exists before chat');
  }
  assert(state.storeId, 'OpenFGA store ID is missing');
  assert(state.storeId !== state.previousStoreId, 'OpenFGA store ID was reused');
  assert.deepEqual(state.memberIds, ['jente-rosseel'], 'Unexpected member rows');
  for (const table of ['conversations', 'conversation_files', 'memory_facts',
    'memory_changes', 'memory_dependencies', 'memory_maintenance_runs',
    'memory_maintenance_bindings']) {
    const count = state.rowCounts[table];
    assert.equal(count, 0, `${table} contains old silo data`);
  }
}

function checkOwnerBinding(state: OwnerState) {
  assert.equal(state.issuer, state.expectedIssuer, 'Untrusted owner issuer');
  assert.equal(state.subject, state.expectedSubject, 'Wrong owner subject');
  assert.deepEqual(state.identityRows, [{ memberId: 'jente-rosseel',
    issuer: state.issuer, subject: state.subject }], 'Owner identity row differs');
  assert(state.providerEmailVerified, 'Provider email is unverified');
  assert.equal(state.role, 'owner', 'Member is not an owner');
  assert.equal(state.status, 'joined', 'Owner has not joined');
  assert(state.expectedEmail, 'Expected owner email is missing');
  assert.equal(state.memberEmail, state.expectedEmail, 'Owner member email differs');
  assert.deepEqual(state.eventTypes, ['member.invited', 'member.joined'],
    'Owner invitation and join events differ');
  assert.deepEqual(state.ownerEvents, [
    { email: state.expectedEmail, role: 'owner', subject: state.subject },
    { email: state.expectedEmail, role: 'owner', subject: state.subject },
  ], 'Owner invitation or join differs');
  assert(state.openFgaOwner, 'OpenFGA owner check failed');
}

export function checkOwner(state: OwnerState) {
  checkOwnerBinding(state);
  assert(state.authenticated, 'Browser sign-in was not authenticated');
  assert.equal(state.authenticatedSubject, state.subject, 'Browser signed in as another user');
}

async function command(program: string, args: string[], timeout = 180_000,
    extraEnvironment: Record<string, string> = {}) {
  const env = { ...process.env, ...extraEnvironment };
  const result = await execute(program, args, { cwd: root, timeout, env });
  return result.stdout.trim();
}

export async function captureBrowser(index: number) {
  try {
    return await command('node', ['--experimental-strip-types', 'infra/package/capture.mjs',
      `fresh-${index}-`], 360_000);
  } catch (error) {
    const failure = error as { stderr?: string };
    const reason = retainedBrowserFailure(failure.stderr ?? '');
    console.error(reason);
    throw new Error(reason);
  }
}

async function kubectl(args: string[]) {
  return command('kubectl', ['--context=k3d-ocn', ...args]);
}

async function list(args: string[]): Promise<KubernetesList> {
  const output = await kubectl([...args, '-o', 'json']);
  return JSON.parse(output) as KubernetesList;
}

async function claimedPvs() {
  const volumes = await list(['get', 'pv']);
  return volumes.items.filter(claimedByPackage);
}

// Check the claim and old storage before the first namespace or Helm write.
export async function checkStart() {
  await requireOwner();
  const ownerFile = `${directory}/package-owner.json`;
  try {
    await readFile(ownerFile, 'utf8');
    throw new Error('A package owner record still exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const existing = await kubectl(['get', 'namespace', namespace, '--ignore-not-found', '-o', 'json']);
  assert.equal(existing, '', 'The package namespace still exists');
  assert.equal((await claimedPvs()).length, 0, 'A PV remains claimed for this namespace');
}

const inspectScript = `
import { Pool } from 'pg';
import { connectEventStore } from '@opencrane/event-store';
import { memberAuthorisation } from '@opencrane/authz';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const events = await connectEventStore();
try {
  const query = await pool.query(\`SELECT
    (SELECT json_agg(member_id ORDER BY member_id) FROM members WHERE silo='dev') AS members,
    (SELECT json_agg(json_build_object('memberId', member_id, 'issuer', issuer,
      'subject', sub)) FROM member_identities WHERE silo='dev') AS identities,
    (SELECT role FROM members WHERE silo='dev' AND member_id='jente-rosseel') AS role,
    (SELECT email FROM members WHERE silo='dev' AND member_id='jente-rosseel') AS email,
    (SELECT status FROM members WHERE silo='dev' AND member_id='jente-rosseel') AS status\`);
  const rowCounts = {};
  for (const table of ['conversations', 'conversation_files', 'memory_facts',
    'memory_changes', 'memory_dependencies', 'memory_maintenance_runs',
    'memory_maintenance_bindings']) {
    const exists = await pool.query('SELECT to_regclass($1) AS name', [table]);
    rowCounts[table] = exists.rows[0].name
      ? Number((await pool.query('SELECT count(*)::int AS count FROM ' + table)).rows[0].count)
      : 0;
  }
  const history = [];
  const ownerEvents = [];
  for await (const stored of events.store.readStream('member-jente-rosseel')) {
    history.push(stored.event.type);
    const data = stored.event.data;
    const subject = stored.event.type === 'member.invited'
      ? data.invitedIdentity?.sub : stored.event.principal?.id;
    ownerEvents.push({ email: data.email, role: data.role, subject });
  }
  const siloEvents = [];
  const eventCount = await events.store.head();
  for (let position = 1; position <= eventCount; position++) {
    const stored = await events.store.readEvent(position);
    siloEvents.push({ type: stored.event.type, time: stored.event.time });
  }
  const authz = memberAuthorisation({ silo: 'dev', apiUrl: process.env.OPENFGA_API_URL,
    storeId: process.env.OPENFGA_STORE_ID,
    authorizationModelId: process.env.OPENFGA_MODEL_ID });
  const owner = await authz.check('jente-rosseel', 'owner');
  console.log(JSON.stringify({ ...query.rows[0], ...rowCounts,
    storeId: process.env.OPENFGA_STORE_ID,
    eventTypes: history, ownerEvents, siloEvents, openFgaOwner: owner.allowed }));
} finally { await pool.end(); await events.close(); }
`;

async function inspectData() {
  const output = await kubectl(['-n', namespace, 'exec', 'deployment/server', '-c', 'server',
    '--', 'node', '--input-type=module', '-e', inspectScript]);
  return JSON.parse(output) as {
    members: string[]; identities: OwnerState['identityRows']; role: string; status: string;
    email: string; ownerEvents: OwnerState['ownerEvents'];
    conversations: number; conversation_files: number; memory_facts: number;
    memory_changes: number; memory_dependencies: number; memory_maintenance_runs: number;
    memory_maintenance_bindings: number;
    storeId: string; eventTypes: string[]; siloEvents: FreshState['siloEvents'];
    openFgaOwner: boolean;
  };
}

async function providerVerified(issuer: string, orgId: string, subject: string) {
  const keyFile = process.env['ZITADEL_KEY_FILE'];
  assert(keyFile, 'ZITADEL_KEY_FILE is required');
  const token = (await readFile(keyFile, 'utf8')).trim();
  const response = await fetch(`${issuer}/management/v1/users/${subject}`, {
    headers: { authorization: `Bearer ${token}`, 'x-zitadel-orgid': orgId },
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `Provider owner lookup returned ${response.status}`);
  const body = await response.json() as { user?: { id?: string; human?: {
    email?: { isEmailVerified?: boolean } } } };
  assert.equal(body.user?.id, subject, 'Provider returned another user');
  return body.user.human?.email?.isEmailVerified === true;
}

async function snapshot(startedAt: string, previous?: FreshState): Promise<FreshState> {
  const owner = await verifyPackageOwner();
  console.log('Checking release label');
  const release = await kubectl(['-n', namespace, 'get', 'secret',
    `sh.helm.release.v1.${namespace}.v1`, '-o', 'json']);
  const releaseData = JSON.parse(release) as { metadata: { labels?: Record<string, string> } };
  const installId = releaseData.metadata.labels?.[installLabel];
  assert.equal(installId, owner.installId, 'Release label differs from the claim');
  console.log('Checking PVCs and Kubernetes events');
  const pvcs = await list(['-n', namespace, 'get', 'pvc']);
  const events = await list(['-n', namespace, 'get', 'events']);
  console.log('Checking silo data and OpenFGA');
  const data = await inspectData();
  const state: FreshState = {
    installId: installId ?? '', previousInstallId: previous?.installId, startedAt,
    previousPvcUids: previous?.pvcs.map(pvcUid) ?? [],
    previousStoreId: previous?.storeId,
    pvClaims: [],
    pvcs: pvcs.items.map(pvcTime),
    events: events.items.map(objectTime),
    storeId: data.storeId, memberIds: data.members ?? [], siloEvents: data.siloEvents,
    rowCounts: { conversations: data.conversations,
      conversation_files: data.conversation_files, memory_facts: data.memory_facts,
      memory_changes: data.memory_changes, memory_dependencies: data.memory_dependencies,
      memory_maintenance_runs: data.memory_maintenance_runs,
      memory_maintenance_bindings: data.memory_maintenance_bindings },
  };
  return state;
}

async function waitForForward(child: ChildProcess, port: number) {
  for (let attempt = 0; attempt < 60; attempt++) {
    assert(child.exitCode === null, 'Package forward stopped');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch { /* Wait until Kubernetes starts forwarding. */ }
    await delay(1000);
  }
  throw new Error('Package forward timed out');
}

export async function runOnce(index: number, values: string, previous?: FreshState) {
  let stage = 'start ownership';
  await checkStart();
  const startedAt = new Date().toISOString();
  let prepared = false;
  let forward: ChildProcess | undefined;
  try {
    stage = 'package preparation';
    await command('infra/dev-stack/run.sh', ['package-prepare', '--id', stackId]);
    prepared = true;
    await verifyPackageOwner();
    stage = 'private settings';
    await command('node', ['--experimental-strip-types', 'infra/package/prepare.ts', values],
      300_000, { PACKAGE_SKIP_PROVIDER_SETUP: '1' });
    await verifyPackageOwner();
    stage = 'Helm install';
    await command('infra/dev-stack/run.sh', ['package-up', '--id', stackId,
      '--values', values], 900_000);
    stage = 'fresh state';
    const state = await snapshot(startedAt, previous);
    checkFresh(state);
    stage = 'provider and owner';
    const settings = JSON.parse(await readFile(`${directory}/zitadel.json`, 'utf8')) as {
      issuer: string; orgId: string; users: { owner: { id: string } };
    };
    const data = await inspectData();
    const verified = await providerVerified(settings.issuer, settings.orgId,
      settings.users.owner.id);
    const pinned = JSON.parse(await readFile(`${root}/infra/dev-stack/zitadel.json`,
      'utf8')) as { issuer: string };
    const ownerEmail = await readOwnerEmail();
    const owner: OwnerState = {
      expectedEmail: ownerEmail,
      issuer: settings.issuer, expectedIssuer: pinned.issuer,
      subject: settings.users.owner.id, expectedSubject: settings.users.owner.id,
      identityRows: data.identities ?? [], providerEmailVerified: verified,
      role: data.role, status: data.status, memberEmail: data.email,
      eventTypes: data.eventTypes, ownerEvents: data.ownerEvents,
      openFgaOwner: data.openFgaOwner, authenticated: false,
      authenticatedSubject: '',
    };
    checkOwnerBinding(owner);
    stage = 'browser forward';
    forward = spawn('infra/package/forward.sh', [], {
      cwd: root, env: process.env, stdio: 'ignore' });
    await waitForForward(forward, 25000 + Number(stackId) * 100 + 6);
    stage = 'browser capture';
    const capture = await captureBrowser(index);
    const signIns = JSON.parse(capture.split('\n').at(-1) ?? 'null') as Array<{
      width: number; authenticated: boolean; subject: string;
    }>;
    assert.deepEqual(signIns.map(signInWidth), [1280, 390]);
    for (const signIn of signIns) {
      checkOwner({ ...owner, authenticated: signIn.authenticated,
        authenticatedSubject: signIn.subject });
    }
    console.log(`PASS fresh ${index}: install ${state.installId}, ` +
      `PVCs ${state.pvcs.map(pvcUid).join(', ')}, store ${state.storeId}`);
    return state;
  } catch (error) {
    if (error instanceof assert.AssertionError) console.error(error.message);
    console.error(`FAIL fresh ${index} during ${stage}`);
    throw new Error(`Fresh run ${index} failed during ${stage}`, { cause: error });
  } finally {
    forward?.kill();
    if (prepared) await command('infra/dev-stack/run.sh', ['package-down', '--id', stackId],
      300_000);
  }
}

async function main() {
  assert(secondary, 'Claim one secondary slot first');
  assert(process.argv.length === 3, 'Pass the private values file path');
  const values = process.argv[2]!;
  const first = await runOnce(1, values);
  await runOnce(2, values, first);
}

if (process.argv[1]?.endsWith('/fresh-twice.ts')) {
  const operation = process.argv[2];
  let task: Promise<unknown>;
  if (operation === '--check-start') task = checkStart();
  else if (operation === '--check-owner') task = verifyPackageOwner();
  else task = main();
  await task.catch(() => {
    console.error('FAIL two fresh packages; inspect the claimed slot before retrying');
    process.exitCode = 1;
  });
}
