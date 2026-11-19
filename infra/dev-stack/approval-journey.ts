import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Response } from 'playwright';
import { z } from 'zod';
import { computerCredentials, tokenIssuer } from '@opencrane/auth';
import { grantStream, type memberAuthorisation } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { envelope, history, providerTurnAdmission } from '@opencrane/models';
import { conversationKeys, connectProjectionDb, type Query } from '@opencrane/projections';
import { directory, readEnv } from './config.ts';
import { approvalToolBody, issueApprovalComputer, prepareApprovalTool,
  type ApprovalJourneyIdentity } from './approval-tool.ts';
import { createStageBCollector } from './stage-b-collector.ts';
import { readStageBQuote } from './stage-b-readback.ts';
import { stopApprovalTurn } from './approval-stop.ts';

type Append = (type: string, subject: string, data: Record<string, unknown>, source?: string) => Promise<void>;

async function recordedApprovalCalls() {
  const text = await readFile(`${directory}/demo-calls.jsonl`, 'utf8');
  const rows = text.trim() ? text.trim().split('\n') : [];
  function parseRow(row: string) {
    return z.object({ body: z.string(), requestId: z.uuid() }).parse(JSON.parse(row));
  }
  return rows.map(parseRow);
}

async function captureApprovalFailure(page: Page, width: number, error: unknown) {
  const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  const screenshotPath = `${directory}/approval-failure-${width}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true, mask: [addresses] });
  const approvalCards = page.locator('oc-approval-cards');
  const approvalSnapshot = await approvalCards.ariaSnapshot();
  const report = `${String(error)}\n\n${approvalSnapshot}`;
  await writeFile(`${directory}/approval-failure-${width}.txt`, report, { mode: 0o600 });
}

/** Script approval requests; check browser decisions, gateway effects and a normal chat Stop. */
export async function approvalJourney(ownerPage: Page, pages: Page[], store: EventStore,
  auth: ReturnType<typeof memberAuthorisation>, append: Append,
  input: ApprovalJourneyIdentity) {
  const settings = await readEnv('settings');
  const budget = await history(store, `budget-${input.silo}`, input.silo);
  const { defaultPayingGroupId } = z.object({ defaultPayingGroupId: z.string().min(1) }).parse(
    budget.findLast(row => row.event.type === 'budget.ceiling_set' &&
      z.object({ defaultPayingGroupId: z.string() }).safeParse(row.event.data).success)?.event.data);
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/token-signing-key.pem`, issuer: `${input.origin}/` });
  const connectionId = 'installed';
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 90_000;
    while (!await check()) { assert(Date.now() < deadline, 'Approval journey timeout'); await delay(100); }
  };
  const conversationId = randomUUID();
  const firstPage = pages[0]!;
  const response = await firstPage.request.post(`${input.origin}/api/conversations`,
    { headers: { origin: input.origin },
      data: { id: randomUUID(), conversationId, assistantId: input.assistantId } });
  assert.equal(response.status(), 200, 'Requester creates the conversation');
  await until(async () => (await auth.conversation(input.requesterId, conversationId, 'post')).allowed);
  await seedApprovalChat(store, input.silo, conversationId, input.assistantId);
  const admission = await providerTurnAdmission(store, input.silo, input.assistantId,
    performance.now() + 10_000);
  assert.equal(admission.choice?.state, 'active');
  assert(admission.choice);
  const provider = { providerId: admission.choice.providerId,
    bindingSequence: admission.choice.bindingSequence, model: admission.choice.model };
  const toolInput = { ownerPage, store, silo: input.silo, origin: input.origin };
  const { serverId, revision } = await prepareApprovalTool(toolInput);
  const collector = createStageBCollector(`${directory}/approval-readback`);
  for (const [granteeId, granteeKind] of [[input.requesterId, 'member'], [input.assistantId, 'assistant']]) {
    await append('grant.given', grantStream('mcp_server', serverId), { resourceType: 'mcp_server', resourceId: serverId, granteeId, granteeKind, grantedBy: 'zitadel-owner' });
  }
  const grants = await history(store, grantStream('mcp_server', serverId), input.silo);
  await until(async () => (await Promise.all(grants.map(row => auth.applied(row.event.id)))).every(Boolean));
  await until(async () => (await Promise.all([
    auth.use('person', input.requesterId, 'mcp_server', serverId), auth.use('assistant', input.assistantId, 'mcp_server', serverId),
  ])).every(result => result.allowed));
  await mkdir('docs/process/work-bug-1148-s1', { recursive: true });
  for (const page of pages) {
    const width = page.viewportSize()!.width;
    const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    const turnId = randomUUID();
    await append('agent.turn_started', `conversation-${conversationId}`, { conversationId, turnId, assistantId: input.assistantId });
    await append('computer.turn_started', `computer-${input.assistantId}`, { assistantId: input.assistantId, computerId: input.computerId, requesterId: input.requesterId, conversationId, turnId, threadId: conversationId, task: 'chat_turn', payingGroupId: defaultPayingGroupId, ...provider }, 'opencrane-server');
    try {
      const computer = await issueApprovalComputer(store, tokens, input);
      function body(slot: 'morning' | 'afternoon') {
        return approvalToolBody({ threadId: conversationId, callId: `approval-${width}`, slot });
      }
      const call = async (slot: 'morning' | 'afternoon') => {
        const turn = await computerCredentials(store, tokens, input.silo).turn({ ...input, conversationId, turnId, threadId: conversationId, task: 'chat_turn', ...provider });
        const result = await fetch(`http://127.0.0.1:${settings['MODEL_GATEWAY_PORT']}/mcp/${serverId}/${connectionId}`, { method: 'POST',
          headers: { authorization: `Bearer ${computer.value}`, 'x-turn-token': turn.value, 'session-id': conversationId,
            'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'change_delivery_slot' }, body: body(slot) });
        await result.arrayBuffer(); return result.status;
      };
      const before = (await recordedApprovalCalls()).length;
      const beforeQuote = await readStageBQuote(collector, `${directory}/stage-b-demo.sock`,
        revision, `before-${width}`);
      assert.equal(beforeQuote.value.effectCount, before);
      await page.goto(`${input.origin}/workspace?conversation=${conversationId}`);
      assert.equal(await call('afternoon'), 403, 'Ask refuses before forwarding');
      const requested = page.getByRole('region', { name: 'Approval needed', exact: true });
      await requested.waitFor();
      const approvalId = await requested.getAttribute('data-approval');
      assert(approvalId);
      assert((await requested.locator('.approval-ledger').innerText()).includes('DEMO-001'));
      assert.equal((await recordedApprovalCalls()).length, before, 'Ask has zero upstream effects');
      await page.reload(); await requested.waitFor();
      await page.evaluate('document.fonts.ready');
      assert(await requested.evaluate(element => element.scrollWidth <= element.clientWidth), 'Card fits viewport');
      await page.screenshot({ path: `docs/process/work-bug-1148-s1/requested-${width}.png`, fullPage: true, mask: [addresses] });
      async function decide(button: 'Approve' | 'Deny', label: RegExp | string) {
        const decidingId = await requested.getAttribute('data-approval');
        assert(decidingId);
        function isDecisionResponse(response: Response) {
          const request = response.request();
          return request.method() === 'POST' && response.url().endsWith('/approvals') &&
            request.postDataJSON()?.approvalId === decidingId;
        }
        const response = page.waitForResponse(isDecisionResponse);
        const decisionPattern = button === 'Approve' ? /^Approve:/ : /^Deny:/;
        await requested.getByRole('button', { name: decisionPattern }).click();
        assert.equal((await response).status(), 200, 'One decision submission succeeds');
        await approvalTerminal(page, decidingId, label).waitFor();
        return 1;
      }
      const approveAttempts = await decide('Approve', /Approved by you.*Not used yet/);
      const approved = page.getByRole('button', { name: /Approved by you.*Not used yet/ });
      await page.reload(); await approved.waitFor();
      await page.screenshot({ path: `docs/process/work-bug-1148-s1/approved-${width}.png`, fullPage: true, mask: [addresses] });
      assert.equal(await call('afternoon'), 200);
      assert.equal(await call('afternoon'), 403, 'Second retry refused');
      const recorded = await recordedApprovalCalls();
      const afterQuote = await readStageBQuote(collector, `${directory}/stage-b-demo.sock`,
        revision, `after-${width}`);
      assert.equal(afterQuote.value.effectCount, before + 1);
      assert.equal(afterQuote.value.slot, 'afternoon');
      assert.equal(recorded.length, before + 1, 'Exactly one upstream call');
      assert.equal(recorded.at(-1)!.body, body('afternoon'), 'Approved bytes forwarded unchanged');
      const audit = await history(store, `decision-${recorded.at(-1)!.requestId}`, input.silo);
      assert(audit.some(row => row.event.type === 'decision.recorded' && (row.event.data as { outcome: string }).outcome === 'allow'));
      await page.reload();
      await approvalTerminal(page, approvalId, /Approved by you.*used once/).waitFor();
      await page.screenshot({ path: `docs/process/work-bug-1148-s1/used-${width}.png`, fullPage: true, mask: [addresses] });
      assert.equal(await call('morning'), 403);
      await requested.waitFor();
      const deniedId = await requested.getAttribute('data-approval');
      assert(deniedId);
      const denyAttempts = await decide('Deny', /Denied by you/);
      assert.equal(await call('morning'), 403, 'Denied call refused');
      assert.equal((await recordedApprovalCalls()).length, before + 1, 'Denial has zero upstream effects');
      await page.reload();
      await approvalTerminal(page, deniedId, /Denied by you/).waitFor();
      await approvalTerminal(page, approvalId, /Approved by you.*used once/).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Approve:/ }).count(), 0);
      await page.screenshot({ path: `docs/process/work-bug-1148-s1/denied-${width}.png`, fullPage: true, mask: [addresses] });
      const approvals = await history(store, `approval-${approvalId}`, input.silo);
      assert.equal(approvals.filter(row => row.event.type === 'approval.used' &&
        (row.event.data as { permitId: string }).permitId === recorded.at(-1)!.requestId).length, 1);
      console.log(`PASS approvals ${width}px after 3,000 saved messages: Ask → live 8g card → requester approval → exactly one recorded upstream call; second retry and denial refused; requested/approved/used/denied restored after reload; decision submissions approve=${approveAttempts}, deny=${denyAttempts}`);
    } catch (error) {
      // Capture the card before cleanup closes the turn and leaves the conversation.
      await captureApprovalFailure(page, width, error);
      throw error;
    } finally {
      await append('agent.turn_completed', `conversation-${conversationId}`, { conversationId, turnId });
      await append('computer.turn_closed', `computer-${input.assistantId}`, { assistantId: input.assistantId, computerId: input.computerId, requesterId: input.requesterId, conversationId, turnId, threadId: conversationId, task: 'chat_turn', status: 'completed' }, 'opencrane-server');
      await page.goto(input.origin); // Stop this viewport's polling before the next journey.
    }
    const beforeStop = (await recordedApprovalCalls()).length;
    await stopApprovalTurn(page, store, tokens, { ...input, serverId, conversationId });
    assert.equal((await recordedApprovalCalls()).length, beforeStop,
      'Stop and the refused call have zero upstream effects');
    const stoppedQuote = await readStageBQuote(collector, `${directory}/stage-b-demo.sock`,
      revision, `stopped-${page.viewportSize()!.width}`);
    assert.equal(stoppedQuote.value.effectCount, beforeStop);
    await page.goto(input.origin);
  }
}

async function seedApprovalChat(store: EventStore, silo: string,
  conversationId: string, assistantId: string) {
  const server = await readEnv('server');
  const keys = conversationKeys(`${directory}/conversation-keys`,
    server['CONVERSATION_WRAP_KEY_FILE']);
  const encrypted = keys.encrypt(silo, conversationId, 'An earlier message in this long chat.');
  const subject = `conversation-${conversationId}`;
  let position = await store.head(subject);
  const db = connectProjectionDb(server['DATABASE_URL']!, failDatabase);
  try {
    // Keep setup traffic behind projection progress instead of creating an unbounded backlog.
    for (let batchIndex = 0; batchIndex < 60; batchIndex++) {
      for (let messageIndex = 0; messageIndex < 50; messageIndex++) {
        const data = { conversationId, authorId: assistantId, authorKind: 'agent',
          contentType: 'text', ...encrypted };
        const event = envelope(silo, subject, 'message.posted', data);
        const result = await store.append({ event, expectedSequence: position, historyChecked: true });
        assert.equal(result.status, 'appended', 'Seed each earlier chat message once');
        if (result.status !== 'appended') throw new Error('Chat seeding refused');
        position = result.sequence;
      }
      await waitForApprovalHistory(db.db, position);
    }
  } finally {
    await db.close();
  }
}

function failDatabase(error: Error) {
  throw error;
}

async function waitForApprovalHistory(db: Query, position: number) {
  const deadline = performance.now() + 30_000;
  while (true) {
    const saved = await db.query<{ sequence: string }>(
      "SELECT sequence FROM projection_checkpoints WHERE name='conversations'");
    if (Number(saved.rows[0]?.sequence) >= position) break;
    assert(performance.now() < deadline, 'The long chat reaches the conversation projection');
    await delay(100);
  }
}

function approvalTerminal(page: Page, approvalId: string, name: string | RegExp) {
  const identity = page.locator(`button[data-approval="${approvalId}"]`);
  return page.getByRole('button', { name }).and(identity);
}
