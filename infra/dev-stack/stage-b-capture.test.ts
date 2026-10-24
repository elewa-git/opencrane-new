/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { captureWaitingApproval } from './stage-b-capture.ts';

async function capturesWholePendingCard() {
  const output = await mkdtemp(join(tmpdir(), 'stage-b-capture-'));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 700 } });
    await page.setContent(`
      <style>
        body { margin: 0; }
        main { margin: 80px 10px; height: calc(100vh - 180px); overflow: auto; }
        .earlier { height: 1500px; }
        article { box-sizing: border-box; height: 600px; padding: 16px;
          display: flex; flex-direction: column; background: #eee; }
        article p { flex: 1; }
        @media (max-width: 500px) { article { height: 800px; } }
      </style>
      <main><div class="earlier">Earlier conversation</div>
        <article role="region" aria-label="Approval needed">
          <h2>Change delivery slot</h2><p>Target: DEMO-001. New slot: afternoon.</p>
          <footer><button aria-label="Approve: Change delivery slot">Approve</button>
            <button aria-label="Deny: Change delivery slot">Deny</button></footer>
        </article>
      </main>`);
    const widths: number[] = [];
    const screenshot = page.screenshot.bind(page);
    async function checkedScreenshot(options: Parameters<typeof page.screenshot>[0]) {
      const visible = await page.locator('article').evaluate(checkVisibility);
      assert(visible, 'The card, details and buttons fit inside the scrolled chat');
      widths.push(page.viewportSize()!.width);
      return screenshot(options);
    }
    page.screenshot = checkedScreenshot;
    await captureWaitingApproval(page, output, 'waiting');
    assert.deepEqual(widths, [1280, 390]);
    const files = await readdir(output);
    files.sort();
    assert.deepEqual(files, ['waiting-1280.png', 'waiting-390.png']);
    assert.deepEqual(page.viewportSize(), { width: 800, height: 700 });
  } finally {
    await browser.close();
    await rm(output, { recursive: true, force: true });
  }
}

function checkVisibility(card: Element) {
  const bounds = card.getBoundingClientRect();
  const chat = card.parentElement!;
  const chatBounds = chat.getBoundingClientRect();
  const buttons = card.querySelector('footer')!.getBoundingClientRect();
  return chat.scrollTop > 0 && bounds.top >= chatBounds.top &&
    bounds.bottom <= chatBounds.bottom && bounds.left >= 0 && bounds.right <= innerWidth &&
    buttons.bottom <= chatBounds.bottom && bounds.bottom <= innerHeight;
}

test('scrolls the whole waiting approval into both captures, including a tall phone card',
  capturesWholePendingCard);
