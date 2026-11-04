import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';

const build = resolve('apps/web/dist/web/browser');
const origin = 'https://mermaid.opencrane.test';
const exec = promisify(execFile);
if (!process.argv.includes('--skip-build')) {
  const buildOptions = { timeout: 180_000, env: { ...process.env, NO_COLOR: '1' } };
  await exec('nice', ['-n', '10', 'npm', 'run', 'build', '-w', 'apps/web'], buildOptions);
}
const browser = await chromium.launch();
const page = await browser.newPage();
const requests = [];
const scripts = [];
async function serveAssets(route) {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== origin || url.pathname.startsWith('/probe')) {
    requests.push(request.url());
    await route.abort();
    return;
  }
  if (url.pathname === '/workspace') {
    const nonce = randomBytes(18).toString('base64');
    const index = await readFile(resolve(build, 'index.html'), 'utf8');
    const body = index.replace('<app-root', `<app-root ngCspNonce="${nonce}"`);
    const policy = "default-src 'self'; script-src 'self'; "
      + `style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; `
      + "connect-src 'self'; object-src 'none'; base-uri 'self'";
    const response = { body, contentType: 'text/html',
      headers: { 'content-security-policy': policy } };
    await route.fulfill(response);
    return;
  }
  if (url.pathname.endsWith('.js')) {
    const source = await readFile(resolve(build, '.' + url.pathname), 'utf8');
    scripts.push(source);
  }
  await serveWebBuild(route, build);
}
function containsMermaid(source) {
  return source.includes('Maximum text size in diagram exceeded')
    && source.includes('mermaidAPI');
}
function observeInitialisation() {
  let library;
  globalThis.mermaidInitialisations = 0;
  function setMermaid(value) {
    library = value;
    const initialise = library.initialize.bind(library);
    function initialiseOnce(config) {
      globalThis.mermaidInitialisations += 1;
      return initialise(config);
    }
    library.initialize = initialiseOnce;
  }
  function getMermaid() {
    return library;
  }
  const descriptor = { configurable: true, get: getMermaid, set: setMermaid };
  Object.defineProperty(globalThis, 'mermaid', descriptor);
}
function readSettings() {
  return {
    config: globalThis.mermaid.mermaidAPI.getSiteConfig(),
    initialisations: globalThis.mermaidInitialisations,
  };
}
async function drawBlockedImage(source) {
  try {
    await globalThis.mermaid.render('network-probe', source);
    return 'rendered';
  } catch {
    return 'blocked';
  }
}

async function rendersTextWarning(source) {
  const originalRender = globalThis.mermaid.render;
  const result = await originalRender('text-limit-probe', source);
  function returnWarning() {
    globalThis.mermaid.render = originalRender;
    return Promise.resolve(result);
  }
  globalThis.mermaid.render = returnWarning;
  const text = result.svg.replace(/<[^>]*>/g, '');
  const joinedText = text.replace(/\s/g, '');
  return joinedText.includes('Maximumtextsizeindiagramexceeded');
}

function canReadParent() {
  try {
    return Boolean(globalThis.parent.document.body);
  } catch {
    return false;
  }
}

async function probeNetwork() {
  const violations = [];
  function recordViolation(event) {
    violations.push(event.effectiveDirective);
  }
  globalThis.document.addEventListener('securitypolicyviolation', recordViolation);
  const image = new globalThis.Image();
  image.src = 'https://attacker.invalid/image';
  const localImage = new globalThis.Image();
  localImage.src = '/probe-image';
  const script = globalThis.document.createElement('script');
  script.src = 'https://attacker.invalid/script.js';
  globalThis.document.body.append(script);
  const localScript = globalThis.document.createElement('script');
  localScript.src = '/probe-script.js';
  globalThis.document.body.append(localScript);
  const style = globalThis.document.createElement('link');
  style.rel = 'stylesheet';
  style.href = 'https://attacker.invalid/style.css';
  globalThis.document.head.append(style);
  try {
    await fetch('https://attacker.invalid/fetch');
  } catch {
    // Expect the browser to refuse this request before it reaches the network.
  }
  function allowViolationEvents(resolve) {
    setTimeout(resolve, 100);
  }
  await new Promise(allowViolationEvents);
  return violations;
}
try {
  await page.addInitScript(observeInitialisation);
  await page.route('**/*', serveAssets);
  const fixture = await chatFixture(page, 'empty-selected');
  const questionPayload = { text: 'Draw a route', authorId: 'me' };
  const question = fixture.add('message.posted', questionPayload);
  const turn = { turnId: question.id };
  fixture.add('agent.turn_started', turn);
  const firstDelta = { ...turn, messageId: 'reply', text: 'Ordinary reply' };
  fixture.add('agent.message_delta', firstDelta);
  await page.goto(origin + '/workspace?conversation=chat');
  const reply = page.locator('oc-assistant-markdown');
  const textOptions = { exact: true };
  const ordinaryReply = reply.getByText('Ordinary reply', textOptions);
  await ordinaryReply.waitFor();
  await page.waitForLoadState('networkidle');
  assert.equal(scripts.some(containsMermaid), false, 'Ordinary replies must not load Mermaid');

  const source = 'flowchart LR\n'
    + 'A@{ img: "https://attacker.invalid/probe", label: "Picture", h: 60 }';
  const maliciousDelta = { ...turn, messageId: 'reply', text: '\n\n```mermaid\n' + source + '\n```' };
  fixture.add('agent.message_delta', maliciousDelta);
  await page.waitForLoadState('networkidle');
  const sentinel = { ...turn, messageId: 'reply', text: '\n\n```mermaid\ngraph LR\nSafe --> Done\n```' };
  fixture.add('agent.message_delta', sentinel);
  const diagramOptions = { name: 'Diagram' };
  const diagrams = reply.getByRole('img', diagramOptions);
  const firstDiagram = diagrams.last();
  await firstDiagram.waitFor();
  await page.waitForLoadState('networkidle');
  const renderedImage = diagrams.last();
  const imageSource = await renderedImage.getAttribute('src');
  const svg = Buffer.from(imageSource.split(',')[1], 'base64').toString('utf8');
  const viewBox = /viewBox="([^"]+)"/.exec(svg);
  assert(viewBox, 'The rendered image needs a measured view box');
  const dimensions = viewBox[1].split(' ');
  assert(Number(dimensions[2]) >= 100 && Number(dimensions[3]) >= 40,
    'Measure both nodes and their labels: ' + viewBox[1]);
  assert.deepEqual(requests, [], 'Rendering a reply must not send any attacker request');
  assert.equal(scripts.some(containsMermaid), true, 'A closed diagram must load the real renderer');
  const iframe = page.locator('iframe[title="Diagram renderer"]');
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  const renderer = page.frames().find(isRenderer);
  assert(renderer, 'Render inside a separate document');
  function isRenderer(frame) {
    return frame.url().endsWith('/mermaid-renderer.html');
  }
  const { config, initialisations } = await renderer.evaluate(readSettings);
  assert.equal(initialisations, 1);
  assert.equal(config.securityLevel, 'strict');
  assert.equal(config.htmlLabels, false);
  assert.equal(config.startOnLoad, false);
  assert.equal(config.suppressErrorRendering, true);
  assert.equal(config.logLevel, 'fatal');
  assert.equal(config.maxTextSize, 50000);
  assert.equal(config.maxEdges, 500);
  const secureKeys = ['secure', 'securityLevel', 'startOnLoad', 'logLevel', 'maxTextSize',
    'suppressErrorRendering', 'maxEdges', 'htmlLabels'];
  for (const key of secureKeys) {
    assert(config.secure.includes(key), 'Protect configuration key: ' + key);
  }
  assert.equal(await renderer.evaluate(canReadParent), false);
  assert.equal(await renderer.evaluate(drawBlockedImage, source), 'blocked');
  const violations = await renderer.evaluate(probeNetwork);
  for (const directive of ['img-src', 'script-src-elem', 'style-src-elem', 'connect-src']) {
    assert(violations.includes(directive), 'CSP must block ' + directive);
  }
  assert.deepEqual(requests, [], 'The rendering document must have no network access');

  const override = '%%{init: {"secure": [], "securityLevel": "loose", "htmlLabels": true,'
    + ' "startOnLoad": true, "logLevel": "debug", "suppressErrorRendering": false,'
    + ' "maxTextSize": 100000, "maxEdges": 1000}}%%\n';
  let edges = 'graph LR\n';
  for (let index = 0; index < 510; index++) {
    edges += `A${index} --> A${index + 1}\n`;
  }
  const oversized = 'graph LR\nA["' + 'x'.repeat(51000) + '"]';
  assert.equal(await renderer.evaluate(rendersTextWarning, override + oversized), true);
  const warningSource = 'graph LR\nWarning --> Reply';
  const sources = [warningSource, override + edges, oversized, override + 'this is not a diagram'];
  for (const code of sources) {
    const delta = { ...turn, messageId: 'reply', text: '\n\n```mermaid\n' + code + '\n```' };
    fixture.add('agent.message_delta', delta);
  }
  const finalDelta = { ...turn, messageId: 'reply',
    text: '\n\n```mermaid\n' + override + 'graph LR\nFinal --> Done\n```' };
  fixture.add('agent.message_delta', finalDelta);
  const blocks = reply.locator('oc-mermaid-diagram');
  const finalBlock = blocks.nth(sources.length + 2);
  const finalImage = finalBlock.getByRole('img');
  await finalImage.waitFor();
  for (let index = 0; index < sources.length; index++) {
    const block = blocks.nth(index + 2);
    assert.equal(await block.locator('pre code').textContent(), sources[index]);
    const buttonOptions = { name: 'Copy code' };
    const copyButton = block.getByRole('button', buttonOptions);
    assert.equal(await copyButton.count(), 1);
    assert.equal(await block.locator('img').count(), 0);
  }
  const expectedSettings = { config, initialisations: 1 };
  assert.deepEqual(await renderer.evaluate(readSettings), expectedSettings);
  assert.equal(await iframe.count(), 1);
  assert.equal(await renderer.locator('.error-icon, .error-text').count(), 0);
  assert.deepEqual(requests, []);
  console.log('PASS Mermaid Chromium: isolation, lazy loading, settings and limits');
} finally {
  await browser.close();
}
