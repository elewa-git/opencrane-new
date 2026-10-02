import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { tokenIssuer } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { connectEventStore } from '@opencrane/event-store';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { connectProjectionDb } from '@opencrane/projections';
import { integrationsResponseSchema, realtimeMessageSchema, type RealtimeMessage } from '@opencrane/protocol';
import { browserSessions } from './browser-signin.ts';
import { base, directory, readEnv, root, authEnv } from './config.ts';
import { SandboxClient } from '../../apps/ops/src/kubernetes.ts';
import { resumeComputer, suspendComputer, type ComputerState } from '../../apps/ops/src/lifecycle.ts';

const settings = await readEnv('settings');
const binding = await readEnv('binding');
const config = loadAuthConfig(await authEnv());
const silo = settings['SILO_ID']!;
const origin = settings['ORIGIN']!;
const server = `http://127.0.0.1:${settings['WEB_PORT']}`;
const events = await connectEventStore(await readEnv('command'));
const db = connectProjectionDb((await readEnv('server'))['DATABASE_URL']!, (error) => { throw error; });
const authz = memberAuthorisation({ silo, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!,
  authorizationModelId: binding['OPENFGA_MODEL_ID']! });
const id = randomUUID();
let ws: WebSocket | undefined;
let browser: Awaited<ReturnType<typeof browserSessions>> | undefined;
const identities = new Map<string, { sub: string; cookie: string }>();
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 30_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
async function append(type: string, subject: string, data: Record<string, unknown>) {
  const example = getEventDefinition(type)?.example;
  assert(example && typeof example === 'object');
  const eventId = randomUUID();
  const parsed = parseEventByType({ id: eventId, commandId: eventId, type, subject, silo, source: 'dev-stack-journey',
    time: new Date().toISOString(), principal: { kind: 'human', id: 'dev-only-bootstrap' }, data: { ...example, ...data } });
  assert(parsed.success);
  let expectedSequence = 0;
  for await (const stored of events.store.readStream(subject)) expectedSequence = stored.sequence;
  const result = await events.store.append({ event: parsed.event, expectedSequence });
  assert.equal(result.status, 'appended');
}
function headers(memberId: string) {
  const identity = identities.get(memberId);
  if (identity) return { origin, cookie: identity.cookie };
  assert(process.env['DEV_STACK_OFFLINE_FALLBACK'] === '1', 'No real sign-in session');
  const now = Math.floor(Date.now() / 1000);
  return { origin, cookie: `${config.cookieName}=${encodeSession(config, {
    sub: `dev-${memberId}`, orgId: config.expectedOrgId!, roles: [], authTime: now, exp: now + 300,
  })}` };
}
async function invite(memberId: string, role: 'owner' | 'member') {
  // Dev-only bootstrap: the first-member policy is still separate from identity-provider login.
  await append('member.invited', `member-${memberId}`, { memberId, role, invitationId: `invite-${memberId}-${id}`,
    email: `${memberId}@example.test`, invitedBy: 'dev-only-bootstrap',
    invitedIdentity: { issuer: config.issuerUrl, sub: identities.get(memberId)?.sub ?? `dev-${memberId}` },
    expiresAt: new Date(Date.now() + 3600_000).toISOString() });
}
async function join(memberId: string) {
  const response = await fetch(`${server}/members/join`, { method: 'POST',
    headers: { ...headers(memberId), 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, invitationId: `invite-${memberId}-${id}`, commandId: `join-${memberId}-${id}`, displayName: memberId }),
    signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const body: unknown = await response.json();
  assert(body && typeof body === 'object' && 'status' in body && body.status === 'joined');
}
async function computerEvents(assistantId: string) {
  const result = [];
  for await (const stored of events.store.readStream(`computer-${assistantId}`)) result.push(stored.event);
  return result;
}
try {
  assert.equal((await fetch(`${server}/api/org/integrations`)).status, 401);
  if (process.env['DEV_STACK_OFFLINE_FALLBACK'] === '1') {
    let unreachable = false;
    try { unreachable = !(await fetch(`${config.issuerUrl}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) })).ok; }
    catch { unreachable = true; }
    assert(unreachable, 'Offline fallback is only allowed when Zitadel is unreachable');
    console.error('FAIL sign-in: explicit offline fallback uses minted dev-only cookies');
    process.exitCode = 1;
  } else browser = await browserSessions(config, origin);
  const admin = browser ? 'zitadel-owner' : `offline-admin-${id}`;
  const member = browser ? 'zitadel-member' : `offline-member-${id}`;
  if (browser) {
    identities.set(admin, browser.sessions.get('owner')!);
    identities.set(member, browser.sessions.get('member')!);
  }
  await invite(admin, 'owner');
  await join(admin);
  await until(async () => (await authz.check(admin, 'admin')).allowed, 'admin OpenFGA');
  await until(async () => (await db.db.query('SELECT 1 FROM members WHERE member_id=$1 AND status=$2', [admin, 'joined'])).rows.length === 1, 'admin projection');
  ws = new WebSocket(`${server.replace('http:', 'ws:')}/ws`, { headers: headers(admin) });
  const messages: RealtimeMessage[] = [];
  ws.on('message', (raw: Buffer) => messages.push(realtimeMessageSchema.parse(JSON.parse(raw.toString()))));
  await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
  ws.send(JSON.stringify({ type: 'subscribe', topic: 'members', since: 0 }));
  await until(() => messages.some((message) => message.type === 'ready'), 'WebSocket initial catch-up');
  messages.length = 0;
  await invite(member, 'member');
  const joinedAt = performance.now();
  await join(member);
  await until(() => messages.some((message) => message.type === 'member' && message.member.memberId === member
    && message.member.status === 'joined'), 'live WebSocket join');
  await until(async () => (await authz.check(member, 'member')).allowed, 'member OpenFGA');
  assert.equal((await db.db.query('SELECT 1 FROM members WHERE member_id=$1 AND status=$2', [member, 'joined'])).rows.length, 1);
  console.log('PASS member.joined HTTP command → PostgreSQL → OpenFGA + live WebSocket');
  let computer: { assistant_id: string; computer_id: string; generation: number } | undefined;
  await until(async () => {
    const result = await db.db.query<{ assistant_id: string; computer_id: string; generation: number }>(
      "SELECT assistant_id, computer_id, generation FROM computers WHERE owner_id=$1 AND status='ready'", [member]);
    computer = result.rows[0];
    return Boolean(computer);
  }, 'joined member computer Ready');
  const joinReadyMs = Math.round(performance.now() - joinedAt);
  const namespace = `opencrane-${silo}`;
  const runKube = (...args: string[]) => promisify(execFile)('kubectl', ['-n', namespace, ...args], { cwd: root, timeout: 180_000 });
  await runKube('exec', computer!.computer_id, '--', 'node', '-e',
    "require('fs').writeFileSync('/home/agent/workspace/dev-stack-preserved','yes')");
  const kube = new SandboxClient(`${directory}/computer-kubeconfig.json`, namespace);
  const history = await computerEvents(computer!.assistant_id);
  const latest = history.at(-1);
  if (!latest) throw new Error('Computer history missing');
  const readyEvent = history.findLast((event) => event.type === 'computer.ready');
  const state: ComputerState = { assistantId: computer!.assistant_id, computerId: computer!.computer_id,
    latest, ...(readyEvent ? { ready: readyEvent } : {}) };
  await suspendComputer(events.store, state);
  await until(async () => (await kube.state(computer!.computer_id))?.suspended === true, 'computer suspended');
  const issuer = await tokenIssuer({ privateKeyPath: `${directory}/token-signing-key.pem`, issuer: `${origin}/` });
  const resumedAt = performance.now();
  await resumeComputer(events.store, issuer, silo, computer!.assistant_id);
  await until(async () => (await db.db.query("SELECT 1 FROM computers WHERE assistant_id=$1 AND status='ready'",
    [computer!.assistant_id])).rows.length === 1, 'resumed computer Ready');
  const resumeMs = Math.round(performance.now() - resumedAt);
  assert.equal((await runKube('exec', computer!.computer_id, '--', 'cat', '/home/agent/workspace/dev-stack-preserved')).stdout.trim(), 'yes');
  const previousGeneration = computer!.generation;
  await runKube('delete', 'pod', computer!.computer_id, '--wait=false');
  await until(async () => {
    const result = await db.db.query<{ generation: number }>(
      "SELECT generation FROM computers WHERE assistant_id=$1 AND status='ready'", [computer!.assistant_id]);
    return Number(result.rows[0]?.generation) > previousGeneration;
  }, 'lost computer re-claimed');
  assert.equal((await runKube('exec', computer!.computer_id, '--', 'cat', '/home/agent/workspace/dev-stack-preserved')).stdout.trim(), 'yes');
  console.log(`PASS assistant/computer lifecycle: join→Ready ${joinReadyMs} ms; resume ${resumeMs} ms; Pod replacement kept disk`);
  const serverId = `journey-${id}`;
  await append('mcp.server_registered', `mcp-${serverId}`, { serverId, kind: 'remote', locator: 'https://mcp.example.test/mcp', catalogueRef: 'catalogue:dev' });
  await append('mcp.server_discovered', `mcp-${serverId}`, { serverId, toolCount: 2, schemaDigest: 'a'.repeat(64), serverInfo: { name: 'Journey MCP', version: '1.0.0' } });
  await append('mcp.tool_mode_set', `mcp-${serverId}`, { serverId, toolName: 'read', mode: 'allow', setBy: admin });
  await append('mcp.server_published', `mcp-${serverId}`, { serverId, publishedBy: admin });
  await until(async () => {
    const response = await fetch(`${server}/api/org/integrations`, { headers: headers(admin), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const result = integrationsResponseSchema.parse(await response.json());
    const row = result.rows.find((row) => row.serverId === serverId);
    return row?.name === 'Journey MCP' && row.version === '1.0.0' && row.toolsTotal === 2 && row.toolsAllowed === 1 && row.status.kind === 'ready';
  }, 'typed integration rows');
  assert.equal((await fetch(`${server}/api/org/integrations`, { headers: headers(member) })).status, 403);
  console.log('PASS admin GET /api/org/integrations typed event-derived rows; anonymous/member refused');
  for (const projection of ['members', 'mcp-catalogue']) {
    const result = await promisify(execFile)('npm', ['run', 'replay', '--', projection, '--verify'], {
      cwd: root, env: { ...base, ...await readEnv('projection') }, timeout: 60_000 });
    await writeFile(`${directory}/replay-${projection}.log`, result.stdout, { mode: 0o600 });
    console.log(`PASS npm run replay -- ${projection} --verify`);
  }
  const page = await fetch(`${origin}/org/integrations`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(page.status, 200);
  assert((await page.text()).includes('<app-root'));
  console.log('PASS tailnet HTTPS web page');
} finally {
  ws?.terminate();
  await events.close();
  await db.close();
  await browser?.close();
}
