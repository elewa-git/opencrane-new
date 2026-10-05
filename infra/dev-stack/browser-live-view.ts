/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Page } from 'playwright';
import { grantStream } from '@opencrane/authz';
import { namespace, stackId } from './identity.ts';
import type { EventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';
import { directory } from './config.ts';

type Desktop = { assistant_id: string; computer_id: string; generation: number };
type Append = (type: string, subject: string, data: Record<string, unknown>) => Promise<void>;

/** Real sign-in, conversation, desktop and assistant turn through the generated frontend proxy. */
export async function browserLiveViewJourney(page: Page, origin: string, computer: Desktop, input: {
  member: string; admin: string; silo: string; store: EventStore; append: Append;
  until: (check: () => Promise<boolean> | boolean, label: string) => Promise<void>;
  desktopAllowed: () => Promise<boolean>;
}) {
  const { member, admin, silo, store, append, until } = input;
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  assert(conversationId, 'Viewer starts in the conversation created through the composer');
  const width = page.viewportSize()!.width;
  const grant = { resourceType: 'shared_desktop', resourceId: computer.computer_id, granteeId: member };
  await append('grant.revoked', grantStream('shared_desktop', computer.computer_id), { ...grant, revokedBy: admin });
  await until(async () => !await input.desktopAllowed(), 'desktop grant absent');
  if (width === 390) {
    await page.getByRole('button', { name: 'Session panel', exact: true }).focus(); await page.keyboard.press('Enter');
  }
  const entry = page.getByRole('button', { name: 'Watch your computer', exact: true });
  const viewer = page.getByRole('dialog', { name: 'Computer view', exact: true });
  const open = async () => { await entry.focus(); await page.keyboard.press('Enter'); };
  await open();
  await viewer.getByText('Unavailable', { exact: true }).waitFor();
  assert.equal(await viewer.locator('canvas').count(), 0, 'A participant without a desktop grant receives no pixels');
  await page.keyboard.press('Escape');
  assert(await entry.evaluate(node => node === document.activeElement), 'Escape restores the panel entry');
  await append('grant.given', grantStream('shared_desktop', computer.computer_id), { ...grant, granteeKind: 'member', grantedBy: admin });
  await until(input.desktopAllowed, 'desktop grant projected');

  // A known window makes decoded pixels recognisable; it is fixture activity, not an assistant action.
  await promisify(execFile)('kubectl', ['--kubeconfig', `${directory}/computer-kubeconfig.json`, '-n', namespace,
    'exec', computer.computer_id, '-c', 'computer', '--', 'sh', '-c',
    'DISPLAY=:1 xmessage -geometry 600x250+80+100 "OpenCrane assistant computer — live desktop proof" >/dev/null 2>&1 &'], { timeout: 10_000 });
  const receipt = 'docs/process/live-view'; await mkdir(receipt, { recursive: true });
  await page.screenshot({ path: `${receipt}/conversation-entry-${width}.png`, fullPage: true });
  const started = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/view` && response.status() === 200);
  await open();
  const admitted = await (await started).json() as { sessionId: string };
  await viewer.getByText('Viewing', { exact: true }).waitFor({ timeout: 20_000 });
  const canvas = viewer.locator('canvas');
  await page.waitForFunction(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('dialog[open] canvas');
    if (!canvas || canvas.width !== 800 || canvas.height !== 600) return false;
    const bytes = canvas.getContext('2d')!.getImageData(0, 0, 800, 600).data;
    return bytes.some((value, index) => index % 4 !== 3 && value !== bytes[index % 4]);
  });
  await viewer.getByRole('button', { name: 'Actual size · zoom' }).focus(); await page.keyboard.press('Enter');
  await viewer.getByRole('button', { name: 'Fit', exact: true }).focus(); await page.keyboard.press('Enter');
  for (const button of await viewer.getByRole('button').all()) {
    const box = await button.boundingBox(); assert(box && box.height >= 44 && box.width >= 44, 'Viewer target is at least 44px');
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Viewer fits the viewport');
  const pixels = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  const audit = await history(store, `view-${admitted.sessionId}`, silo);
  assert.equal(audit[0]?.event.type, 'computer.view_started');
  assert.deepEqual(audit[0]?.event.principal, { kind: 'human', id: member });
  assert.equal((audit[0]?.event.data as { conversationId: string }).conversationId, conversationId);
  await page.screenshot({ path: `${receipt}/conversation-viewer-${width}.png`, fullPage: true });

  // Close to reach the composer, then watch the same desktop while the real Codex turn completes.
  await page.keyboard.press('Escape');
  if (width === 390) await page.keyboard.press('Escape');
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  const replies = page.getByRole('article', { name: 'Agent reply', exact: true });
  const before = await replies.count();
  await composer.fill('Say hello while I watch your computer.');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await composer.press('Enter'); await page.locator('.caret').waitFor();
  if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
  const nextAdmission = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/view` && response.status() === 200);
  await open();
  const watching = await (await nextAdmission).json() as { sessionId: string };
  await viewer.getByText('Viewing', { exact: true }).waitFor({ timeout: 20_000 });
  await replies.nth(before).getByText('Done', { exact: true }).waitFor();
  assert((await replies.nth(before).innerText()).includes('Hello from your computer.'), 'Actual assistant completes via stub while viewing');
  assert(await viewer.getByText('Viewing', { exact: true }).isVisible(), 'Viewer stays connected until the desktop grant is revoked');
  const revokedAt = performance.now();
  await append('grant.revoked', grantStream('shared_desktop', computer.computer_id), { ...grant, revokedBy: admin });
  await viewer.getByText('Access changed', { exact: true }).waitFor({ timeout: 2000 });
  const revokedMs = Math.round(performance.now() - revokedAt);
  assert.equal(await viewer.locator('canvas').count(), 0, 'Revocation clears protected pixels');
  await until(async () => (await history(store, `view-${watching.sessionId}`, silo)).length === 2, 'view stop audit');
  const stopped = await history(store, `view-${watching.sessionId}`, silo);
  assert.equal((stopped[1]?.event.data as { reason: string }).reason, 'access_changed');
  await page.screenshot({ path: `${receipt}/conversation-revoked-${width}.png` });
  await writeFile(`${receipt}/conversation-${width}.json`, JSON.stringify({ date: new Date().toISOString(), width, origin, stackId, namespace,
    conversationId, computer, member, generation: computer.generation, framebuffer: { width: 800, height: 600, sha256: createHash('sha256').update(pixels).digest('hex') },
    sessionId: watching.sessionId, audit: stopped.map(({ event }) => ({ id: event.id, type: event.type, principal: event.principal, data: event.data })),
    revokedMs, noGrant: 'PASS', keyboard: 'PASS', targets44px: 'PASS', assistantStubTurn: 'PASS', status: 'PASS' }, null, 2));
  await page.keyboard.press('Escape');
  if (width === 390) await page.keyboard.press('Escape');
  console.log(`PASS browser live view ${width}px: conversation panel → no grant refused → granted real desktop + Codex/stub turn → revoked in ${revokedMs} ms, pixels cleared and stop audited; deployed service account, frontend proxy, keyboard and 44px targets`);
}
