import assert from 'node:assert/strict';
import type { Locator, Page, Response } from 'playwright';
import { z } from 'zod';

const postedFieldsSchema = z.record(z.string(), z.unknown());
export const approvedAndUnused = /Approved by you.*not used yet/iu;

export function postedRequestField(response: Response, field: string) {
  const data: unknown = response.request().postDataJSON();
  const parsed = postedFieldsSchema.safeParse(data);
  if (!parsed.success) return undefined;
  return parsed.data[field];
}

type ApprovalScreenshot = 'requested' | 'approved' | 'used' | 'denied' |
  'native-requested' | 'native-used' | 'stop-approved' | 'stopped';

export async function captureApprovalState(page: Page, state: ApprovalScreenshot) {
  const width = page.viewportSize()!.width;
  const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  const screenshot = { path: `docs/process/work-bug-1148-s1/${state}-${width}.png`,
    fullPage: true, mask: [addresses] };
  await page.screenshot(screenshot);
}

export function approvalTerminal(page: Page, approvalId: string, name: string | RegExp) {
  const identity = page.locator(`button[data-approval="${approvalId}"]`);
  return page.getByRole('button', { name }).and(identity);
}

export async function decideJourneyApproval(page: Page, requested: Locator,
  button: 'Approve' | 'Deny', label: RegExp | string) {
  const approvalId = await requested.getAttribute('data-approval');
  assert(approvalId);
  function isDecisionResponse(response: Response) {
    const request = response.request();
    return request.method() === 'POST' && response.url().endsWith('/approvals') &&
      postedRequestField(response, 'approvalId') === approvalId;
  }
  const response = page.waitForResponse(isDecisionResponse);
  const decisionPattern = button === 'Approve' ? /^Approve:/ : /^Deny:/;
  await requested.getByRole('button', { name: decisionPattern }).click();
  assert.equal((await response).status(), 200, 'One decision submission succeeds');
  await approvalTerminal(page, approvalId, label).waitFor();
  return 1;
}
