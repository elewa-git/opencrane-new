import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { chooseMemoryFreeTurn } from '../dev-stack/charged-budget-journey.ts';

const workspace = `
<section aria-label="Conversation messages">
  <button onclick="this.disabled = true">Start a fresh memory-free turn</button>
</section>
<div role="group" aria-label="Turn memory mode">
  <button aria-pressed="false" aria-label="Start a fresh memory-free turn"
    onclick="this.setAttribute('aria-pressed', 'true')">Memory-free</button>
</div>`;

async function choosesComposerMode() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.setContent(workspace);
      await chooseMemoryFreeTurn(page);
      const composer = page.getByRole('group', { name: 'Turn memory mode' });
      assert.equal(await composer.getByRole('button').getAttribute('aria-pressed'), 'true');
      const transcript = page.getByRole('region', { name: 'Conversation messages' });
      assert(await transcript.getByRole('button').isEnabled());
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
test('chooses the composer mode when the transcript offers a button with the same name',
  choosesComposerMode);
