import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { replyRetainers } from './private-reply-heap.mjs';

const build = resolve('apps/web/dist/private-reply/browser');
const origin = 'https://private-retention.opencrane.test';
const privateText = '```text\nSynthetic private code\n```\n\n'
  + '```mermaid\ngraph LR\nPrivate --> Plan\n```';
const retainForTest = process.argv.includes('--retain-for-test');

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

function observeCancellation() {
  const operations = { started: 0, aborted: 0, copiesStarted: 0, copiesSettled: 0 };
  function cancelled() {
    operations.aborted += 1;
  }
  class ObservedAbortController extends globalThis.AbortController {
    constructor() {
      super();
      operations.started += 1;
      const options = { once: true };
      this.signal.addEventListener('abort', cancelled, options);
    }
  }
  globalThis.AbortController = ObservedAbortController;
  globalThis.replyOperations = operations;
}

function observeCopies() {
  function watchCopy(component, methodName) {
    const original = component[methodName];
    function settled() {
      globalThis.replyOperations.copiesSettled += 1;
    }
    function copy(...argumentsList) {
      globalThis.replyOperations.copiesStarted += 1;
      const pending = original.apply(this, argumentsList);
      void pending.then(settled, settled);
      return pending;
    }
    component[methodName] = copy;
  }
  const markdown = globalThis.document.querySelector('oc-assistant-markdown');
  const diagram = globalThis.document.querySelector('oc-mermaid-diagram');
  watchCopy(globalThis.ng.getComponent(markdown), 'copyCode');
  watchCopy(globalThis.ng.getComponent(diagram), 'copySource');
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
  function weakReference(value, index) {
    const labels = ['Markdown element', 'Markdown component', 'diagram element',
      'diagram component', 'diagram image'];
    value.privateReplyProbe = labels[index];
    return new WeakRef(value);
  }
  globalThis.replyReferences = references.map(weakReference);
}

function copiesCancelled() {
  const operations = globalThis.replyOperations;
  return operations.copiesStarted === 2 && operations.copiesSettled === 2
    && operations.started === 3 && operations.aborted === 3;
}

function nextBrowserTask() {
  function wait(resolveTask) {
    globalThis.setTimeout(resolveTask, 0);
  }
  return new Promise(wait);
}

function retainedReferences() {
  function isRetained(reference) {
    return reference.deref() !== undefined;
  }
  return globalThis.replyReferences.map(isRetained);
}

function retainReplyForTest() {
  const element = globalThis.document.querySelector('oc-assistant-markdown');
  const component = globalThis.ng.getComponent(element);
  function heldClipboardCallback() {
    return component;
  }
  // Keep an intentional leak only in the negative fixture that tests failure diagnostics.
  globalThis.heldClipboardCallback = heldClipboardCallback;
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
    // Let cancellation reactions finish and end the job that last dereferenced a WeakRef.
    for (let pass = 0; pass < 3; pass += 1) {
      await page.evaluate(nextBrowserTask);
      await session.send('HeapProfiler.collectGarbage');
    }
    const retained = await page.evaluate(retainedReferences);
    let diagnostic = '';
    if (retained.includes(true)) {
      diagnostic = await replyRetainers(session);
    }
    for (const present of retained) {
      assert.equal(present, false,
        `Cleared components and nodes are collectible: ${retained}\n${diagnostic}`);
    }
  } finally {
    await session.detach();
  }
}

async function waitForCancellation(page) {
  try {
    await page.waitForFunction(copiesCancelled);
  } catch (error) {
    const session = await page.context().newCDPSession(page);
    try {
      const diagnostic = await replyRetainers(session);
      throw new Error(`Reply operations did not cancel:\n${diagnostic}`, { cause: error });
    } finally {
      await session.detach();
    }
  }
  // Drain render rejection, copy completion and focus callbacks before checking memory.
  await page.evaluate(nextBrowserTask);
}

async function holdDiagramStartup(page) {
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let release;
  function hold(resolveHold) {
    release = resolveHold;
  }
  const pending = new Promise(hold);
  async function holdRenderer(route) {
    started.resolve();
    await pending;
    await serveAssets(route);
    finished.resolve();
  }
  await page.route('**/mermaid-renderer.js', holdRenderer);
  return { release, started: started.promise, finished: finished.promise };
}

async function startCopies(page, pendingDiagram) {
  const attached = { state: 'attached' };
  if (pendingDiagram) {
    await page.locator('.oc-mermaid-renderer').waitFor(attached);
  } else {
    await page.locator('img[alt="Diagram"]').waitFor();
  }
  await page.evaluate(rememberReply);
  // Observe the returned waits without keeping the component in a test callback.
  await page.evaluate(observeCopies);
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

function chatConnected() {
  const element = globalThis.document.querySelector('oc-workspace');
  return element && globalThis.ng.getComponent(element)?.chat.connected();
}

async function clearDuringCopy(browser, pendingDiagram) {
  const page = await browser.newPage();
  let renderer;
  try {
    await page.route('**/*', serveAssets);
    const fixture = await chatFixture(page, 'empty-selected');
    await page.goto(`${origin}/workspace?conversation=chat`);
    // Wait for Angular to open the socket even when compilation or startup is slow.
    await page.waitForFunction(chatConnected);
    await fixture.waitForReadySocket();
    await page.evaluate(holdClipboard);
    await page.evaluate(observeCancellation);
    if (pendingDiagram) {
      renderer = await holdDiagramStartup(page);
    }
    const binding = deliverReply(fixture);
    await startCopies(page, pendingDiagram);
    await renderer?.started;
    if (retainForTest) {
      await page.evaluate(retainReplyForTest);
    }
    const clearance = { ...binding, type: 'private_output_cleared' };
    fixture.sendFrame(clearance);
    const detached = { state: 'detached' };
    await page.locator('oc-assistant-markdown').waitFor(detached);
    await page.locator('.oc-mermaid-renderer').waitFor(detached);
    await waitForCancellation(page);
    await collectReply(page);
    await page.evaluate(finishCopies);
    renderer?.release();
    await renderer?.finished;
    await page.evaluate(nextBrowserTask);
    await page.waitForLoadState('networkidle');
    await assertAbsent(page);
  } finally {
    renderer?.release();
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  if (!retainForTest) {
    await clearDuringCopy(browser, false);
  }
  await clearDuringCopy(browser, true);
  console.log('PASS cleared private copies and diagrams are collectible in Chromium');
} finally {
  await browser.close();
}
