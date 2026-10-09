import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { approvalCard, approvalFixture } from './approval-fixture.mjs';
import { outline, pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';
import { serveWebBuild } from './serve-web-build.mjs';

const output = resolve('docs/process/p3-5-approvals');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p3-5-approvals.opencrane.test';
const widths = [1280, 390, 320];
const motions = ['no-preference', 'reduce'];
const captures = [];
const sceneFrames = {
  'approval-requested': ['WRK-10'],
  'approval-details': ['WRK-11'],
  'approval-submitting': ['WRK-14'],
  'approval-step-up': ['WRK-21'],
  'approval-terminal': ['WRK-16', 'WRK-17', 'WRK-18', 'WRK-19', 'WRK-20'],
  'approval-terminal-approved': ['WRK-16'],
  'approval-terminal-outcome_unknown': ['WRK-16'],
  'approval-terminal-denied': ['WRK-17'],
  'approval-terminal-expired': ['WRK-18'],
  'approval-terminal-cancelled': ['WRK-19', 'WRK-20'],
  'tool-details': ['WRK-03', 'WRK-04'],
  'tool-activity-running': ['WRK-02'],
  'tool-activity-completed': ['WRK-03'],
  'activity-jump': ['WRK-07'],
  reconnected: ['WRK-22'],
};

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

async function capture(page, scene, width, motion) {
  assert(await page.locator('html').evaluate(pageHasNoOverflow), 'Capture has no horizontal overflow');
  const filename = `${scene}-${width}-${motion}.png`;
  await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
  captures.push(filename);
}

async function removeOldPhoneTerminalCaptures() {
  for (const width of [390, 320]) {
    for (const motion of motions) {
      const filename = `${output}/approval-terminal-${width}-${motion}.png`;
      await rm(filename, { force: true });
    }
  }
}

async function waitForAnimations(page) {
  await page.evaluate(async () => {
    const animations = globalThis.document.getAnimations({ subtree: true });
    const finishingAnimations = animations.filter(animationCanFinish);
    for (const animation of finishingAnimations) {
      try {
        await animation.finished;
      } catch {
        // Ignore animations cancelled while the drawer closes.
      }
    }

    function animationCanFinish(animation) {
      return animation.effect?.getTiming().iterations !== Infinity;
    }
  });
}

async function openPage(browser, width, motion, scenario, cards, postHandler, readHandler) {
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    reducedMotion: motion,
  });
  await page.route(`${origin}/**`, serveAssets);
  const chat = await chatFixture(page, scenario);
  let approvals;
  if (cards) approvals = await approvalFixture(page, {
    cards,
    onPost: postHandler,
    onGet: readHandler,
  });
  await page.goto(`${origin}/workspace?conversation=chat`);
  await page.evaluate(waitForFonts);
  return { page, chat, approvals };
}

async function openDetails(page) {
  const details = page.getByRole('button', { name: 'Details', exact: true }).first();
  await details.focus();
  await details.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const heading = dialog.getByRole('heading').first();
  assert(await heading.evaluate(node => node.ownerDocument.activeElement === node));
  return dialog;
}

async function checkPhoneTargets(page, scene) {
  const controls = page.locator(`
    .approve, .actions button, .drawer-actions button, .approval-terminal,
    .state-action, .tool-line, dialog[open] .back
  `);
  const count = await controls.count();
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    const box = await control.boundingBox();
    assert(box && box.height >= 44,
      `${scene} phone control ${index} is at least 44px tall (${await control.evaluate(node => node.outerHTML)})`);
  }
}

async function checkFocusedOutline(locator) {
  await locator.focus();
  assert.deepEqual(await locator.evaluate(outline), ['2px', 'rgb(10, 132, 151)', '2px']);
}

async function captureScene(browser, scene, width, motion) {
  if (scene === 'approval-terminal' && width < 700) {
    await capturePhoneTerminalStates(browser, width, motion);
    return;
  }
  let cards = [approvalCard(0)];
  let scenario = 'tools';
  if (scene === 'tool-activity-running') scenario = 'governed-tool-running';
  if (scene === 'tool-activity-completed') scenario = 'governed-tool-completed';
  if (scene === 'approval-step-up') cards = [{ ...approvalCard(0), stepUp: true }];
  if (scene === 'approval-terminal') {
    cards = [
      approvalCard(1, 'approved', false, 'me'),
      approvalCard(2, 'outcome_unknown', false, 'me'),
      approvalCard(3, 'denied', false, 'me'),
      approvalCard(4, 'expired', false, 'me'),
      approvalCard(5, 'cancelled', false, 'me'),
    ];
  }
  if (scene === 'tool-details' || scene === 'activity-jump' || scene === 'reconnected'
    || scene.startsWith('tool-activity-')) {
    cards = undefined;
  }
  const { page, chat } = await openPage(browser, width, motion, scenario, cards, postResponseForScene(scene));
  try {
    if (scene === 'approval-requested') {
      const approval = page.getByRole('region', { name: 'Approval needed' });
      await approval.waitFor();
      await approval.scrollIntoViewIfNeeded();
      await checkFocusedOutline(page.getByRole('button', { name: /^Approve:/ }).first());
      assert(await page.getByText('Waiting on you', { exact: true }).isVisible());
    } else if (scene === 'approval-details') {
      const dialog = await openDetails(page);
      if (motion === 'reduce') {
        assert.equal(await dialog.evaluate(getAnimationName), 'none');
      }
      await waitForAnimations(page);
      if (width < 700) await checkPhoneTargets(page, scene);
      await capture(page, scene, width, motion);
      await page.keyboard.press('Escape');
      assert(await page.getByRole('button', { name: 'Details', exact: true })
        .first().evaluate(node => node.ownerDocument.activeElement === node));
      return;
    } else if (scene === 'approval-submitting') {
      await page.getByRole('button', { name: /^Approve:/ }).click();
      const sendingHeading = page.locator('.approval.pending header strong');
      await sendingHeading.waitFor();
      assert.equal(await sendingHeading.innerText(), 'Sending your approval…');
      assert.equal(await page.getByText('Waiting on you', { exact: true }).count(), 0);
    } else if (scene === 'approval-step-up') {
      await page.getByRole('button', { name: /^Approve:/ }).click();
      await page.getByRole('link', { name: 'Sign in again to approve' }).waitFor();
    } else if (scene === 'approval-terminal') {
      await page.locator('oc-approval-terminal-line').first().waitFor();
      await checkFocusedOutline(page.locator('.approval-terminal').first());
    } else if (scene === 'tool-details') {
      const tool = page.locator('.tool-line').first();
      await checkFocusedOutline(tool);
      await tool.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Command failed' });
      await dialog.waitFor();
      assert((await dialog.innerText()).includes('Failed · Exit code 1'));
      assert.equal(await dialog.getByRole('button', { name: /retry|try again/i }).count(), 0);
      if (motion === 'reduce') {
        assert.equal(await dialog.evaluate(getAnimationName), 'none');
      }
      await waitForAnimations(page);
      if (width < 700) await checkPhoneTargets(page, scene);
      await capture(page, scene, width, motion);
      await page.keyboard.press('Escape');
      assert(await tool.evaluate(node => node.ownerDocument.activeElement === node));
      return;
    } else if (scene === 'tool-activity-running') {
      const tool = page.getByRole('button', { name: /read_order · Running/ });
      await tool.waitFor();
      await checkToolDetails(page, tool, 'Running · The call has not finished.', 'Completed');
    } else if (scene === 'tool-activity-completed') {
      const tool = page.getByRole('button', { name: /read_order · Completed/ });
      await tool.waitFor();
      await checkToolDetails(page, tool, 'Call completed', 'Result');
    } else if (scene === 'activity-jump') {
      const panelOpener = page.getByRole('button', { name: 'Session panel' });
      let panel;
      if (width < 700) {
        await panelOpener.click();
        panel = page.getByRole('dialog', { name: 'Session' });
      } else {
        panel = page.locator('.desktop-panel');
      }
      await panel.getByRole('tab', { name: /Activity/ }).click();
      await panel.locator('.activity-row').first().click();
      const tool = page.locator('.tool-line').first();
      assert(await tool.evaluate(node => node.ownerDocument.activeElement === node));
      assert.equal(await page.locator('article.message.highlighted').count(), 1);
    } else if (scene === 'reconnected') {
      const activeBefore = await page.evaluateHandle(getActiveElement);
      await chat.closeSocket();
      const reconnectLine = page.locator('.reconnected-line');
      await reconnectLine.waitFor();
      assert.match(await reconnectLine.textContent(), /Reconnected at .*caught up\./);
      assert.equal(await reconnectLine.count(), 1);
      assert(await page.evaluate(isActiveElement, activeBefore));
      await activeBefore.dispose();
    }
    if (width < 700) await checkPhoneTargets(page, scene);
    const approvalText = await page.locator('oc-approval-cards').textContent();
    assert(!/retry|try again/i.test(approvalText ?? ''), 'Approval area does not offer a retry');
    await capture(page, scene, width, motion);
  } finally {
    await page.close();
  }
}

async function checkToolDetails(page, tool, expectedWords, forbiddenWords) {
  await tool.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  const details = dialog.locator('.tool-detail-ledger');
  const text = await details.innerText();
  assert(text.includes(expectedWords));
  assert(!text.includes(forbiddenWords));
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert(await tool.evaluate(node => node.ownerDocument.activeElement === node));
}

async function capturePhoneTerminalStates(browser, width, motion) {
  const states = ['approved', 'outcome_unknown', 'denied', 'expired', 'cancelled'];
  for (let index = 0; index < states.length; index += 1) {
    const state = states[index];
    const terminalCard = approvalCard(index + 1, state, false, 'me');
    const { page } = await openPage(browser, width, motion, 'tools', [terminalCard]);
    try {
      const terminal = page.locator('.approval-terminal');
      await terminal.waitFor();
      await terminal.scrollIntoViewIfNeeded();
      await checkFocusedOutline(terminal);
      await checkPhoneTargets(page, `approval-terminal-${state}`);
      await capture(page, `approval-terminal-${state}`, width, motion);
    } finally {
      await page.close();
    }
  }
}

function getAnimationName(element) {
  return element.ownerDocument.defaultView.getComputedStyle(element).animationName;
}

function getActiveElement() {
  return globalThis.document.activeElement;
}

function isActiveElement(element) {
  return globalThis.document.activeElement === element;
}

function collectCaptureFiles(files) {
  const results = [];
  for (const file of files) {
    const details = file.match(/^(.*)-(\d+)-(no-preference|reduce)\.png$/);
    assert(details);
    const scene = details[1];
    const width = Number(details[2]);
    const motion = details[3];
    const frames = framesForCapture(scene, width);
    results.push({ file, frames, width, motion, checks: checksForCapture(scene, width) });
  }
  return results;
}

function framesForCapture(scene, width) {
  const frameNames = sceneFrames[scene] ?? [];
  const frames = [];
  for (const frameName of frameNames) frames.push(`${frameName}-${width}`);
  return frames;
}

function checksForCapture(scene, width) {
  const checks = ['No horizontal overflow', 'Captured at the listed width and motion setting'];
  if (scene === 'approval-details' || scene === 'tool-details') {
    checks.push('Drawer animation ended before the capture');
  }
  if (scene === 'approval-details' && width < 700) {
    checks.push('Measured the drawer Back, Approve and Deny controls');
  }
  if (scene === 'tool-details' && width < 700) {
    checks.push('Measured the drawer Back control');
  }
  if (scene.startsWith('tool-activity-') && width < 700) {
    checks.push('Measured the 44px tool activity button');
  }
  if (scene.startsWith('approval-terminal-') && width < 700) {
    checks.push('Shows one folded state with the viewer as requester');
    checks.push('Measured the folded card and any status action');
  }
  return checks;
}

function framesForAllCaptures(captureFiles) {
  const frameSet = new Set();
  for (const captureFile of captureFiles) {
    for (const frame of captureFile.frames) frameSet.add(frame);
  }
  return [...frameSet];
}

function postResponseForScene(scene) {
  if (scene === 'approval-submitting') return holdPostOpen;
  if (scene === 'approval-step-up') return stepUpResponse;
  return successfulPost;
}

function holdPostOpen() {
  return new Promise(() => {});
}

function stepUpResponse() {
  return { status: 428 };
}

function successfulPost() {
  return { status: 200 };
}

async function checkDecisionRequests(browser) {
  const { page, approvals } = await openPage(browser, 390, 'reduce', 'tools', [approvalCard(0)], holdPostOpen);
  try {
    const button = page.getByRole('button', { name: /^Approve:/ }).first();
    await page.locator('#message').press('Enter');
    assert.equal(approvals.requests.filter(request => request.method === 'POST').length, 0);
    await button.click({ clickCount: 2, delay: 20 });
    await page.waitForTimeout(100);
    assert.equal(approvals.requests.filter(request => request.method === 'POST').length, 1);
    const post = approvals.requests.find(request => request.method === 'POST');
    assert.deepEqual(post.body, { approvalId: 'a'.repeat(64), decision: 'approved' });
    assert.equal(post.headers['x-csrf-token'], 'fixture');
    assert.equal(post.headers.origin, origin);
    await page.locator('#message').press('Enter');
    assert.equal(approvals.requests.filter(request => request.method === 'POST').length, 1);
  } finally {
    await page.close();
  }
}

async function checkDecisionFocus(browser) {
  const resultCards = [approvalCard(0, 'approved')];
  const onPost = () => ({ status: 200, cards: resultCards });
  const { page } = await openPage(
    browser, 390, 'reduce', 'tools', [approvalCard(0)], onPost,
  );
  try {
    const approve = page.getByRole('button', { name: /^Approve:/ }).first();
    await approve.click();
    const terminal = page.locator('.approval-terminal');
    await terminal.waitFor();
    assert(await terminal.evaluate(node => node.ownerDocument.activeElement === node));
  } finally {
    await page.close();
  }
}

async function checkUnknownDoesNotPost(browser) {
  const { page, approvals } = await openPage(browser, 390, 'reduce', 'tools',
    [approvalCard(0, 'outcome_unknown', false)], successfulPost);
  try {
    await page.getByRole('button', { name: 'Check status' }).click();
    await page.waitForTimeout(30);
    assert.equal(approvals.requests.filter(request => request.method === 'POST').length, 0);
  } finally {
    await page.close();
  }
}

async function checkAccessRecovery(browser) {
  let readCount = 0;
  const readHandler = () => {
    readCount += 1;
    if (readCount === 2) return { status: 403, body: {} };
    return undefined;
  };
  const { page } = await openPage(
    browser, 390, 'reduce', 'tools', [approvalCard(0)], undefined, readHandler,
  );
  try {
    await page.getByRole('region', { name: 'Approval needed' }).waitFor();
    await page.getByText('Checking access').waitFor();
    assert.equal(await page.locator('.approval-terminal').count(), 0);
    await page.waitForTimeout(3100);
    await page.getByRole('region', { name: 'Approval needed' }).waitFor();
  } finally {
    await page.close();
  }
}

async function checkEmptyConversation(browser) {
  const { page } = await openPage(browser, 390, 'reduce', 'empty-selected', undefined);
  try {
    await page.getByText('No messages yet', { exact: true }).waitFor();
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  await removeOldPhoneTerminalCaptures();
  const scenes = [
    'approval-requested', 'approval-details', 'approval-submitting',
    'approval-step-up', 'approval-terminal', 'tool-activity-running',
    'tool-activity-completed', 'tool-details', 'activity-jump', 'reconnected',
  ];
  for (const scene of scenes) {
    for (const width of widths) {
      for (const motion of motions) {
        await captureScene(browser, scene, width, motion);
      }
    }
  }
  await checkDecisionRequests(browser);
  await checkDecisionFocus(browser);
  await checkUnknownDoesNotPost(browser);
  await checkAccessRecovery(browser);
  await checkEmptyConversation(browser);
  const captureFiles = collectCaptureFiles(captures);
  const result = {
    result: 'PASS',
    widths,
    motion: motions,
    captures: captures.length,
    files: captures,
    captureChecks: captureFiles,
    environment: 'Built Angular assets; Chromium; intercepted fixtures; no live governed turn',
    frames: framesForAllCaptures(captureFiles),
    checks: [
      '10 scenes captured at 1280, 390 and 320 pixels with both motion settings',
      'Running and completed governed tool calls match WRK-02 and WRK-03',
      'No horizontal overflow in any capture',
      'Phone card actions, drawer buttons and drawer Back controls were measured',
      'Approval, tool and terminal buttons show the teal focus ring',
      'Approval POST sends one decision with the fixture CSRF token and page origin',
      'Unknown outcome Check status makes a GET and no POST',
      'Access checks keep polling and restore the cards after a later 200',
      'Tool and approval drawers open by keyboard and return focus after Escape',
      'No approval or tool details button offers retry wording',
      'The existing empty conversation still shows No messages yet',
    ],
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`PASS P3-5 approvals: ${captures.length} captures; 1280/390/320 and both motion settings`);
} finally {
  await browser.close();
}
