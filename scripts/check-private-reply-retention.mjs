import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';

const build = resolve('apps/web/dist/private-reply/browser');
const origin = 'https://private-retention.opencrane.test';
const privateText = '```text\nSynthetic private code\n```\n\n'
  + '```mermaid\ngraph LR\nPrivate --> Plan\n```';

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

function holdClipboard() {
  const completions = [];
  function writeText() {
    function hold(resolveCopy, rejectCopy) {
      completions.push({ resolveCopy, rejectCopy });
    }
    return new Promise(hold);
  }
  function finishCopies() {
    completions[0].resolveCopy();
    completions[1].rejectCopy(new Error('Clipboard refused'));
    completions.length = 0;
  }
  const clipboard = { value: { writeText }, configurable: true };
  Object.defineProperty(globalThis.navigator, 'clipboard', clipboard);
  globalThis.finishCopies = finishCopies;
}

function rememberReply() {
  const element = globalThis.document.querySelector('oc-assistant-markdown');
  const diagram = element.querySelector('oc-mermaid-diagram');
  const component = globalThis.ng.getComponent(element);
  const diagramComponent = globalThis.ng.getComponent(diagram);
  const references = [element, component, diagram, diagramComponent];
  const image = diagram.querySelector('img');
  if (image) {
    references.push(image);
  }
  function weakReference(value) {
    return new WeakRef(value);
  }
  globalThis.replyReferences = references.map(weakReference);
}

function retainedReferences() {
  function isRetained(reference) {
    return reference.deref() !== undefined;
  }
  return globalThis.replyReferences.map(isRetained);
}

function deliverReply(fixture) {
  const question = { text: 'Show the plan.', authorId: 'me' };
  const human = fixture.add('message.posted', question);
  const turn = { turnId: human.id, executionMode: 'restricted' };
  fixture.add('agent.turn_started', turn);
  const binding = { version: 1, topic: 'conversation', conversationId: 'chat',
    turnId: human.id, threadId: 'thread', generation: 7, inputGeneration: human.id };
  const reply = { ...binding, type: 'private_reply',
    data: { text: privateText, turnId: human.id } };
  fixture.sendFrame(reply);
  return binding;
}

async function collectReply(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('HeapProfiler.collectGarbage');
    const retained = await page.evaluate(retainedReferences);
    for (const present of retained) {
      assert.equal(present, false, `Cleared components and nodes are collectible: ${retained}`);
    }
  } finally {
    await session.detach();
  }
}

async function holdDiagramStartup(page) {
  let release;
  function hold(resolveHold) {
    release = resolveHold;
  }
  const pending = new Promise(hold);
  async function holdRenderer(route) {
    await pending;
    await serveAssets(route);
  }
  await page.route('**/mermaid-renderer.js', holdRenderer);
  return release;
}

async function startCopies(page, pendingDiagram) {
  const attached = { state: 'attached' };
  if (pendingDiagram) {
    await page.locator('.oc-mermaid-renderer').waitFor(attached);
  } else {
    await page.locator('img[alt="Diagram"]').waitFor();
  }
  await page.evaluate(rememberReply);
  const before = await page.evaluate(retainedReferences);
  assert.deepEqual(before, pendingDiagram ? [true, true, true, true]
    : [true, true, true, true, true]);
  const copyOptions = { name: 'Copy code', exact: true };
  const copies = page.getByRole('button', copyOptions);
  await copies.first().click();
  await copies.last().click();
}

function finishCopies() {
  globalThis.finishCopies();
}

async function assertAbsent(page) {
  assert.equal(await page.locator('oc-assistant-markdown, img[alt="Diagram"]').count(), 0);
  const markup = await page.locator('body').innerHTML();
  assert(!markup.includes('Synthetic private code'));
  await collectReply(page);
}

async function clearDuringCopy(browser, pendingDiagram) {
  const page = await browser.newPage();
  let releaseRenderer;
  try {
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    await page.goto(`${origin}/workspace?conversation=chat`);
    // Finish loading the app before checking the fixture's subscription acknowledgement.
    await page.waitForLoadState('networkidle');
    await fixture.waitForReadySocket();
    await page.evaluate(holdClipboard);
    if (pendingDiagram) {
      releaseRenderer = await holdDiagramStartup(page);
    }
    const binding = deliverReply(fixture);
    await startCopies(page, pendingDiagram);
    const clearance = { ...binding, type: 'private_output_cleared' };
    fixture.sendFrame(clearance);
    const detached = { state: 'detached' };
    await page.locator('oc-assistant-markdown').waitFor(detached);
    await page.locator('.oc-mermaid-renderer').waitFor(detached);
    await collectReply(page);
    await page.evaluate(finishCopies);
    releaseRenderer?.();
    await page.waitForLoadState('networkidle');
    await assertAbsent(page);
  } finally {
    releaseRenderer?.();
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await clearDuringCopy(browser, false);
  await clearDuringCopy(browser, true);
  console.log('PASS cleared private copies and diagrams are collectible in Chromium');
} finally {
  await browser.close();
}
