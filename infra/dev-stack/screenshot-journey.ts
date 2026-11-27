/// <reference lib="dom" />
import './journey-entry.ts';
import { requireFleetStandInProvider } from './journey-guard.ts';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { Page, Response, WebSocket } from 'playwright';
import { z } from 'zod';
import { isComputerLifecycle, loadAuthConfig } from '@opencrane/auth';
import { memberAuthorisation } from '@opencrane/authz';
import { connectEventStore, type StoredEvent } from '@opencrane/event-store';
import { fileUploadedDataSchema } from '@opencrane/events';
import { history } from '@opencrane/models';
import { browserSessions } from './browser-signin.ts';
import { assertNoDesktopGrant } from './browser-live-view.ts';
import { readJourneyApi, postJourneyCommand } from './browser-api.ts';
import { prepareBudgetAssistant } from './budget-fixture.ts';
import { createSharedScreenshotChat } from './screenshot-shared-chat.ts';
import {
  desktopViewer, openMobileSessionPanel, showDesktopMarker, waitForDesktopPixels,
} from './desktop-journey-ui.ts';
import { authEnv, directory, readEnv } from './config.ts';
import { namespace, secondary, stackId } from './identity.ts';

assert(secondary, 'Screenshot qualification requires a claimed secondary stack');
const settings = await readEnv('settings');
requireFleetStandInProvider(settings['DEV_REAL_PROVIDER'] === '1');
const run = z.enum(['fresh', 'repeat']).parse(process.argv[2]);
const output = `${directory}/screenshot-journey`;
await mkdir(output, { recursive: true });

const binding = await readEnv('binding');
const silo = settings['SILO_ID']!;
const origin = settings['ORIGIN']!;
const events = await connectEventStore(await readEnv('command'));
const authorisation = memberAuthorisation({
  silo, apiUrl: binding['OPENFGA_API_URL']!, storeId: binding['OPENFGA_STORE_ID']!,
  authorizationModelId: binding['OPENFGA_MODEL_ID']!,
});
const exec = promisify(execFile);
const identity = z.object({ memberId: z.string(), assistantId: z.string() });
const desktop = z.object({ computerId: z.string(), generation: z.number() });
type Computer = z.infer<typeof desktop>;
type File = z.infer<typeof fileUploadedDataSchema>;

interface ScreenshotChat {
  page: Page;
  conversationId: string;
  memberId: string;
  computer: Computer;
  kind: 'personal' | 'shared';
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 120_000;
  while (!await check()) {
    assert(Date.now() < deadline, 'Screenshot fixture readiness');
    await delay(100);
  }
}

async function readIdentity(page: Page) {
  const response = await readJourneyApi(page, `${origin}/api/chat`);
  assert.equal(response.status(), 200);
  return identity.parse(await response.json());
}

function isLifecycle(row: StoredEvent) {
  return isComputerLifecycle(row.event.type);
}

async function waitForComputer(assistantId: string) {
  let computer: Computer | undefined;
  async function isComputerReady() {
    const rows = await history(events.store, `computer-${assistantId}`, silo);
    const ready = rows.findLast(isLifecycle);
    if (ready?.event.type !== 'computer.ready') return false;
    computer = desktop.parse(ready.event.data);
    return true;
  }
  await until(isComputerReady);
  assert(computer);
  return computer;
}

async function startPersonalChat(page: Page, member: z.infer<typeof identity>) {
  const conversationId = randomUUID();
  const data = { id: randomUUID(), conversationId, assistantId: member.assistantId };
  const created = await postJourneyCommand(page, origin, '/api/conversations', data);
  assert.equal(created.status(), 200);
  async function canRead() {
    const response = await readJourneyApi(page, `${origin}/api/conversations/${conversationId}/messages`);
    return response.status() === 200;
  }
  await until(canRead);
  return conversationId;
}

function checkScreenshotResponse(conversationId: string) {
  const path = `/api/conversations/${conversationId}/screenshots`;
  return function matches(response: Response) {
    return response.request().method() === 'POST' && new URL(response.url()).pathname === path;
  };
}

async function watchAndSave(chat: ScreenshotChat, width: number) {
  const { conversationId, page, computer, kind } = chat;
  await showDesktopMarker(computer.computerId);
  await page.goto(`${origin}/workspace?conversation=${conversationId}`);
  await openMobileSessionPanel(page);
  await page.getByRole('button', { name: 'Watch your computer', exact: true }).click();
  const viewer = desktopViewer(page);
  await waitForDesktopPixels(page, viewer);
  const captured = page.waitForResponse(checkScreenshotResponse(conversationId));
  const started = performance.now();
  await viewer.getByRole('button', { name: 'Screenshot', exact: true }).click();
  const response = await captured;
  assert.equal(response.status(), 201, `Save the ${kind} chat screenshot`);
  const saved = z.object({ status: z.literal('appended'), fileId: z.string() })
    .parse(await response.json());
  await viewer.getByText('Screenshot saved', { exact: true }).waitFor();
  const captureMs = Math.round(performance.now() - started);
  await page.screenshot({ path: `${output}/${run}-${kind}-viewer-${width}.png`, fullPage: true });
  await page.keyboard.press('Escape');
  if (width === 390) {
    await page.keyboard.press('Escape');
  }
  return { fileId: saved.fileId, captureMs };
}

function isUpload(row: StoredEvent) {
  return row.event.type === 'file.uploaded';
}

async function savedFile(chat: ScreenshotChat, fileId: string) {
  const rows = await history(events.store, `conversation-${chat.conversationId}`, silo);
  const uploads = rows.filter(isUpload);
  assert.equal(uploads.length, 1, 'One saved screenshot event');
  const file = fileUploadedDataSchema.parse(uploads[0]!.event.data);
  assert.equal(file.fileId, fileId);
  assert.equal(file.uploadedBy, chat.memberId);
  assert.equal(file.screenshot?.computerId, chat.computer.computerId);
  return file;
}

function decodePicture(image: HTMLImageElement) {
  return image.decode();
}

async function openPreview(chat: ScreenshotChat, file: File, width: number) {
  const { page, kind } = chat;
  const card = page.locator('.file-card').filter({ hasText: file.name });
  const preview = page.getByRole('dialog', { name: file.name, exact: true });
  for (const step of ['saved', 'reloaded']) {
    if (step === 'reloaded') {
      await page.reload();
    }
    await card.waitFor();
    await card.locator('img').evaluate(decodePicture);
    await card.getByRole('button', { name: `Open preview of ${file.name}`, exact: true }).click();
    await preview.getByText('Preview ready', { exact: true }).waitFor();
    await preview.locator('img').evaluate(decodePicture);
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden' });
    await openMobileSessionPanel(page);
    const panel = width === 390
      ? page.getByRole('dialog', { name: 'Session', exact: true })
      : page.getByRole('complementary', { name: 'Session panel', exact: true });
    const item = panel.getByRole('button', { name: file.name, exact: false });
    await item.waitFor();
    await item.locator('img').evaluate(decodePicture);
    await item.click();
    await preview.getByText('Preview ready', { exact: true }).waitFor();
    const image = `${output}/${run}-${kind}-${step}-preview-${width}.png`;
    await page.screenshot({ path: image, fullPage: true });
    await page.keyboard.press('Escape');
    await preview.waitFor({ state: 'hidden' });
    if (width === 390) {
      await page.keyboard.press('Escape');
    }
  }
}

function filePath(conversationId: string, file: File) {
  return `uploads/${conversationId}/${file.fileId}/${file.name}`;
}

async function verifyDownloadedFile(chat: ScreenshotChat, file: File) {
  const { conversationId, page } = chat;
  const path = filePath(conversationId, file);
  const url = `${origin}/api/conversations/${conversationId}/files/view`;
  const response = await page.request.get(url, { params: { path } });
  assert.equal(response.status(), 200);
  const bytes = await response.body();
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, file.sha256);
}

async function retainedScreenshot(chat: ScreenshotChat, width: number) {
  if (run !== 'repeat') return 'NOT RUN';
  const filename = `${output}/fresh-${chat.kind}-${width}.json`;
  let contents: string;
  try {
    contents = await readFile(filename, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'NOT RUN';
    }
    throw error;
  }
  const schema = z.object({ conversationId: z.string(), file: fileUploadedDataSchema });
  const saved = schema.parse(JSON.parse(contents));
  const page = chat.page;
  await page.goto(`${origin}/workspace?conversation=${saved.conversationId}`);
  await page.locator('.file-card').filter({ hasText: saved.file.name }).waitFor();
  await page.screenshot({ path: `${output}/retained-${chat.kind}-${width}.png`, fullPage: true });
  return 'PASS';
}

async function checkNonParticipant(page: Page, conversationId: string, path: string, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  let desktopSockets = 0;
  function countSocket(socket: WebSocket) {
    if (new URL(socket.url()).pathname === `/ws/conversations/${conversationId}/view`) {
      desktopSockets++;
    }
  }
  page.on('websocket', countSocket);
  try {
    await page.goto(`${origin}/workspace?conversation=${conversationId}`);
    await page.getByRole('heading', { name: "This conversation isn't available" }).waitFor();
    const watch = page.getByRole('button', { name: 'Watch your computer', exact: true });
    assert.equal(await watch.count(), 0);
    const url = `${origin}/api/conversations/${conversationId}`;
    const headers = { origin, 'x-opencrane-view': '1', 'idempotency-key': randomUUID() };
    const capture = await page.request.post(`${url}/screenshots`, { headers });
    const view = await page.request.post(`${url}/view`, { headers });
    const file = await page.request.get(`${url}/files/view`, { params: { path } });
    assert.equal(capture.status(), 403);
    assert.equal(view.status(), 403);
    assert.equal(file.status(), 403);
    const refusal = z.object({ status: z.literal('refused') }).strict()
      .extend({ attemptId: z.string() });
    refusal.parse(await view.json());
    assert.equal(await desktopViewer(page).locator('canvas').count(), 0);
    assert.equal(desktopSockets, 0, 'The outside member receives no desktop bytes');
    await page.screenshot({ path: `${output}/${run}-refused-${width}.png` });
    return { view: 403, capture: 403, file: 403, desktopSockets };
  } finally {
    page.off('websocket', countSocket);
  }
}

async function qualifyScreenshot(chat: ScreenshotChat, width: number, outsider?: Page) {
  const { conversationId, memberId, computer, kind } = chat;
  const retainedFreshScreenshot = await retainedScreenshot(chat, width);
  const saved = await watchAndSave(chat, width);
  const file = await savedFile(chat, saved.fileId);
  await openPreview(chat, file, width);
  await verifyDownloadedFile(chat, file);
  await assertNoDesktopGrant(events.store, silo, computer.computerId);
  const refusal = outsider
    ? await checkNonParticipant(outsider, conversationId, filePath(conversationId, file), width)
    : undefined;
  const evidence = {
    date: new Date().toISOString(), run, stackId, namespace, width, kind,
    conversationId, memberId, computer, file, captureMs: saved.captureMs,
    conversationAndPanel: 'PASS', reload: 'PASS', retainedFreshScreenshot,
    nonParticipant: refusal, desktopGrantEvents: 0, status: 'PASS',
  };
  const receipt = JSON.stringify(evidence, null, 2);
  await writeFile(`${output}/${run}-${kind}-${width}.json`, receipt);
  console.log(`PASS ${run} ${kind} screenshot at ${width}px in ${saved.captureMs} ms; saved preview reopened after reload`);
}

async function runScreenshots(browser: Awaited<ReturnType<typeof browserSessions>>) {
  const { ownerPage, memberPages } = browser;
  const reader = await readIdentity(ownerPage);
  const member = await readIdentity(memberPages[0]!);
  const personalComputer = await waitForComputer(member.assistantId);
  const shared = await prepareBudgetAssistant(ownerPage, [], origin, member.memberId);
  const sharedComputer = await waitForComputer(shared.assistantId);
  for (const page of memberPages) {
    const width = page.viewportSize()!.width;
    const personalId = await startPersonalChat(page, member);
    const personal: ScreenshotChat = { page, conversationId: personalId, memberId: member.memberId,
      computer: personalComputer, kind: 'personal' };
    await qualifyScreenshot(personal, width, ownerPage);
    const child = { requester: page, reader: ownerPage, origin, assistant: shared,
      requesterId: member.memberId, readerId: reader.memberId, authorisation, until };
    const sharedId = await createSharedScreenshotChat(child);
    const sharedChat: ScreenshotChat = { page: ownerPage, conversationId: sharedId,
      memberId: reader.memberId, computer: sharedComputer, kind: 'shared' };
    await qualifyScreenshot(sharedChat, width);
  }
}

let browser: Awaited<ReturnType<typeof browserSessions>> | undefined;
try {
  browser = await browserSessions(loadAuthConfig(await authEnv()), origin);
  const version = await exec('git', ['rev-parse', 'HEAD']);
  console.log(`Screenshot qualification source ${version.stdout.trim()}`);
  await runScreenshots(browser);
} catch (error) {
  const pages = browser ? [...browser.memberPages, browser.ownerPage] : [];
  for (const [index, page] of pages.entries()) {
    if (new URL(page.url()).origin === origin) {
      await page.screenshot({ path: `${output}/${run}-failure-${index}.png`, fullPage: true });
    }
  }
  throw error;
} finally {
  await events.close();
  await browser?.close();
}
