/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { Page, Response, WebSocket as BrowserWebSocket } from 'playwright';
import { grantStream } from '@opencrane/authz';
import { namespace, stackId } from './identity.ts';
import type { EventStore } from '@opencrane/event-store';
import { history } from '@opencrane/models';
import { directory } from './config.ts';
import {
  desktopViewer, openMobileSessionPanel, showDesktopMarker, waitForDesktopPixels,
} from './desktop-journey-ui.ts';

type Desktop = { assistant_id: string; computer_id: string; generation: number };
type Append = (type: string, subject: string, data: Record<string, unknown>) => Promise<void>;
type StateChange = { state: string; at: number };

export interface BrowserViewJourney {
  member: string;
  admin: string;
  silo: string;
  store: EventStore;
  append: Append;
  until: (check: () => Promise<boolean> | boolean, label: string) => Promise<void>;
}

export async function assertNoDesktopGrant(store: EventStore, silo: string, computerId: string) {
  const subject = grantStream('shared_desktop', computerId);
  const grants = await history(store, subject, silo);
  assert.equal(grants.length, 0, 'The computer has no desktop grant events');
}

function browserTime() {
  return performance.now();
}

function watchButton(page: Page) {
  return page.getByRole('button', { name: 'Watch your computer', exact: true });
}

function observeViewStates() {
  const states: StateChange[] = [];
  Object.assign(window, { liveViewStates: states });
  function isViewerTitle(node: Element) {
    return node.textContent?.trim() === 'Computer view';
  }
  function record() {
    const titles = [...document.querySelectorAll('dialog[open] h2')];
    const title = titles.find(isViewerTitle);
    const message = title?.closest('dialog')?.querySelector('[role="status"] .message');
    const state = message?.textContent?.trim();
    if (state && state !== states.at(-1)?.state) {
      states.push({ state, at: performance.now() });
    }
  }
  const observer = new MutationObserver(record);
  const changes = {
    childList: true, characterData: true, subtree: true, attributeFilter: ['open'],
  };
  observer.observe(document.body, changes);
}

function readViewStates() {
  return (window as unknown as { liveViewStates: StateChange[] }).liveViewStates;
}

function admissionFor(conversationId: string) {
  const path = `/api/conversations/${conversationId}/view`;
  return function matches(response: Response) {
    return response.status() === 200 && new URL(response.url()).pathname === path;
  };
}

async function admitViewer(page: Page, conversationId: string) {
  const response = page.waitForResponse(admissionFor(conversationId));
  await watchButton(page).focus();
  await page.keyboard.press('Enter');
  const accepted = await response;
  const admission = await accepted.json() as { sessionId: string };
  const startedAt = await page.evaluate(browserTime);
  return { ...admission, startedAt };
}

function isFocused(node: Element) {
  return node === document.activeElement;
}

function fitsViewport() {
  return document.documentElement.scrollWidth <= innerWidth;
}

function canvasData(node: HTMLCanvasElement) {
  return node.toDataURL();
}

async function checkViewerControls(page: Page) {
  const viewer = desktopViewer(page);
  await viewer.getByRole('button', { name: 'Actual size · zoom' }).focus();
  await page.keyboard.press('Enter');
  await viewer.getByRole('button', { name: 'Fit', exact: true }).focus();
  await page.keyboard.press('Enter');
  const buttons = await viewer.getByRole('button').all();
  for (const button of buttons) {
    const box = await button.boundingBox();
    assert(box && box.height >= 44 && box.width >= 44, 'Viewer target is at least 44px');
  }
  assert(await page.evaluate(fitsViewport), 'Viewer fits the viewport');
  return viewer.locator('canvas').evaluate(canvasData);
}

async function watchFirstChat(page: Page, conversationId: string, receipt: string,
  input: BrowserViewJourney) {
  const width = page.viewportSize()!.width;
  await openMobileSessionPanel(page);
  await page.screenshot({ path: `${receipt}/conversation-entry-${width}.png`, fullPage: true });
  const admitted = await admitViewer(page, conversationId);
  await waitForDesktopPixels(page, desktopViewer(page));
  const pixels = await checkViewerControls(page);
  const { store, silo, member } = input;
  const audit = await history(store, `view-${admitted.sessionId}`, silo);
  const start = audit[0]?.event;
  assert.equal(start?.type, 'computer.view_started');
  assert.deepEqual(start?.principal, { kind: 'human', id: member });
  const details = start?.data as { conversationId: string };
  assert.equal(details.conversationId, conversationId);
  await page.screenshot({ path: `${receipt}/conversation-viewer-${width}.png`, fullPage: true });

  await page.keyboard.press('Escape');
  const stoppedAt = await page.evaluate(browserTime);
  assert(await watchButton(page).evaluate(isFocused), 'Escape restores focus to Watch your computer');
  if (width === 390) {
    await page.keyboard.press('Escape');
  }
  return { ...admitted, stoppedAt, pixels };
}

function twoPaints() {
  return new Promise<void>(function schedule(resolve) {
    function secondPaint() {
      requestAnimationFrame(() => resolve());
    }
    requestAnimationFrame(secondPaint);
  });
}

async function sendInSecondChat(page: Page, firstConversation: string) {
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  const replies = page.getByRole('article', { name: 'Agent reply', exact: true });
  const replyCount = await replies.count();
  await composer.fill('Say hello while I watch your computer.');
  await page.evaluate(twoPaints);
  await composer.press('Enter');
  function openedSecondChat(url: URL) {
    const selected = url.searchParams.get('conversation');
    return Boolean(selected && selected !== firstConversation);
  }
  await page.waitForURL(openedSecondChat);
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  assert(conversationId, 'The second chat has been saved');
  return { conversationId, reply: replies.nth(replyCount) };
}

async function watchSecondChat(page: Page, firstConversation: string, input: BrowserViewJourney) {
  const { conversationId, reply } = await sendInSecondChat(page, firstConversation);
  await openMobileSessionPanel(page);
  function isSecondViewer(socket: BrowserWebSocket) {
    return new URL(socket.url()).pathname === `/ws/conversations/${conversationId}/view`;
  }
  const connected = page.waitForEvent('websocket', { predicate: isSecondViewer });
  const admitted = await admitViewer(page, conversationId);
  const socket = await connected;
  const viewer = desktopViewer(page);
  await viewer.getByText('Viewing', { exact: true }).waitFor({ timeout: 20_000 });
  await reply.getByText('Done', { exact: true }).waitFor();
  assert((await reply.innerText()).includes('Hello from your computer.'),
    'The stand-in assistant completes a turn while the viewer is open');
  await waitForDesktopPixels(page, viewer);
  const records = await history(input.store, `view-${admitted.sessionId}`, input.silo);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.event.type, 'computer.view_started');
  return { ...admitted, conversationId, socket };
}

async function removeWhileViewing(page: Page, origin: string,
  watching: Awaited<ReturnType<typeof watchSecondChat>>, input: BrowserViewJourney) {
  const { admin, member, silo, store, append, until } = input;
  const { conversationId, socket, sessionId } = watching;
  const canvas = desktopViewer(page).locator('canvas');
  const removalDeadlineMs = 2000;
  const socketClosed = socket.waitForEvent('close', { timeout: removalDeadlineMs });
  const pictureCleared = canvas.waitFor({ state: 'detached', timeout: removalDeadlineMs });
  const revokedAt = performance.now();
  const revokedAtTime = new Date().toISOString();
  const removal = { conversationId, participantId: member, removedBy: admin };
  const removed = append('participant.removed', `participation-${conversationId}`, removal);
  await Promise.all([removed, socketClosed, pictureCleared]);
  const revokedMs = Math.round(performance.now() - revokedAt);
  assert(revokedMs < removalDeadlineMs, 'The view closes within two seconds of removal');
  const stoppedAt = await page.evaluate(browserTime);
  assert.equal(await canvas.count(), 0, 'Removal clears the desktop pixels');
  const subject = `view-${sessionId}`;
  async function hasStop() {
    const records = await history(store, subject, silo);
    return records.length === 2;
  }
  await until(hasStop, 'view stop audit');
  const audit = await history(store, subject, silo);
  const stop = audit[1]?.event;
  assert.equal(stop?.type, 'computer.view_stopped');
  const { reason } = stop?.data as { reason: string };
  // The chat page may disappear before the server can send the close reason.
  assert(reason === 'access_changed' || reason === 'disconnected');
  const headers = { origin, 'x-opencrane-view': '1' };
  const refused = await page.request.post(`${origin}/api/conversations/${conversationId}/view`,
    { headers });
  assert.equal(refused.status(), 403, 'A removed participant cannot reopen the viewer');
  return { stoppedAt, revokedAtTime, revokedMs, audit };
}

function pauseMeasurements(transitions: StateChange[], startedAt: number, stoppedAt: number) {
  const pauses: number[] = [];
  let pausedAt: number | undefined;
  for (const transition of transitions) {
    if (transition.at < startedAt || transition.at > stoppedAt) continue;
    if (transition.state === 'Paused' && pausedAt === undefined) {
      pausedAt = transition.at;
    }
    if (transition.state !== 'Paused' && pausedAt !== undefined) {
      pauses.push(Math.round(transition.at - pausedAt));
      pausedAt = undefined;
    }
  }
  if (pausedAt !== undefined) {
    pauses.push(Math.round(stoppedAt - pausedAt));
  }
  return { count: pauses.length, durationMs: pauses };
}

async function closeViewerDialogs(page: Page) {
  if (await desktopViewer(page).isVisible()) {
    await page.keyboard.press('Escape');
  }
  const panel = page.getByRole('dialog', { name: 'Session', exact: true });
  if (page.viewportSize()?.width === 390 && await panel.isVisible()) {
    await page.keyboard.press('Escape');
  }
}

function auditDetails({ event }: Awaited<ReturnType<typeof history>>[number]) {
  return { id: event.id, type: event.type, principal: event.principal, data: event.data };
}

/** Verify the real viewer and assistant reply through the deployed site. */
export async function browserLiveViewJourney(page: Page, origin: string, computer: Desktop,
  input: BrowserViewJourney) {
  const conversationId = new URL(page.url()).searchParams.get('conversation');
  assert(conversationId, 'Viewer starts in a saved conversation');
  await assertNoDesktopGrant(input.store, input.silo, computer.computer_id);
  const width = page.viewportSize()!.width;
  const receipt = `${directory}/live-view`;
  await mkdir(receipt, { recursive: true });
  await page.evaluate(observeViewStates);
  await showDesktopMarker(computer.computer_id);
  const first = await watchFirstChat(page, conversationId, receipt, input);
  const second = await watchSecondChat(page, conversationId, input);
  const ended = await removeWhileViewing(page, origin, second, input);
  await page.screenshot({ path: `${receipt}/conversation-revoked-${width}.png` });

  const transitions = await page.evaluate(readViewStates);
  const firstPauses = pauseMeasurements(transitions, first.startedAt, first.stoppedAt);
  const secondPauses = pauseMeasurements(transitions, second.startedAt, ended.stoppedAt);
  const sessions = [
    { label: 'first view', sessionId: first.sessionId, conversationId, ...firstPauses },
    { label: 'during turn', sessionId: second.sessionId, conversationId: second.conversationId,
      ...secondPauses, revokeToClearMs: ended.revokedMs },
  ];
  const digest = createHash('sha256').update(first.pixels).digest('hex');
  const framebuffer = { width: 800, height: 600, sha256: digest };
  const audit = ended.audit.map(auditDetails);
  const evidence = {
    date: new Date().toISOString(), width, origin, stackId, namespace, conversationId,
    computer, member: input.member, generation: computer.generation, framebuffer,
    revokedAtTime: ended.revokedAtTime, sessions, sessionId: second.sessionId, audit,
    revokedMs: ended.revokedMs, transitions, pauses: secondPauses.count,
    pauseMs: secondPauses.durationMs, noGrant: 'PASS', keyboard: 'PASS',
    targets44px: 'PASS', assistantStubTurn: 'PASS', status: 'PASS',
  };
  const formatted = JSON.stringify(evidence, null, 2);
  await writeFile(`${receipt}/conversation-${width}.json`, formatted);
  await closeViewerDialogs(page);
  console.log(`PASS browser live view ${width}px: desktop, assistant reply and removal in ${ended.revokedMs} ms`);
  return evidence;
}
