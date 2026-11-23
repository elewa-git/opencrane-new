import assert from 'node:assert/strict';
import type { Page, Response } from 'playwright';
import type { z } from 'zod';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { computerTurnStartedDataSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { approvalToolBody, issueApprovalComputer, waitForApprovalSetup,
  type ApprovalJourneyIdentity, type ApprovalToolRequest } from './approval-tool.ts';
import { approvedAndUnused, captureApprovalState, decideJourneyApproval, postedRequestField }
  from './approval-cards.ts';

export type ApprovalStopInput = ApprovalJourneyIdentity & {
  conversationId: string;
  toolUrl: string;
};

export async function stopApprovalTurn(page: Page, store: EventStore,
  tokens: Awaited<ReturnType<typeof tokenIssuer>>, input: ApprovalStopInput) {
  await page.goto(`${input.origin}/workspace?conversation=${input.conversationId}`);
  const before = await store.head();
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  await composer.fill('Say hello again.');
  await composer.press('Enter');
  await page.locator('.caret').waitFor();
  const subject = `computer-${input.assistantId}`;
  type ChatTurn = Extract<z.infer<typeof computerTurnStartedDataSchema>, { task: 'chat_turn' }>;
  let active: ChatTurn | undefined;
  async function started() {
    const rows = await history(store, subject, input.silo);
    for (const row of rows) {
      if (row.sequence <= before || row.event.type !== 'computer.turn_started') continue;
      const turn = computerTurnStartedDataSchema.parse(row.event.data);
      if (turn.task !== 'chat_turn') continue;
      if (turn.conversationId === input.conversationId) active = turn;
    }
    return active !== undefined;
  }
  await waitForApprovalSetup(started);
  assert(active);
  const computer = await issueApprovalComputer(store, tokens, input);
  const claims = { ...input, ...active, model: active.model ?? 'gpt-6-luna' };
  const turn = await computerCredentials(store, tokens, input.silo).turn(claims);
  const toolRequest: ApprovalToolRequest = { threadId: active.threadId,
    callId: `after-browser-stop-${active.turnId}`, slot: 'morning' };
  const body = approvalToolBody(toolRequest);
  const headers = { authorization: `Bearer ${computer.value}`, 'x-turn-token': turn.value,
    'session-id': active.threadId, 'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': 'change_delivery_slot' };
  const request = { method: 'POST', headers, body };
  // Approve these exact bytes so Ask alone cannot explain the later refusal.
  const asking = await fetch(input.toolUrl, request);
  await asking.arrayBuffer();
  assert.equal(asking.status, 403, 'The active native turn requests approval');
  const requested = page.getByRole('region', { name: 'Approval needed', exact: true });
  await requested.waitFor();
  await decideJourneyApproval(page, requested, 'Approve', approvedAndUnused);
  await captureApprovalState(page, 'stop-approved');
  function isStopResponse(response: Response) {
    const request = response.request();
    if (request.method() !== 'POST' || !response.url().includes('/api/conversations/')) {
      return false;
    }
    return postedRequestField(response, 'stopTurnId') === active?.turnId;
  }
  const stopping = page.waitForResponse(isStopResponse);
  await page.locator('oc-chat-composer').getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal((await stopping).status(), 200, 'Requester saves Stop through the browser');
  const refusal = await fetch(input.toolUrl, request);
  await refusal.arrayBuffer();
  assert.equal(refusal.status, 403, 'The next tool call on the stopped turn is refused');
  await page.getByText('Stopped · partial reply kept', { exact: true }).waitFor();
  const width = page.viewportSize()!.width;
  await captureApprovalState(page, 'stopped');
  const message = `PASS browser Stop ${width}px in the long chat; ` +
    'the same approved request is refused with HTTP 403';
  console.log(message);
}
