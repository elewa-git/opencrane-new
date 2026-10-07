import { uploadJourney } from './upload-journey.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { Request as BrowserRequest } from 'playwright';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { connectEventStore } from '@opencrane/event-store';
import { getEventDefinition, parseEventByType } from '@opencrane/events';
import { connectProjectionDb, readEvents } from '@opencrane/projections';
import { history as modelHistory, models } from '@opencrane/models';
import { integrationsResponseSchema, realtimeMessageSchema, type RealtimeMessage } from '@opencrane/protocol';
import { approvalJourney } from './approval-journey.ts';
import { browserChatJourney } from './browser-chat.ts';
import { browserBudgetJourney, restoreBudgetCeilings } from './browser-budgets.ts';
import { auditPrompt, browserAuditJourney } from './browser-audit.ts';
import { browserLiveViewJourney } from './browser-live-view.ts';
import { browserPhase4, type Phase4Assertion } from './browser-phase4.ts';
import { chatJourney } from './chat-journey.ts';
import { browserSessions } from './browser-signin.ts';
import { namespace, secondary } from './identity.ts';
import { base, directory, readEnv, root, authEnv } from './config.ts';
import { SandboxClient } from '../../apps/ops/src/kubernetes.ts';
import { suspendComputer, type ComputerState } from '../../apps/ops/src/lifecycle.ts';

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
let chat: Awaited<ReturnType<typeof chatJourney>> | undefined;
let browser: Awaited<ReturnType<typeof browserSessions>> | undefined;
const identities = new Map<string, { sub: string; cookie: string }>();
const phase4Assertions: Phase4Assertion[] = [];
const phase4Attempt = process.env['P4_JOURNEY_ATTEMPT'] ?? 'manual';

async function writePhase4Receipt() {
  const receiptPath = `${root}/docs/process/p4-journey/run-${phase4Attempt}.json`;
  await writeFile(receiptPath, JSON.stringify({
    commit: (await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim(),
    attempt: phase4Attempt,
    viewportWidths: [1280, 390],
    assertions: phase4Assertions,
  }, null, 2) + '\n', { mode: 0o644 });
}

async function runPhase4Journey() {
  assert(browser, 'The Phase 4 journey needs real signed-in browser sessions');
  try {
    await browserPhase4({ ownerPage: browser.ownerPage, memberPages: browser.memberPages,
      origin, directory, attempt: phase4Attempt, silo, modelStubPort: settings['MODEL_STUB_PORT']!,
      ownershipMerged: process.env['P4_OWNERSHIP_MERGED'] === 'true',
      store: events.store, append, assertions: phase4Assertions });
  } catch (error) {
    phase4Assertions.push({ id: 'journey.execution', status: 'FAIL',
      statement: 'The browser checks did not all finish.',
      evidence: { reason: errorMessage(error) }, screenshots: [] });
    throw error;
  } finally {
    await writePhase4Receipt();
  }
  console.log(`PASS Phase 4 browser journey; receipt run-${phase4Attempt}.json`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'The browser journey returned an unknown error.';
}
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 120_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await delay(50);
  }
}
async function append(type: string, subject: string, data: Record<string, unknown>, source = 'dev-stack-journey') {
  const example = getEventDefinition(type)?.example;
  assert(example && typeof example === 'object');
  const eventId = randomUUID();
  const parsed = parseEventByType({ id: eventId, commandId: eventId, type, subject, silo, source,
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
async function invite(memberId: string, role: 'admin' | 'member') {
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
async function activeMember(memberId: string) {
  const result = await db.db.query(
    'SELECT 1 FROM members WHERE silo=$1 AND member_id=$2 AND status=$3',
    [silo, memberId, 'joined']);
  return result.rows.length === 1;
}
async function ensureMember(memberId: string, role: 'admin' | 'member') {
  if (await activeMember(memberId)) {
    return;
  }
  await invite(memberId, role);
  await join(memberId);
}
async function computerEvents(assistantId: string) {
  const result = [];
  for await (const stored of events.store.readStream(`computer-${assistantId}`)) result.push(stored.event);
  return result;
}
async function modelGrantsRecorded() {
  const grantees = new Map<string, string>();
  const grants = new Set<string>();
  const head = await events.store.head();
  if (head) for await (const { event } of readEvents(events.store, 1, head)) {
    assert.equal(event.silo, silo);
    const data = event.data as Record<string, unknown>;
    if (event.type === 'member.joined' || event.type === 'assistant.created') {
      const grantee = data[event.type === 'member.joined' ? 'memberId' : 'assistantId'];
      assert(typeof grantee === 'string');
      grantees.set(event.subject, grantee);
    }
    if (event.type === 'member.removed') grantees.delete(event.subject);
    // An explicit revocation also counts: migration must preserve that decision.
    if (data['resourceType'] === 'model' && ['grant.given', 'grant.revoked'].includes(event.type)) {
      grants.add(JSON.stringify([data['resourceId'], data['granteeId']]));
    }
  }
  for (const grantee of grantees.values()) for (const model of models.filter(model => !model.retired)) {
    if (!grants.has(JSON.stringify([model.id, grantee]))) return false;
  }
  return true;
}
try {
  await until(modelGrantsRecorded, 'model grant history for existing members/assistants');
  console.log('PASS existing members/assistants have model grant history, including explicit revocations');
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
  await ensureMember(admin, 'admin');
  await until(async () => (await authz.check(admin, 'admin')).allowed, 'admin OpenFGA');
  await until(async () => (await db.db.query('SELECT 1 FROM members WHERE member_id=$1 AND status=$2', [admin, 'joined'])).rows.length === 1, 'admin projection');
  ws = new WebSocket(`${server.replace('http:', 'ws:')}/ws`, { headers: headers(admin) });
  const messages: RealtimeMessage[] = [];
  ws.on('message', (raw: Buffer) => messages.push(realtimeMessageSchema.parse(JSON.parse(raw.toString()))));
  await once(ws, 'open', { signal: AbortSignal.timeout(5000) });
  ws.send(JSON.stringify({ type: 'subscribe', topic: 'members', since: 0 }));
  await until(() => messages.some((message) => message.type === 'ready'), 'WebSocket initial catch-up');
  messages.length = 0;
  const joinedAt = performance.now();
  if (await activeMember(member)) {
    console.log('PASS repeat journey preserves the active member without another invitation');
  } else {
    await ensureMember(member, 'member');
    await until(() => messages.some((message) => message.type === 'member' &&
      message.member.memberId === member && message.member.status === 'joined'),
    'live WebSocket join');
  }
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
  const kubeconfig = JSON.parse(await readFile(`${directory}/computer-kubeconfig.json`, 'utf8')) as { contexts: Array<{ context: { namespace: string } }> };
  assert.equal(namespace, kubeconfig.contexts[0]?.context.namespace, 'Journey uses the provisioned stack namespace');
  await until(async () => (await Promise.all(models.filter(model => !model.retired).flatMap(model => [
    authz.use('person', member, 'model', model.id), authz.use('assistant', computer!.assistant_id, 'model', model.id),
  ]))).every(result => result.allowed), 'new member and assistant model grants');
  console.log('PASS new member and assistant model grants reach OpenFGA before chat');
  const memberChatUrls: string[] = [];
  if (browser) for (const page of browser.memberPages) {
    const failedTransport: string[] = [];
    const failed = (request: BrowserRequest) => {
      const code = request.failure()?.errorText ?? '';
      if (/^net::[A-Z_]+$/.test(code)) failedTransport.push(code);
    };
    page.on('requestfailed', failed);
    try {
      const auditConversationUrl = await browserChatJourney(
        page,
        origin,
        secondary ? auditPrompt : undefined,
      );
      memberChatUrls.push(auditConversationUrl);
      await browserLiveViewJourney(page, origin, computer!, { member, admin, silo, store: events.store, append, until,
        desktopAllowed: async () => (await authz.desktop(member, computer!.computer_id)).allowed });
      await page.goto(origin);
    }
    catch (error) {
      await page.screenshot({ path: `${directory}/chat-failure.png` });
      console.error(`Browser transport failures: ${failedTransport.join(', ') || 'none'}`);
      throw error;
    } finally { page.off('requestfailed', failed); }
  }
  if (browser) await approvalJourney(browser.memberPages, events.store, authz, append, { silo, origin, requesterId: member,
    assistantId: computer!.assistant_id, computerId: computer!.computer_id, generation: Number(computer!.generation) });
  chat = await chatJourney(server, headers(member), computer!.assistant_id);
  const replyMs = await chat.message();
  await chat.reconnect();
  console.log(`PASS joined member HTTP message → streamed Codex/stub reply → projection; ${replyMs.completeMs} ms (first token ${replyMs.firstTokenMs} ms); browser reconnect no duplicates`);
  const uploaded = await uploadJourney(server, headers(member), chat.conversationId);
  console.log('PASS PDF upload → ClamAV before storage → bridge/MarkItDown → Codex/stub reads Willow-47; EICAR refused');
  const runKube = (...args: string[]) => promisify(execFile)('kubectl', ['--context=k3d-ocn', '-n', namespace, ...args], { cwd: root, timeout: 180_000 });
  await runKube('exec', computer!.computer_id, '--', 'node', '-e',
    "require('fs').writeFileSync('/home/agent/workspace/dev-stack-preserved','yes')");
  const kube = new SandboxClient(`${directory}/computer-kubeconfig.json`, namespace);
  await until(async () => {
    const rows = await computerEvents(computer!.assistant_id);
    const turnId = (event: typeof rows[number]) => (event.data as Record<string, unknown>)['turnId'];
    const closed = new Set(rows.filter(event => event.type === 'computer.turn_closed').map(turnId));
    return rows.filter(event => event.type === 'computer.turn_started').every(event => closed.has(turnId(event)));
  }, 'completed chat lifecycle closed');
  const history = await computerEvents(computer!.assistant_id);
  const latest = history.findLast(event => !event.type.startsWith('computer.turn_'));
  if (!latest) throw new Error('Computer history missing');
  const readyEvent = history.findLast((event) => event.type === 'computer.ready');
  const state: ComputerState = { assistantId: computer!.assistant_id, computerId: computer!.computer_id,
    latest, ...(readyEvent ? { ready: readyEvent } : {}) };
  assert.equal((await suspendComputer(events.store, state)).type, 'computer.suspended', 'Completed chat leaves the computer suspendable');
  await until(async () => (await kube.state(computer!.computer_id))?.suspended === true, 'computer suspended');
  const resumedAt = performance.now();
  const wakeReplyMs = await chat.message();
  assert(chat.starting(), 'Starting your computer state');
  console.log(`PASS suspended computer wakes on HTTP message and completes Codex reply; ${wakeReplyMs.completeMs} ms; wake-to-first-token ${wakeReplyMs.firstTokenMs} ms`);
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
  assert((await runKube('exec', computer!.computer_id, '--', 'cat', uploaded.textPath)).stdout.includes('Willow-47'));
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
  if (secondary && browser) {
    for (const [index, page] of browser.memberPages.entries()) await page.goto(memberChatUrls[index]!);
    // Dev-only signed session; this second member tests resource authority, not identity-provider login.
    const other = 'audit-other-member', sub = 'dev-audit-other-member';
    const now = Math.floor(Date.now() / 1000);
    identities.set(other, { sub, cookie: `${config.cookieName}=${encodeSession(config, {
      sub, orgId: config.expectedOrgId!, roles: [], authTime: now, exp: now + 300,
    })}` });
    await ensureMember(other, 'member');
    await until(async () => (await authz.check(other, 'member')).allowed, 'other audit member OpenFGA');
    await until(async () => (await fetch(`${origin}/api/chat`, { headers: headers(other) })).status === 200,
      'other audit member authenticated live chat access');
    const ceilings = await modelHistory(events.store, `budget-${silo}`, silo);
    const run = ceilings.some(row => row.event.type === 'budget.ceiling_set' && !['installation', 'dev-only-stub-journey'].includes((row.event.data as { setBy: string }).setBy)) ? 'repeat' : 'fresh';
    try {
      await browserAuditJourney(browser.ownerPage, browser.memberPages, origin, member,
        identities.get(other)!.cookie, run);
      await browserBudgetJourney(browser.ownerPage, browser.memberPages, origin, events.store,
        silo, computer!.assistant_id);
    } finally {
      await restoreBudgetCeilings(browser.ownerPage, origin, events.store, silo,
        computer!.assistant_id);
    }
  }
  await runPhase4Journey();
  for (const projection of ['members', 'mcp-catalogue']) {
    const result = await promisify(execFile)('npm', ['run', 'replay', '--', projection, '--verify'], {
      cwd: root, env: { ...base, ...await readEnv('projection') }, timeout: 60_000 });
    await writeFile(`${directory}/replay-${projection}.log`, result.stdout, { mode: 0o600 });
    console.log(`PASS npm run replay -- ${projection} --verify`);
  }
  const page = await fetch(`${origin}/org/integrations`, { signal: AbortSignal.timeout(15_000) });
  assert.equal(page.status, 200);
  assert((await page.text()).includes('<app-root'));
  console.log(secondary ? 'PASS loopback HTTP web page' : 'PASS tailnet HTTPS web page');
} catch (error) {
  const head = await events.store.head();
  const diagnostic = [];
  if (head) for await (const { event } of readEvents(events.store, 1, head)) {
    if (event.type.startsWith('budget.') || event.type === 'decision.recorded' || event.type.startsWith('computer.')) diagnostic.push(event);
  }
  await writeFile(`${directory}/qualification-failure.log`, JSON.stringify(diagnostic), { mode: 0o600 });
  throw error;
} finally {
  ws?.terminate();
  chat?.close();
  await events.close();
  await db.close();
  await browser?.close();
}
