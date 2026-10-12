import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { errors, type Page } from 'playwright';
import { z } from 'zod';
import { computerCredentials, tokenIssuer } from '@opencrane/auth';
import { grantStream, type memberAuthorisation } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';
import { directory, readEnv } from './config.ts';
import { approvalJourneyTool, reviewJourneyTools } from './journey-tool-policy.ts';

type Append = (type: string, subject: string, data: Record<string, unknown>, source?: string) => Promise<void>;

async function captureApprovalFailure(page: Page, width: number, error: unknown) {
  const screenshotPath = `${directory}/approval-failure-${width}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const approvalCards = page.locator('oc-approval-cards');
  const approvalSnapshot = await approvalCards.ariaSnapshot();
  const report = `${String(error)}\n\n${approvalSnapshot}`;
  await writeFile(`${directory}/approval-failure-${width}.txt`, report, { mode: 0o600 });
}

/** Real browser decisions and gateway admission; only the tool and its active turn are scripted. */
export async function approvalJourney(ownerPage: Page, pages: Page[], store: EventStore,
  auth: ReturnType<typeof memberAuthorisation>, append: Append,
  input: { silo: string; origin: string; requesterId: string; assistantId: string; computerId: string; generation: number }) {
  const settings = await readEnv('settings');
  const budget = await history(store, `budget-${input.silo}`, input.silo);
  const { defaultPayingGroupId } = z.object({ defaultPayingGroupId: z.string().min(1) }).parse(
    budget.findLast(row => row.event.type === 'budget.ceiling_set' &&
      z.object({ defaultPayingGroupId: z.string() }).safeParse(row.event.data).success)?.event.data);
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/token-signing-key.pem`, issuer: `${input.origin}/` });
  const serverId = 'approval-journey', connectionId = 'installed';
  const upstream = `http://127.0.0.1:${settings['MODEL_STUB_PORT']}`;
  await append('mcp.server_registered', `mcp-${serverId}`, { serverId, kind: 'remote', locator: `${upstream}/mcp`, registeredBy: 'zitadel-owner' });
  const writeTool = approvalJourneyTool();
  await reviewJourneyTools(ownerPage, store, input.silo, input.origin, append,
    serverId, [writeTool], ['ask']);
  for (const [granteeId, granteeKind] of [[input.requesterId, 'member'], [input.assistantId, 'assistant']]) {
    await append('grant.given', grantStream('mcp_server', serverId), { resourceType: 'mcp_server', resourceId: serverId, granteeId, granteeKind, grantedBy: 'zitadel-owner' });
  }
  const until = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 90_000;
    while (!await check()) { assert(Date.now() < deadline, 'Approval journey timeout'); await delay(100); }
  };
  const grants = await history(store, grantStream('mcp_server', serverId), input.silo);
  await until(async () => (await Promise.all(grants.map(row => auth.applied(row.event.id)))).every(Boolean));
  await until(async () => (await Promise.all([
    auth.use('person', input.requesterId, 'mcp_server', serverId), auth.use('assistant', input.assistantId, 'mcp_server', serverId),
  ])).every(result => result.allowed));
  const calls = async () => {
    const response = await fetch(`${upstream}/approval-calls`);
    assert.equal(response.status, 200);
    return z.array(z.object({ body: z.string(), requestId: z.uuid() })).parse(await response.json());
  };
  await mkdir('docs/process/p3-2-live', { recursive: true });
  for (const page of pages) {
    const width = page.viewportSize()!.width, conversationId = randomUUID(), turnId = randomUUID();
    const response = await page.request.post(`${input.origin}/api/conversations`, { headers: { origin: input.origin },
      data: { id: randomUUID(), conversationId, assistantId: input.assistantId } });
    assert.equal(response.status(), 200, 'Requester creates the conversation');
    await until(async () => (await auth.conversation(input.requesterId, conversationId, 'post')).allowed);
    await append('agent.turn_started', `conversation-${conversationId}`, { conversationId, turnId, assistantId: input.assistantId });
    await append('computer.turn_started', `computer-${input.assistantId}`, { assistantId: input.assistantId, computerId: input.computerId, requesterId: input.requesterId, conversationId, turnId, threadId: conversationId, task: 'chat_turn', payingGroupId: defaultPayingGroupId }, 'opencrane-server');
    try {
      const rows = await history(store, `computer-${input.assistantId}`, input.silo);
      const { tokenId } = z.object({ tokenId: z.string() }).parse(rows.findLast(row => ['computer.claimed', 'computer.resumed'].includes(row.event.type))?.event.data);
      const computer = await tokens.computer({ ...input, tokenId });
      function body(note: string) {
        const metadata = {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          threadId: conversationId,
          callId: `approval-${width}`,
        };
        const argumentsData = { order: `Order-${width}`, note };
        const request = { jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'write', arguments: argumentsData, _meta: metadata } };
        return JSON.stringify(request);
      }
      const call = async (note: string) => {
        const turn = await computerCredentials(store, tokens, input.silo).turn({ ...input, conversationId, turnId, threadId: conversationId, task: 'chat_turn', model: 'gpt-6-luna' });
        const result = await fetch(`http://127.0.0.1:${settings['MODEL_GATEWAY_PORT']}/mcp/${serverId}/${connectionId}`, { method: 'POST',
          headers: { authorization: `Bearer ${computer.value}`, 'x-turn-token': turn.value, 'session-id': conversationId,
            'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'write' }, body: body(note) });
        await result.arrayBuffer(); return result.status;
      };
      const before = (await calls()).length;
      await page.goto(`${input.origin}/workspace?conversation=${conversationId}`);
      assert.equal(await call('Approved journey note'), 403, 'Ask refuses before forwarding');
      const requested = page.getByRole('region', { name: 'Approval needed', exact: true });
      await requested.waitFor();
      const approvalId = await requested.getAttribute('data-approval');
      assert(approvalId);
      assert((await requested.locator('.approval-ledger').innerText()).includes(`Order-${width}`));
      assert.equal((await calls()).length, before, 'Ask has zero upstream effects');
      await page.reload(); await requested.waitFor();
      await page.evaluate('document.fonts.ready');
      assert(await requested.evaluate(element => element.scrollWidth <= element.clientWidth), 'Card fits viewport');
      await page.screenshot({ path: `docs/process/p3-2-live/requested-${width}.png`, fullPage: true });
      const decide = async (button: 'Approve' | 'Deny', label: RegExp | string) => {
        const terminal = page.getByRole('button', { name: label });
        for (let attempt = 1; attempt <= 3; attempt++) {
          const decisionPattern = button === 'Approve' ? /^Approve:/ : /^Deny:/;
          await requested.getByRole('button', { name: decisionPattern }).click();
          const check = requested.getByRole('button', { name: 'Check status', exact: true });
          const notRecorded = requested.getByText(
            'Your decision was not recorded. You can decide again.', { exact: true },
          );
          await until(async () => await terminal.isVisible() || await check.isVisible()
            || await notRecorded.isVisible());
          if (await terminal.isVisible()) return attempt;
          if (await notRecorded.isVisible()) continue;
          for (let read = 1; read <= 3; read++) {
            await check.click();
            try {
              await terminal.or(requested.getByText('The server shows this approval still open'))
                .waitFor({ timeout: 15_000 });
              break;
            } catch (error) {
              if (!(error instanceof errors.TimeoutError) || read === 3) throw error;
            }
          }
          if (await terminal.isVisible()) return attempt;
        }
        throw new Error(`${button} did not complete after three submissions with status checks`);
      };
      const approveAttempts = await decide('Approve', /Approved by you.*Not used yet/);
      const approved = page.getByRole('button', { name: /Approved by you.*Not used yet/ });
      await page.reload(); await approved.waitFor();
      await page.screenshot({ path: `docs/process/p3-2-live/approved-${width}.png`, fullPage: true });
      assert.equal(await call('Approved journey note'), 200);
      assert.equal(await call('Approved journey note'), 403, 'Second retry refused');
      const recorded = await calls();
      assert.equal(recorded.length, before + 1, 'Exactly one upstream call');
      assert.equal(recorded.at(-1)!.body, body('Approved journey note'), 'Approved bytes forwarded unchanged');
      const audit = await history(store, `decision-${recorded.at(-1)!.requestId}`, input.silo);
      assert(audit.some(row => row.event.type === 'decision.recorded' && (row.event.data as { outcome: string }).outcome === 'allow'));
      await page.reload();
      await page.getByRole('button', { name: /Approved by you.*used once/ }).waitFor();
      await page.screenshot({ path: `docs/process/p3-2-live/used-${width}.png`, fullPage: true });
      assert.equal(await call('Denied journey note'), 403);
      await requested.waitFor();
      const denyAttempts = await decide('Deny', /Denied by you/);
      assert.equal(await call('Denied journey note'), 403, 'Denied call refused');
      assert.equal((await calls()).length, before + 1, 'Denial has zero upstream effects');
      await page.reload();
      await page.getByRole('button', { name: /Denied by you/ }).waitFor();
      await page.getByRole('button', { name: /Approved by you.*used once/ }).waitFor();
      assert.equal(await page.getByRole('button', { name: /^Approve:/ }).count(), 0);
      await page.screenshot({ path: `docs/process/p3-2-live/denied-${width}.png`, fullPage: true });
      const approvals = await history(store, `approval-${approvalId}`, input.silo);
      assert.equal(approvals.filter(row => row.event.type === 'approval.used' &&
        (row.event.data as { permitId: string }).permitId === recorded.at(-1)!.requestId).length, 1);
      console.log(`PASS approvals ${width}px: Ask → live 8g card → requester approval → exactly one recorded upstream call; second retry and denial refused; requested/approved/used/denied restored after reload; decision submissions approve=${approveAttempts}, deny=${denyAttempts}`);
    } catch (error) {
      // Capture the card before cleanup closes the turn and leaves the conversation.
      await captureApprovalFailure(page, width, error);
      throw error;
    } finally {
      await append('agent.turn_completed', `conversation-${conversationId}`, { conversationId, turnId });
      await append('computer.turn_closed', `computer-${input.assistantId}`, { assistantId: input.assistantId, computerId: input.computerId, requesterId: input.requesterId, conversationId, turnId, threadId: conversationId, task: 'chat_turn', status: 'completed' }, 'opencrane-server');
      await page.goto(input.origin); // Stop this viewport's polling before the next journey.
    }
  }
}
