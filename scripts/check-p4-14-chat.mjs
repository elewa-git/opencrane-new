import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { chatFixture } from './chat-fixture.mjs';
import { serveWebBuild } from './serve-web-build.mjs';
import { pageHasNoOverflow, waitForFonts } from './visual-helpers.mjs';

const output = resolve('docs/process/p4-14-chat');
const build = resolve('apps/web/dist/web/browser');
const origin = 'https://p4-14-chat.opencrane.test';
const captures = [];
const states = [
  { name: 'recovering', fixture: 'private-team-recovering' },
  { name: 'recovered-lost-output', fixture: 'private-team-recovered' },
  { name: 'memory-free-choice', fixture: 'private-team-draft' },
];

async function serveAssets(route) {
  await serveWebBuild(route, build);
}

async function closeDesktopPanel(page, width) {
  if (width !== 1280) return;
  const panelToggle = page.locator('#panel-toggle');
  const expanded = await panelToggle.getAttribute('aria-expanded');
  if (expanded !== 'true') return;
  await panelToggle.click();
}

async function assertMobileModeChoiceFits(page, stateName, width) {
  if (width !== 320 || stateName === 'recovering') return;
  const memoryChoice = page.locator('oc-chat-composer .mode-choice button').last();
  const sendButton = page.locator('oc-chat-composer .send');
  const memoryBounds = await memoryChoice.boundingBox();
  const sendBounds = await sendButton.boundingBox();
  assert(memoryBounds && sendBounds, 'The memory choice and send button must be visible');
  assert(memoryBounds.x + memoryBounds.width <= sendBounds.x,
    'The memory choice must not overlap the send button at 320px');
}

async function captureState(state, width, motion) {
  const height = width === 1280 ? 900 : width === 390 ? 844 : 720;
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: motion,
  });
  try {
    await page.route(`${origin}/**`, serveAssets);
    const fixture = await chatFixture(page, state.fixture);
    await page.goto(`${origin}/workspace?conversation=chat`);
    await page.locator('oc-chat-composer').waitFor();
    await page.evaluate(waitForFonts);
    await closeDesktopPanel(page, width);
    await assertMobileModeChoiceFits(page, state.name, width);

    if (state.name === 'recovering') {
      await page.getByText('Recovering your authorised context…').waitFor();
      assert.equal(await page.locator('#message').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: 'Attach' }).count(), 0);
    }
    if (state.name === 'recovered-lost-output') {
      await page.getByText('Earlier context unavailable').waitFor();
      assert((await page.locator('.transcript').innerText()).includes(
        "Didn't complete · nothing was repeated"));
      assert(!(await page.locator('.transcript').innerText()).includes('Done'));
      assert.equal(await page.locator('.stop').count(), 0);
    }
    if (state.name === 'memory-free-choice') {
      await page.locator('oc-memory-free-notice .action').waitFor();
      assert.equal(await page.getByRole('button', { name: 'Attach' }).count(), 0);
    }

    assert(await page.evaluate(pageHasNoOverflow), `No horizontal overflow at ${width}px`);
    const filename = `${state.name}-${width}-${motion}.png`;
    await page.screenshot({ path: `${output}/${filename}`, fullPage: true });
    captures.push(filename);

    if (state.name === 'memory-free-choice') {
      const before = fixture.commands.length;
      await page.locator('oc-memory-free-notice .action').click();
      assert.equal(fixture.commands.length, before, 'Choosing memory-free must not send the draft');
      await page.getByText('This turn has no earlier context').waitFor();
    }
  } finally {
    await page.close();
  }
}

const browser = await chromium.launch();
try {
  await mkdir(output, { recursive: true });
  for (const state of states) {
    for (const width of [1280, 390, 320]) {
      for (const motion of ['no-preference', 'reduce']) {
        await captureState(state, width, motion);
      }
    }
  }

  const receipt = {
    result: 'PASS',
    captures,
    widths: [1280, 390, 320],
    motion: ['no-preference', 'reduce'],
    checks: [
      'Recovery disables the composer and hides attachments.',
      'Lost output stays incomplete and never shows Done or Stop.',
      'The memory-free choice leaves the draft unsent.',
      'No horizontal overflow at any captured width.',
    ],
  };
  await writeFile(`${output}/visual.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`PASS P4-14 chat states: ${captures.length} captures`);
} finally {
  await browser.close();
}
