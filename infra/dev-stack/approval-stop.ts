import assert from 'node:assert/strict';
import type { Page, Response } from 'playwright';
import type { z } from 'zod';
import { computerCredentials, type tokenIssuer } from '@opencrane/auth';
import type { EventStore } from '@opencrane/event-store';
import { computerTurnStartedDataSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { directory, readEnv } from './config.ts';
import { approvalToolBody, issueApprovalComputer, waitForApprovalSetup,
  type ApprovalJourneyIdentity } from './approval-tool.ts';

export type ApprovalStopInput = ApprovalJourneyIdentity & {
  conversationId: string;
  serverId: string;
};

export async function stopApprovalTurn(page: Page, store: EventStore,
  tokens: Awaited<ReturnType<typeof tokenIssuer>>, input: ApprovalStopInput) {
  const settings = await readEnv('settings');
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
  function isStopResponse(response: Response) {
    const request = response.request();
    if (request.method() !== 'POST' || !response.url().includes('/api/conversations/')) {
      return false;
    }
    return request.postDataJSON()?.stopTurnId === active?.turnId;
  }
  const stopping = page.waitForResponse(isStopResponse);
  await page.locator('oc-chat-composer').getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal((await stopping).status(), 200, 'Requester saves Stop through the browser');
  const body = approvalToolBody({ threadId: active.threadId,
    callId: 'after-browser-stop', slot: 'morning' });
  const url = `http://127.0.0.1:${settings['MODEL_GATEWAY_PORT']}/mcp/${input.serverId}/installed`;
  const headers = { authorization: `Bearer ${computer.value}`, 'x-turn-token': turn.value,
    'session-id': active.threadId, 'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call',
    'mcp-name': 'change_delivery_slot' };
  const refusal = await fetch(url, { method: 'POST', headers, body });
  await refusal.arrayBuffer();
  assert.equal(refusal.status, 403, 'The next tool call on the stopped turn is refused');
  await page.getByText('Stopped · partial reply kept', { exact: true }).waitFor();
  const width = page.viewportSize()!.width;
  const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  await page.screenshot({ path: `docs/process/work-bug-1148-s1/stopped-${width}.png`,
    fullPage: true, mask: [addresses] });
  console.log(`PASS browser Stop ${width}px in the 3,000-message chat; next tool call HTTP 403`);
}
