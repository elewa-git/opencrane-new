/// <reference lib="dom" />
import assert from 'node:assert/strict';
import type { Locator, Page } from 'playwright';

export async function captureWaitingApproval(page: Page, output: string, name: string) {
  const originalViewport = page.viewportSize();
  assert(originalViewport);
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate('document.fonts.ready');
      const card = page.getByRole('region', { name: 'Approval needed', exact: true });
      await card.waitFor();
      await showWholeCard(page, card);
      await card.getByRole('button', { name: /^Approve:/u }).waitFor();
      await card.getByRole('button', { name: /^Deny:/u }).waitFor();
      const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
      const options = { path: `${output}/${name}-${width}.png`,
        fullPage: true, mask: [addresses] };
      await page.screenshot(options);
    }
  } finally {
    await page.setViewportSize(originalViewport);
  }
}

async function showWholeCard(page: Page, card: Locator) {
  await card.scrollIntoViewIfNeeded();
  const initial = await card.evaluate(cardVisibility);
  if (initial.extraHeight > 0) {
    const viewport = page.viewportSize()!;
    // Keep the requested width when a tall card needs more room above the composer.
    await page.setViewportSize({ width: viewport.width,
      height: viewport.height + initial.extraHeight + 32 });
    await card.scrollIntoViewIfNeeded();
  }
  await card.evaluate(centreCard);
  const visible = await card.evaluate(cardVisibility);
  assert(visible.whole,
    `The whole waiting approval card must be visible before capture: ${JSON.stringify(visible)}`);
}

function centreCard(card: Element) {
  card.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
}

function cardVisibility(card: Element) {
  const bounds = card.getBoundingClientRect();
  let top = 0;
  let bottom = innerHeight;
  let left = 0;
  let right = innerWidth;
  let parent = card.parentElement;
  while (parent) {
    const style = getComputedStyle(parent);
    const parentBounds = parent.getBoundingClientRect();
    if (style.overflowY !== 'visible') {
      top = Math.max(top, parentBounds.top + parent.clientTop);
      bottom = Math.min(bottom, parentBounds.top + parent.clientTop + parent.clientHeight);
    }
    if (style.overflowX !== 'visible') {
      left = Math.max(left, parentBounds.left + parent.clientLeft);
      right = Math.min(right, parentBounds.left + parent.clientLeft + parent.clientWidth);
    }
    parent = parent.parentElement;
  }
  return {
    whole: bounds.top >= top && bounds.bottom <= bottom &&
      bounds.left >= left && bounds.right <= right,
    extraHeight: Math.max(0, Math.ceil(bounds.height - (bottom - top))),
    bounds: { top: bounds.top, bottom: bounds.bottom, left: bounds.left, right: bounds.right },
    available: { top, bottom, left, right },
  };
}
