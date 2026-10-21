/// <reference lib="dom" />
import './journey-entry.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { APIResponse } from 'playwright';
import { z } from 'zod';
import { loadAuthConfig } from '@opencrane/auth';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { connectEventStore } from '@opencrane/event-store';
import { fileUploadedDataSchema } from '@opencrane/events';
import { envelope, history } from '@opencrane/models';
import { browserSessions } from './browser-signin.ts';
import { authEnv, directory, readEnv } from './config.ts';
import { namespace, secondary, stackId } from './identity.ts';

assert(secondary, 'Screenshot qualification requires a claimed secondary stack');
const run = z.enum(['fresh', 'repeat']).parse(process.argv[2]);
const output = 'docs/process/p3-18-live';
await mkdir(output, { recursive: true });
function hasVisibleDesktopPixels(dialog: Element): boolean {
  const canvas = dialog.querySelector<HTMLCanvasElement>('canvas');
  if (!canvas || canvas.width !== 800 || canvas.height !== 600) return false;
  const bytes = canvas.getContext('2d')!.getImageData(0, 0, 800, 600).data;
  for (let pixelIndex = 0; pixelIndex < bytes.length; pixelIndex++) {
    const value = bytes[pixelIndex];
    if (pixelIndex % 4 !== 3 && value !== bytes[pixelIndex % 4]) return true;
  }
  return false;
}
const settings = await readEnv('settings'), binding = await readEnv('binding');
const silo = settings['SILO_ID']!, origin = settings['ORIGIN']!;
const events = await connectEventStore(await readEnv('command'));
const authz = memberAuthorisation({ silo, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!, authorizationModelId: binding['OPENFGA_MODEL_ID']! });
let browser: Awaited<ReturnType<typeof browserSessions>> | undefined;
const exec = promisify(execFile);
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!await check()) { assert(Date.now() < deadline, 'Screenshot fixture readiness'); await delay(100); }
}
try {
  browser = await browserSessions(loadAuthConfig(await authEnv()), origin);
  const owner = z.object({ memberId: z.string() }).parse(await (await browser.ownerPage.request.get(`${origin}/api/chat`)).json());
  for (const page of browser.memberPages) {
    const width = page.viewportSize()!.width;
    const member = z.object({ memberId: z.string(), assistantId: z.string() }).parse(await (await page.request.get(`${origin}/api/chat`)).json());
    const computer = z.object({ computerId: z.string(), generation: z.number() }).parse((await history(events.store, `computer-${member.assistantId}`, silo)).findLast(row => row.event.type === 'computer.ready')?.event.data);
    let retainedFreshScreenshot = 'NOT RUN';
    const kube = ['--kubeconfig', `${directory}/computer-kubeconfig.json`, '-n', namespace];
    const image = (await exec('kubectl', [...kube, 'get', 'pod', computer.computerId, '-o', 'jsonpath={.status.containerStatuses[?(@.name=="computer")].imageID}'])).stdout;
    // Normal fixtures grant desktop access through events, including to the non-participant.
    const subject = grantStream('shared_desktop', computer.computerId);
    for (const granteeId of [member.memberId, owner.memberId]) {
      const rows = await history(events.store, subject, silo);
      const event = envelope(silo, subject, 'grant.given', { resourceType: 'shared_desktop', resourceId: computer.computerId, granteeId, granteeKind: 'member', grantedBy: owner.memberId });
      event.source = 'dev-stack-screenshot-fixture'; event.principal = { kind: 'system', id: 'dev-only-bootstrap' };
      assert.equal((await events.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 })).status, 'appended');
      await until(async () => (await authz.desktop(granteeId, computer.computerId)).allowed);
    }
    if (run === 'repeat') {
      const receipt = await readFile(`${output}/fresh-${width}.json`, 'utf8').catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (receipt) {
        const previous = z.object({ conversationId: z.string(), file: fileUploadedDataSchema }).parse(JSON.parse(receipt));
        await page.goto(`${origin}/workspace?conversation=${previous.conversationId}`);
        await page.locator('.file-card').filter({ hasText: previous.file.name }).waitFor();
        await page.screenshot({ path: `${output}/retained-${width}.png`, fullPage: true });
        retainedFreshScreenshot = 'PASS';
      } else console.log(`NOT RUN ${width}px fresh-image persistence across startup: fresh capture did not pass`);
    }
    const conversationId = randomUUID();
    const created = await page.request.post(`${origin}/api/conversations`, { headers: { origin }, data: { id: randomUUID(), conversationId, assistantId: member.assistantId } });
    assert.equal(created.status(), 200);
    await until(async () => (await authz.conversation(member.memberId, conversationId, 'read')).allowed);
    await exec('kubectl', [...kube, 'exec', computer.computerId, '-c', 'computer', '--', 'sh', '-c', 'DISPLAY=:1 xmessage -geometry 600x250+80+100 "OpenCrane screenshot qualification" >/dev/null 2>&1 &'], { timeout: 10_000 });
    await page.goto(`${origin}/workspace?conversation=${conversationId}`);
    if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
    await page.getByRole('button', { name: 'Watch your computer', exact: true }).click();
    const viewer = page.getByRole('dialog', { name: 'Computer view', exact: true });
    await viewer.getByText('Viewing', { exact: true }).waitFor();
    const viewerElement = await viewer.elementHandle();
    assert(viewerElement, 'Computer view dialog is present');
    await page.waitForFunction(hasVisibleDesktopPixels, viewerElement);
    const captured = page.waitForResponse(response => new URL(response.url()).pathname === `/api/conversations/${conversationId}/screenshots` && response.request().method() === 'POST');
    const started = performance.now();
    await viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
    const response = await captured;
    assert.equal(response.status(), 201);
    const saved = z.object({ status: z.literal('appended'), fileId: z.string() }).parse(await response.json());
    await viewer.getByText('Screenshot saved', { exact: true }).waitFor();
    const captureMs = Math.round(performance.now() - started);
    await page.screenshot({ path: `${output}/${run}-viewer-${width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    if (width === 390) await page.keyboard.press('Escape');
    const uploads = (await history(events.store, `conversation-${conversationId}`, silo)).filter(row => row.event.type === 'file.uploaded');
    assert.equal(uploads.length, 1, 'One saved screenshot event');
    const file = fileUploadedDataSchema.parse(uploads[0]!.event.data);
    assert.equal(file.fileId, saved.fileId); assert.equal(file.uploadedBy, member.memberId);
    assert.equal(file.screenshot?.computerId, computer.computerId);
    const card = page.locator('.file-card').filter({ hasText: file.name });
    const preview = page.getByRole('dialog', { name: file.name, exact: true });
    for (const state of ['saved', 'reloaded']) {
      if (state === 'reloaded') await page.reload();
      await card.waitFor(); await card.locator('img').evaluate((image: HTMLImageElement) => image.decode());
      await page.screenshot({ path: `${output}/${run}-${state}-conversation-${width}.png`, fullPage: true });
      await card.getByRole('button', { name: `Open preview of ${file.name}`, exact: true }).click();
      await preview.getByText('Preview ready', { exact: true }).waitFor();
      await preview.locator('img').evaluate((image: HTMLImageElement) => image.decode());
      await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
      if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
      const panel = width === 390
        ? page.getByRole('dialog', { name: 'Session', exact: true })
        : page.getByRole('complementary', { name: 'Session panel', exact: true });
      const panelFile = panel.getByRole('button', { name: file.name, exact: false });
      await panelFile.waitFor();
      await panelFile.locator('img').evaluate((image: HTMLImageElement) => image.decode());
      await page.screenshot({ path: `${output}/${run}-${state}-panel-${width}.png`, fullPage: true });
      await panelFile.click();
      await preview.getByText('Preview ready', { exact: true }).waitFor();
      await page.screenshot({ path: `${output}/${run}-${state}-preview-${width}.png`, fullPage: true });
      await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' });
      if (width === 390) await page.keyboard.press('Escape');
    }
    const path = `uploads/${conversationId}/${file.fileId}/${file.name}`;
    const bytes = await page.request.get(`${origin}/api/conversations/${conversationId}/files/view`, { params: { path } });
    assert.equal(bytes.status(), 200); assert.equal(createHash('sha256').update(await bytes.body()).digest('hex'), file.sha256);
    const headers = { origin, 'x-opencrane-view': '1', 'idempotency-key': randomUUID() };
    const refused: APIResponse = await browser.ownerPage.request.post(`${origin}/api/conversations/${conversationId}/screenshots`, { headers });
    const refusedView: APIResponse = await browser.ownerPage.request.post(`${origin}/api/conversations/${conversationId}/view`, { headers });
    const refusedFile: APIResponse = await browser.ownerPage.request.get(`${origin}/api/conversations/${conversationId}/files/view`, { params: { path } });
    assert.equal(refused.status(), 403); assert.equal(refusedView.status(), 403); assert.equal(refusedFile.status(), 403);
    assert.equal((await history(events.store, `conversation-${conversationId}`, silo)).filter(row => row.event.type === 'file.uploaded').length, 1);
    await writeFile(`${output}/${run}-${width}.json`, JSON.stringify({ date: new Date().toISOString(), source: (await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), journeySha256: createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'), run, stackId, namespace, origin, width, image, conversationId, memberId: member.memberId, computer, file, captureMs, participant: 'PASS', conversationAndPanel: 'PASS', reload: 'PASS', retainedFreshScreenshot, nonParticipant: { memberId: owner.memberId, desktopGranted: true, capture: refused.status(), view: refusedView.status(), file: refusedFile.status() }, status: 'PASS' }, null, 2));
    console.log(`PASS ${run} screenshot ${width}px: participant capture (${captureMs} ms), conversation + panel, both previews + reload, matching SHA-256; non-participant with desktop grant refused capture/view/file (403)`);
  }
} catch (error) {
  for (const page of browser?.memberPages ?? []) {
    if (new URL(page.url()).origin === origin) await page.screenshot({ path: `${output}/${run}-failure-${page.viewportSize()!.width}.png`, fullPage: true });
  }
  throw error;
} finally { await events.close(); await browser?.close(); }
