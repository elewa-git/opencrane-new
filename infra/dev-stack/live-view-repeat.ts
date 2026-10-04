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
import { authEnv, readEnv } from './config.ts';
import { secondary, stackId } from './identity.ts';
import { browserSessions } from './browser-signin.ts';
import { browserLiveViewJourney } from './browser-live-view.ts';

assert(secondary, 'Repeated qualification requires a claimed secondary stack');
const output = 'docs/process/i77-live-view';
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
try {
  browser = await browserSessions(config, origin);
  // The broad startup journey can fail before its fixture members have joined.
  for (const [memberId, role] of [[admin, 'owner'], [member, 'member']] as const) {
    if ((await db.db.query("SELECT 1 FROM members WHERE member_id=$1 AND status='joined'", [memberId])).rows.length) continue;
    const identity: { sub: string; cookie: string } = browser.sessions.get(role)!;
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
    const page: Page = browser.memberPages[(run - 1) % 2]!;
    const width = page.viewportSize()!.width, started = performance.now(), beforeLoad = loadavg();
    let result = 'PASS', failure: string | undefined;
    try {
      const conversationId = randomUUID();
      const response: APIResponse = await page.request.post(`${origin}/api/conversations`, { headers: { origin },
        data: { id: randomUUID(), conversationId, assistantId: computer.assistant_id } });
      assert.equal(response.status(), 200);
      await until(async () => (await auth.conversation(member, conversationId, 'read')).allowed, 'conversation projected');
      await page.goto(`${origin}/workspace?conversation=${conversationId}`);
      await page.getByRole('textbox', { name: 'Message your agent' }).waitFor();
      await page.waitForFunction(() => !document.querySelector('.skeleton'));
      await browserLiveViewJourney(page, origin, computer, { member, admin, silo, store: events.store, append, until,
        desktopAllowed: async () => (await auth.desktop(member, computer!.computer_id)).allowed });
      const receipt = JSON.parse(await readFile(`docs/process/live-view/conversation-${width}.json`, 'utf8')) as unknown;
      await writeFile(`${output}/run-${run}.json`, JSON.stringify(receipt, null, 2) + '\n');
    } catch (error) {
      result = 'FAIL'; failure = error instanceof Error ? error.message : String(error);
      await page.screenshot({ path: `${output}/run-${run}-failure.png` });
      process.exitCode = 1;
    }
    const receipt = { date: new Date().toISOString(), run, width, stackId, result, beforeLoad, afterLoad: loadavg(),
      durationMs: Math.round(performance.now() - started), ...(failure ? { failure } : {}) };
    await appendFile(`${output}/runs.jsonl`, JSON.stringify(receipt) + '\n');
    console.log(JSON.stringify(receipt));
  }
} finally {
  try { await browser?.close(); }
  finally { await events.close(); await db.close(); }
}
