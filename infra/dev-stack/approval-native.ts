import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { approvalTerminal, captureApprovalState, decideJourneyApproval }
  from './approval-cards.ts';

export type NativeApprovalInput = {
  origin: string;
  conversationId: string;
  expectedEffectCount: number;
};

export async function nativeApprovalTurn(page: Page, input: NativeApprovalInput) {
  await page.goto(`${input.origin}/workspace?conversation=${input.conversationId}`);
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  await composer.fill('STAGE_B_WRITE: change DEMO-001 to afternoon delivery.');
  await composer.press('Enter');
  const requested = page.getByRole('region', { name: 'Approval needed', exact: true });
  await requested.waitFor();
  const approvalId = await requested.getAttribute('data-approval');
  assert(approvalId);
  await captureApprovalState(page, 'native-requested');
  await decideJourneyApproval(page, requested, 'Approve', /Approved by you.*used once/);
  await approvalTerminal(page, approvalId, /Approved by you.*used once/).waitFor();
  const answer = new RegExp('Quote DEMO-001:.*afternoon delivery\\. ' +
    `Recorded effects: ${input.expectedEffectCount}\\.`);
  await page.getByText(answer).waitFor();
  const stop = page.locator('oc-chat-composer').getByRole('button',
    { name: 'Stop', exact: true });
  await stop.waitFor({ state: 'hidden' });
  await captureApprovalState(page, 'native-used');
  const width = page.viewportSize()!.width;
  console.log(`PASS native tool approval ${width}px: browser prompt → free stub tool call → ` +
    'browser approval → tool result in the long chat');
}
