import './journey-entry.ts';
import { requireJourneyProviderMode } from './journey-guard.ts';
import { realModelJourney } from './real-model-journey.ts';
import { uploadJourney } from './upload-journey.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
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
import { integrationsResponseSchema, realtimeMessageSchema, type IntegrationRow,
  type RealtimeMessage } from '@opencrane/protocol';
import { journeyTool, reviewJourneyTools } from './journey-tool-policy.ts';
import { journeyIntegrationRegistration } from './journey-integration-fixture.ts';
import { browserChatJourney } from './browser-chat.ts';
import { browserBudgetJourney, restoreBudgetCeilings } from './browser-budgets.ts';
import { prepareBudgetAssistant } from './budget-fixture.ts';
import { auditPrompt, browserAuditJourney } from './browser-audit.ts';
import { browserLiveViewJourney } from './browser-live-view.ts';
import { browserPhase4, type Phase4Assertion } from './browser-phase4.ts';
import { browserGroupChat } from './browser-group-chat.ts';
import { chatJourney } from './chat-journey.ts';
import { browserSessions } from './browser-signin.ts';
import { namespace, secondary, stackId } from './identity.ts';
import { base, directory, readEnv, root, authEnv } from './config.ts';
import { SandboxClient } from '../../apps/ops/src/kubernetes.ts';
import { suspendComputer, type ComputerState } from '../../apps/ops/src/lifecycle.ts';

const settings = await readEnv('settings');
requireJourneyProviderMode(settings);
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
let integrationRow: IntegrationRow | undefined;
const identities = new Map<string, { sub: string; cookie: string }>();
const phase4Assertions: Phase4Assertion[] = [];
const phase4Attempt = process.env['P4_JOURNEY_ATTEMPT'] ?? 'manual';

async function writePhase4Receipt(durationMs: number) {
  const receiptDirectory = `${directory}/p4-journey/${phase4Attempt}`;
  await mkdir(receiptDirectory, { recursive: true });
  const receiptPath = `${receiptDirectory}/receipt.json`;
  const commit = await currentCommit();
  const receipt = {
    commit,
    attempt: phase4Attempt,
    viewportWidths: [1280, 390],
    durationMs,
    assertions: phase4Assertions,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
}

async function currentCommit(): Promise<string> {
  const result = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root });
  return result.stdout.trim();
}
async function runPhase4Journey() {
  assert(browser, 'The Phase 4 journey needs real signed-in browser sessions');
  const startedAt = performance.now();
  let journeyFailure: unknown;
  try {
    await browserPhase4({ ownerPage: browser.ownerPage, memberPages: browser.memberPages,
      origin, directory, attempt: phase4Attempt, silo,
      secondaryStack: secondary, scope: 'groups',
      store: events.store, append, assertions: phase4Assertions });
    const groupMembers = await groupChatMembers();
    await browserGroupChat({ ownerPage: browser.ownerPage, memberPages: browser.memberPages,
      otherPage: groupMembers.otherPage, thirdPage: groupMembers.thirdPage,
      origin, directory, attempt: phase4Attempt,
      store: events.store, assertions: phase4Assertions,
      restartConversations: restartServerAndReplay });
  } catch (error) {
    journeyFailure = error;
    phase4Assertions.push({ id: 'journey.execution', status: 'FAIL',
      statement: 'The browser checks did not all finish.',
      evidence: { reason: errorMessage(error) }, screenshots: [] });
  }
  try {
    await writePhase4Receipt(Math.round(performance.now() - startedAt));
  } catch (receiptError) {
    if (journeyFailure) {
      throw new AggregateError([journeyFailure, receiptError],
        'The journey failed and its private receipt could not be written.');
    }
    throw receiptError;
  }
  if (journeyFailure) throw journeyFailure;
  console.log(`PASS Phase 4 browser journey; receipt run-${phase4Attempt}.json`);
}

async function groupChatMembers() {
  assert(browser, 'The group chat journey needs signed-in browser sessions');
  const laterMember = 'p4-5-later-participant';
  const subject = `dev-${laterMember}`;
  const now = Math.floor(Date.now() / 1000);
  const cookieValue = `${config.cookieName}=${encodeSession(config, {
    sub: subject, orgId: config.expectedOrgId!, roles: [], authTime: now, exp: now + 3600,
  })}`;
  identities.set(laterMember, { sub: subject, cookie: cookieValue });
  await ensureNamedMember(laterMember, 'Maximiliana Alexandra de la Cruz-Wellington');
  await until(async () => (await authz.check(laterMember, 'member')).allowed,
    'later group participant OpenFGA');

  const otherMember = 'audit-other-member';
  const otherSubject = `dev-${otherMember}`;
  const otherCookie = `${config.cookieName}=${encodeSession(config, {
    sub: otherSubject, orgId: config.expectedOrgId!, roles: [], authTime: now, exp: now + 3600,
  })}`;
  identities.set(otherMember, { sub: otherSubject, cookie: otherCookie });
  await ensureNamedMember(otherMember, 'Audit colleague');
  await until(async () => (await authz.check(otherMember, 'member')).allowed,
    'second group colleague OpenFGA');

  const otherPage = await openSyntheticGroupPage(otherCookie);
  const thirdPage = await openSyntheticGroupPage(cookieValue);
  return { otherPage, thirdPage };
}

async function openSyntheticGroupPage(cookie: string) {
  assert(browser);
  const context = await browser.browser.newContext({ viewport: { width: 390, height: 844 } });
  const value = cookie.slice(cookie.indexOf('=') + 1);
  await context.addCookies([{ name: config.cookieName, value, url: origin,
    httpOnly: true, sameSite: 'Lax' }]);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  await page.goto(`${origin}/workspace/direct`);
  await page.locator('#colleague-search').waitFor();
  return page;
}

async function restartServerAndReplay(): Promise<void> {
  await restartStackProcess('server', restartConversationWorker);
}

async function restartConversationWorker(): Promise<void> {
  await restartStackProcess('conversations', replayConversations);
}

async function replayConversations(): Promise<void> {
  const environment = { ...base, ...await readEnv('projection') };
  await promisify(execFile)('npm', ['run', 'start', '-w', 'apps/ops', '--', 'conversations',
    '--confirm-conversations-stopped'], { cwd: root, env: environment, timeout: 120_000 });
}

async function restartStackProcess(
  name: 'server' | 'conversations', whileStopped: () => Promise<void>,
): Promise<void> {
  const pidPath = `${directory}/${name}.pid`;
  const processRecord = (await readFile(pidPath, 'utf8')).trim().split(' ');
  const previousPid = Number(processRecord[0]);
  assert(Number.isInteger(previousPid) && previousPid > 1, 'The stack process PID is missing');
  const statBeforeStop = await readFile(`/proc/${previousPid}/stat`, 'utf8');
  const startToken = statStartToken(statBeforeStop);
  assert.equal(startToken, processRecord[1], 'The stack process changed');
  const commandLine = (await readFile(`/proc/${previousPid}/cmdline`, 'utf8'))
    .split('\0').filter(Boolean);
  const expectedEntrypoint = matchesStackEntrypoint.bind(null, name);
  assert(commandLine.some(expectedEntrypoint), 'The stack PID has the wrong entry point');
  if (name === 'conversations') {
    assert(commandLine.includes(name), 'The stack PID is not the conversations worker');
  }
  const environmentEntries = (await readFile(`/proc/${previousPid}/environ`, 'utf8'))
    .split('\0').filter(Boolean);
  const processEnvironment = Object.fromEntries(environmentEntries.map(splitEnvironmentEntry));
  const workingDirectory = await readFile(`/proc/${previousPid}/cwd`, 'utf8').catch(() => root);
  process.kill(-previousPid, 'SIGTERM');
  await until(async () => !await processExists(previousPid), `old ${name} process stopped`);
  await rm(pidPath, { force: true });
  // Rebuild with both readers and the worker stopped before either restarts.
  await whileStopped();

  const log = await open(`${directory}/${name}.log`, 'a', 0o600);
  try {
    const restarted = spawn(commandLine[0]!, commandLine.slice(1), {
      cwd: workingDirectory, env: processEnvironment, detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    await once(restarted, 'spawn');
    const restartedPid = restarted.pid!;
    const restartedToken = await untilValue(() => processStartToken(restartedPid),
      `new ${name} process started`);
    await writeFile(pidPath, `${restartedPid} ${restartedToken}`, { mode: 0o600 });
    restarted.unref();
    if (name === 'server') {
      const healthUrl = `http://127.0.0.1:${settings['SERVER_PORT']}/healthz`;
      const deadline = Date.now() + 120_000;
      async function serverReady() {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error('Timed out: restarted stack server health');
        }
        const signal = AbortSignal.timeout(remainingMs);
        const requestOptions = { signal, redirect: 'manual' as const };
        let response: Response;
        try {
          response = await fetch(healthUrl, requestOptions);
        } catch (error) {
          if (signal.aborted) {
            throw new Error('Timed out: restarted stack server health');
          }
          response = returnUnavailable(error);
        }
        if (response.ok) return true;
        if ([502, 503, 504].includes(response.status)) return false;
        throw new Error(`restarted stack server health: HTTP ${response.status}`);
      }
      await until(serverReady, 'restarted stack server health');
    }
  } finally {
    await log.close();
  }
}

function matchesStackEntrypoint(name: 'server' | 'conversations', argument: string): boolean {
  if (name === 'server') {
    return argument.endsWith('apps/server/src/main.ts');
  }
  return argument.endsWith('apps/ops/src/worker.ts');
}

function splitEnvironmentEntry(entry: string): [string, string] {
  const separator = entry.indexOf('=');
  return [entry.slice(0, separator), entry.slice(separator + 1)];
}

function statStartToken(stat: string): string | undefined {
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  if (fields[0] === 'Z') return undefined;
  return fields[19];
}

async function processStartToken(pid: number): Promise<string | undefined> {
  try {
    return statStartToken(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return undefined;
  }
}

async function processExists(pid: number): Promise<boolean> {
  return Boolean(await processStartToken(pid));
}

async function untilValue<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

function returnUnavailable(error: unknown): Response {
  if (!(error instanceof TypeError)) throw error;
  const cause = error.cause as { code?: string } | undefined;
  const connectionErrors = ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
    'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'];
  if (!cause?.code || !connectionErrors.includes(cause.code)) throw error;
  return new Response(null, { status: 503 });
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
async function append(type: string, subject: string, data: Record<string, unknown>,
  source = 'dev-stack-journey', principalId = 'dev-only-bootstrap') {
  const example = getEventDefinition(type)?.example;
  assert(example && typeof example === 'object');
  const eventId = randomUUID();
  const parsed = parseEventByType({ id: eventId, commandId: eventId, type, subject, silo, source,
    time: new Date().toISOString(), principal: { kind: 'human', id: principalId },
    data: { ...example, ...data } });
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
  // Use the seeded owner as inviter so OpenFGA can confirm invitation authority.
  const email = signedInMemberEmail(memberId);
  await append('member.invited', `member-${memberId}`, { memberId, role, invitationId: `invite-${memberId}-${id}`,
    email, invitedBy: 'jente-rosseel',
    invitedIdentity: { issuer: config.issuerUrl, sub: identities.get(memberId)?.sub ?? `dev-${memberId}` },
    expiresAt: new Date(Date.now() + 3600_000).toISOString() }, 'dev-stack-journey',
  '378127409465593948');
}
function signedInMemberEmail(memberId: string): string {
  if (memberId === 'zitadel-owner') {
    return `opencrane2-dev-ci-${stackId}-owner@example.test`;
  }
  if (memberId === 'zitadel-member') {
    return `opencrane2-dev-ci-${stackId}-member@example.test`;
  }
  return `${memberId}@example.test`;
}
async function join(memberId: string, displayName = memberId) {
  const response = await fetch(`${server}/members/join`, { method: 'POST',
    headers: { ...headers(memberId), 'content-type': 'application/json' },
    body: JSON.stringify({ memberId, invitationId: `invite-${memberId}-${id}`, commandId: `join-${memberId}-${id}`, displayName }),
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
async function ensureNamedMember(memberId: string, displayName: string) {
  if (await activeMember(memberId)) return;
  const invitationId = `invite-${memberId}-${id}`;
  const email = `${memberId}@example.test`;
  await append('member.invited', `member-${memberId}`, { memberId, role: 'member', invitationId,
    email, invitedBy: 'jente-rosseel',
    invitedIdentity: { issuer: config.issuerUrl, sub: identities.get(memberId)?.sub ?? `dev-${memberId}` },
    expiresAt: new Date(Date.now() + 3600_000).toISOString() }, 'dev-stack-journey',
  '378127409465593948');
  // Skip personal computers for these colleagues so the demo assistant fits in this slot.
  await append('member.joined', `member-${memberId}`, { memberId, invitationId,
    displayName, email, role: 'member', personalAssistant: 'none' }, 'dev-stack-journey',
  identities.get(memberId)?.sub ?? `dev-${memberId}`);
  await until(() => activeMember(memberId), `seeded member projection ${memberId}`);
}
async function computerEvents(assistantId: string) {
  const result = [];
  for await (const stored of events.store.readStream(`computer-${assistantId}`)) result.push(stored.event);
  return result;
}
type ModelGrantExpectation = {
  granteeId: string;
  modelIds: string[];
};

function isActiveModel(model: typeof models[number]) {
  return !model.retired;
}

function isModelGrant(grant: unknown): grant is { resourceType: string; resourceId: string } {
  if (!grant || typeof grant !== 'object') return false;
  if (!('resourceType' in grant) || !('resourceId' in grant)) return false;
  return grant.resourceType === 'model' && typeof grant.resourceId === 'string';
}

function selectedModelIds(data: Record<string, unknown>) {
  const grants = data['grants'];
  if (!Array.isArray(grants)) return [];
  const modelGrants = grants.filter(isModelGrant);
  return modelGrants.map(readModelGrantId);
}

function readModelGrantId(grant: { resourceType: string; resourceId: string }) {
  return grant.resourceId;
}

async function modelGrantsRecorded() {
  const expectations = new Map<string, ModelGrantExpectation[]>();
  const grants = new Set<string>();
  const activeModelIds = models.filter(isActiveModel).map(readActiveModelId);
  const head = await events.store.head();
  if (head) for await (const { event } of readEvents(events.store, 1, head)) {
    assert.equal(event.silo, silo);
    const data = event.data as Record<string, unknown>;
    if (event.type === 'member.joined') {
      const memberId = data['memberId'];
      assert(typeof memberId === 'string');
      expectations.set(event.subject, [{ granteeId: memberId, modelIds: activeModelIds }]);
    }
    if (event.type === 'assistant.created') {
      const assistantId = data['assistantId'];
      assert(typeof assistantId === 'string');
      if (data['kind'] === 'team') {
        // Keep shared assistants to the models named in their saved selection.
        const ownerId = data['ownerId'];
        assert(typeof ownerId === 'string');
        const selectedIds = selectedModelIds(data);
        expectations.set(event.subject, [
          { granteeId: assistantId, modelIds: selectedIds },
          { granteeId: ownerId, modelIds: selectedIds },
        ]);
      } else {
        expectations.set(event.subject, [{ granteeId: assistantId, modelIds: activeModelIds }]);
      }
    }
    if (event.type === 'member.removed') expectations.delete(event.subject);
    // An explicit revocation also counts: migration must preserve that decision.
    if (data['resourceType'] === 'model' && ['grant.given', 'grant.revoked'].includes(event.type)) {
      grants.add(JSON.stringify([data['resourceId'], data['granteeId']]));
    }
  }
  for (const entityExpectations of expectations.values()) {
    for (const expectation of entityExpectations) {
      for (const modelId of expectation.modelIds) {
        if (!grants.has(JSON.stringify([modelId, expectation.granteeId]))) return false;
      }
    }
  }
  return true;
}

function readActiveModelId(model: typeof models[number]) {
  return model.id;
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
  if (settings['DEV_REAL_PROVIDER'] === '1') {
    assert(secondary && browser);
    await realModelJourney(browser.ownerPage, browser.memberPages[0]!, origin, events.store, silo);
  } else {
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
  console.log('SKIP approval journey: waits for #45 rows 4, 5 and 14');
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
  const registration = journeyIntegrationRegistration(serverId);
  await append('mcp.server_registered', `mcp-${serverId}`, registration);
  assert(browser, 'The integration journey needs the signed-in owner');
  const readTool = journeyTool('read', true);
  const writeTool = journeyTool('write', false);
  const serverInfo = { name: 'Journey MCP', version: '1.0.0' };
  await reviewJourneyTools(browser.ownerPage, events.store, silo, origin, append, serverId,
    [readTool, writeTool], ['allow', 'block'], serverInfo);
  await until(async () => {
    const response = await fetch(`${server}/api/org/integrations`, { headers: headers(admin), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    const result = integrationsResponseSchema.parse(await response.json());
    const row = result.rows.find((row) => row.serverId === serverId);
    integrationRow = row;
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
    await ensureNamedMember(other, 'Audit colleague');
    await until(async () => (await authz.check(other, 'member')).allowed, 'other audit member OpenFGA');
    await until(async () => (await fetch(`${origin}/api/chat`, { headers: headers(other) })).status === 200,
      'other audit member authenticated live chat access');
    const ceilings = await modelHistory(events.store, `budget-${silo}`, silo);
    const run = ceilings.some(row => row.event.type === 'budget.ceiling_set' && !['installation', 'dev-only-stub-journey'].includes((row.event.data as { setBy: string }).setBy)) ? 'repeat' : 'fresh';
    await browserAuditJourney(browser.ownerPage, browser.memberPages, origin, member,
      identities.get(other)!.cookie, run);
    const budgetAssistant = await prepareBudgetAssistant(browser.ownerPage,
      browser.memberPages, origin, member);
    try {
      await browserBudgetJourney(browser.ownerPage, browser.memberPages, origin, events.store,
        silo, budgetAssistant.assistantId, budgetAssistant.groupId);
    } finally {
      await restoreBudgetCeilings(browser.ownerPage, origin, events.store, silo,
        budgetAssistant.assistantId, budgetAssistant.groupId);
    }
  }
  }
  const phase4Requested = process.env['P4_JOURNEY_ATTEMPT'] !== undefined;
  if (secondary && browser && phase4Requested) await runPhase4Journey();
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
  const integrationEvents = [];
  if (head) for await (const { event, sequence } of readEvents(events.store, 1, head)) {
    if (event.type.startsWith('budget.') || event.type === 'decision.recorded' || event.type.startsWith('computer.')) diagnostic.push(event);
    if (event.subject === `mcp-journey-${id}`) {
      // Keep event order without copying tool definitions or upstream error details.
      integrationEvents.push({ type: event.type, sequence, time: event.time });
    }
  }
  const integrationDiagnostic = { row: integrationRow, events: integrationEvents };
  await writeFile(`${directory}/integration-row-failure.json`,
    JSON.stringify(integrationDiagnostic), { mode: 0o600 });
  await writeFile(`${directory}/qualification-failure.log`, JSON.stringify(diagnostic), { mode: 0o600 });
  throw error;
} finally {
  ws?.terminate();
  chat?.close();
  await events.close();
  await db.close();
  await browser?.close();
}
