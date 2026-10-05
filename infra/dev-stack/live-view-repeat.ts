/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadavg } from 'node:os';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { APIResponse, Page } from 'playwright';
import { loadAuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { connectEventStore } from '@opencrane/event-store';
import { envelope, history, models } from '@opencrane/models';
import { connectProjectionDb } from '@opencrane/projections';
import { authEnv, directory, readEnv } from './config.ts';
import { secondary, stackId } from './identity.ts';
import { browserSessions } from './browser-signin.ts';
import { browserViewTimings, collectViewTimings } from './live-view-timings.ts';
import { browserLiveViewJourney } from './browser-live-view.ts';

assert(secondary, 'Repeated qualification requires a claimed secondary stack');
const argumentsList = process.argv.slice(2);
const quiet = argumentsList.includes('--quiet');
const outputArgument = argumentsList.find(argument => argument !== '--quiet');
const output = outputArgument ?? 'docs/process/i77-live-view';
const cpuPressureLimit = quiet ? 10 : 20;
await mkdir(output, { recursive: true });
const settings = await readEnv('settings'), binding = await readEnv('binding');
const silo = settings['SILO_ID']!, origin = settings['ORIGIN']!;
const member = 'zitadel-member', admin = 'zitadel-owner';
const config = loadAuthConfig(await authEnv());
const events = await connectEventStore(await readEnv('command'));
const db = connectProjectionDb((await readEnv('server'))['DATABASE_URL']!, error => { throw error; });
const auth = memberAuthorisation({ silo, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!, authorizationModelId: binding['OPENFGA_MODEL_ID']! });
let browser: Awaited<ReturnType<typeof browserSessions>> | undefined;
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 120_000;
  while (!await check()) { assert(Date.now() < deadline, label); await delay(50); }
}
async function append(type: string, subject: string, data: Record<string, unknown>) {
  const event = envelope(silo, subject, type, data);
  const result = await events.store.append({ event, expectedSequence: (await history(events.store, subject, silo)).at(-1)?.sequence ?? 0 });
  assert.equal(result.status, 'appended');
}
async function cpuPressureSomeAvg10() {
  const pressure = await readFile('/proc/pressure/cpu', 'utf8');
  const someLine = pressure.split('\n').find((line) => line.startsWith('some '));
  assert(someLine, 'CPU pressure has a some line');
  const avg10 = someLine.match(/(?:^| )avg10=([\d.]+)/u)?.[1];
  assert(avg10, 'CPU pressure has avg10');
  return Number(avg10);
}
async function waitForLowCpuPressure(limit: number) {
  const deadline = Date.now() + 120_000;
  let avg10 = await cpuPressureSomeAvg10();
  while (avg10 >= limit && Date.now() < deadline) {
    await delay(1000);
    avg10 = await cpuPressureSomeAvg10();
  }
  return avg10;
}
function closeCodeForStopReason(reason: unknown): number | null {
  if (reason === 'access_changed' || reason === 'expired') return 4003;
  if (reason === 'unavailable') return 4503;
  if (reason === 'slow_viewer') return 1013;
  if (reason === 'disconnected' || reason === 'upstream' || reason === 'protocol' ||
    reason === 'shutdown') return 1000;
  return null;
}
type BrowserSessionMeasurement = {
  label: string;
  sessionId: string;
  count: number;
  durationMs: number[];
  revokeToClearMs?: number;
};
function sessionSummary(label: string, sessionId: string,
  browserSession: BrowserSessionMeasurement | undefined,
  timingRecords: Record<string, unknown>[], revokedAtTime: string) {
  const stop = timingRecords.find(record => record['stage'] === 'stop');
  const upgrade = timingRecords.find(record => record['stage'] === 'websocket_upgrade');
  const stopReason = stop?.['outcome'] ?? upgrade?.['outcome'];
  const leaseChecks = timingRecords.filter(record => record['stage'] === 'lease_check');
  const checksByBoundary: Record<string, number> = {};
  for (const check of leaseChecks) {
    const boundary = typeof check['boundary'] === 'string' ? check['boundary'] : 'none';
    const outcome = typeof check['outcome'] === 'string' ? check['outcome'] : 'unknown';
    const result = `${boundary}:${outcome}`;
    checksByBoundary[result] = (checksByBoundary[result] ?? 0) + 1;
  }
  const revokedAt = Date.parse(revokedAtTime);
  const deniedBeforeRevoke = leaseChecks.filter(check => {
    if (check['outcome'] !== 'denied') return false;
    if (!Number.isFinite(revokedAt)) return true;
    return typeof check['time'] === 'string' && Date.parse(check['time']) < revokedAt;
  }).length;
  const closeCode = stop ? closeCodeForStopReason(stopReason) : null;
  let upgradeStatus: number | undefined;
  if (!stop && (upgrade?.['outcome'] === 'access_changed' || upgrade?.['outcome'] === 'denied')) {
    upgradeStatus = 403;
  }
  const pauseCount = browserSession?.count ?? null;
  const pauseDurationMs = browserSession?.durationMs ?? null;
  const revokeToClearMs = browserSession?.revokeToClearMs ?? null;
  return {
    label,
    sessionId,
    stopReason,
    closeCode,
    ...(upgradeStatus === undefined ? {} : { upgradeStatus }),
    checksByBoundary,
    deniedBeforeRevoke,
    pauseCount,
    pauseDurationMs,
    revokeToClearMs,
    timingRecords,
  };
}
async function serverRunDelay() {
  const pidLine = await readFile(`${directory}/server.pid`, 'utf8');
  const pid = pidLine.split(' ')[0];
  assert(pid, 'Secondary server PID is recorded');
  const schedstat = await readFile(`/proc/${pid}/schedstat`, 'utf8');
  const runDelay = schedstat.trim().split(/\s+/u)[1];
  assert(runDelay, 'Server schedstat has a run-delay field');
  return BigInt(runDelay);
}
try {
  browser = await browserSessions(config, origin);
  // The broad startup journey can fail before its fixture members have joined.
  for (const [memberId, role] of [[admin, 'admin'], [member, 'member']] as const) {
    if ((await db.db.query("SELECT 1 FROM members WHERE member_id=$1 AND status='joined'", [memberId])).rows.length) continue;
    const sessionName = memberId === admin ? 'owner' : 'member';
    const identity: { sub: string; cookie: string } = browser.sessions.get(sessionName)!;
    const invitationId = randomUUID();
    await append('member.invited', `member-${memberId}`, { memberId, role, invitationId,
      email: `${memberId}@example.test`, invitedBy: 'dev-only-bootstrap',
      invitedIdentity: { issuer: config.issuerUrl, sub: identity.sub }, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    const response: Response = await fetch(`${origin}/members/join`, { method: 'POST',
      headers: { origin, cookie: identity.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ memberId, invitationId, commandId: randomUUID(), displayName: memberId }) });
    assert.equal(response.status, 200);
    await until(async () => (await auth.check(memberId, 'member')).allowed, 'member joined');
  }
  let computer: { assistant_id: string; computer_id: string; generation: number } | undefined;
  await until(async () => {
    computer = (await db.db.query<{ assistant_id: string; computer_id: string; generation: number }>(
      "SELECT assistant_id, computer_id, generation FROM computers WHERE owner_id=$1 AND status='ready'", [member])).rows[0];
    return Boolean(computer);
  }, 'member computer ready');
  assert(computer, 'Fresh stack member has a ready computer');
  await until(async () => (await Promise.all(models.filter(model => !model.retired).flatMap(model => [
    auth.use('person', member, 'model', model.id), auth.use('assistant', computer!.assistant_id, 'model', model.id),
  ]))).every(result => result.allowed), 'member and assistant model grants');
  for (let run = 1; run <= 10; run++) {
    const cpuPressureSomeAvg10 = await waitForLowCpuPressure(cpuPressureLimit);
    const serverRunDelayBefore = await serverRunDelay();
    const page: Page = browser.memberPages[(run - 1) % 2]!;
    const width = page.viewportSize()!.width, started = performance.now(), beforeLoad = loadavg();
    let result = 'PASS', failure: string | undefined;
    let journeySessions: BrowserSessionMeasurement[] = [];
    let revokedAtTime = '';
    const conversationId = randomUUID();
    const stopTimings = browserViewTimings(page, conversationId);
    try {
      assert(cpuPressureSomeAvg10 < cpuPressureLimit,
        `CPU pressure remained at or above ${cpuPressureLimit}%`);
      const response: APIResponse = await page.request.post(`${origin}/api/conversations`, { headers: { origin },
        data: { id: randomUUID(), conversationId, assistantId: computer.assistant_id } });
      assert.equal(response.status(), 200);
      await until(async () => (await auth.conversation(member, conversationId, 'read')).allowed, 'conversation projected');
      await page.goto(`${origin}/workspace?conversation=${conversationId}`);
      await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.skeleton'));
      await browserLiveViewJourney(page, origin, computer, { member, admin, silo, store: events.store, append, until,
        desktopAllowed: async () => (await auth.desktop(member, computer!.computer_id)).allowed });
      const journeyReceipt = JSON.parse(await readFile(`docs/process/live-view/conversation-${width}.json`, 'utf8')) as {
        sessions?: typeof journeySessions; revokedAtTime?: string;
      };
      await writeFile(`${output}/run-${run}.json`, JSON.stringify(journeyReceipt, null, 2) + '\n');
      journeySessions = journeyReceipt.sessions ?? [];
      revokedAtTime = journeyReceipt.revokedAtTime ?? '';
    } catch (error) {
      if (cpuPressureSomeAvg10 >= cpuPressureLimit) {
        result = 'LOADED';
        failure = `CPU pressure some avg10 was ${cpuPressureSomeAvg10}%`;
      } else {
        result = 'FAIL'; failure = error instanceof Error ? error.message : String(error);
        await page.screenshot({ path: `${output}/run-${run}-failure.png` });
        process.exitCode = 1;
      }
    }
    const serverRunDelayAfter = await serverRunDelay();
    const browserTimings = stopTimings();
    await writeFile(`${output}/run-${run}-browser.json`, JSON.stringify(browserTimings, null, 2) + '\n');
    const sessions: ReturnType<typeof sessionSummary>[] = [];
    let admittedSessionCount = 0;
    for (const timing of browserTimings) {
      if (timing.stage === 'admission_response' && timing.sessionId) {
        admittedSessionCount += 1;
        const sessionId = timing.sessionId;
        let label = `viewer ${admittedSessionCount}`;
        if (admittedSessionCount === 1) label = 'first view';
        if (admittedSessionCount === 2) label = 'during turn';
        const browserSession = journeySessions.find(session => session.sessionId === sessionId);
        const timingOutput = admittedSessionCount === 1
          ? `${output}/run-${run}-timings.jsonl`
          : `${output}/run-${run}-timings-${admittedSessionCount}.jsonl`;
        const timingRecords = await collectViewTimings(sessionId, timingOutput);
        sessions.push(sessionSummary(label, sessionId, browserSession, timingRecords, revokedAtTime));
      }
    }
    const receipt = {
      conversationId, sessions, date: new Date().toISOString(), run, width, stackId,
      result, beforeLoad,
      cpuPressureSomeAvg10, serverRunDelayDelta: String(serverRunDelayAfter - serverRunDelayBefore),
      afterLoad: loadavg(),
      durationMs: Math.round(performance.now() - started), ...(failure ? { failure } : {}),
    };
    await appendFile(`${output}/runs.jsonl`, JSON.stringify(receipt) + '\n');
    console.log(JSON.stringify(receipt));
  }
} finally {
  try { await browser?.close(); }
  finally { await events.close(); await db.close(); }
}
