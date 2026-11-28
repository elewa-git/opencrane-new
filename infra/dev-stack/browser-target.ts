/// <reference lib="dom" />
import assert from 'node:assert/strict';
import type { Locator } from 'playwright';

export async function assertTouchTarget(control: Locator) {
  await control.click({ trial: true });
  await control.evaluate(waitForOpeningAnimations);
  const box = await control.boundingBox();
  assert(box && box.width >= 44 && box.height >= 44,
    `Touch target is at least 44px; got ${box?.width} × ${box?.height}`);
}

async function waitForOpeningAnimations(control: Element) {
  let element: Element | null = control;
  // Finish parent animations before measuring: Playwright accepts movement smaller than one pixel.
  while (element) {
    for (const animation of element.getAnimations()) {
      const timing = animation.effect?.getTiming();
      if (timing?.iterations !== Infinity) {
        await animation.finished;
      }
    }
    element = element.parentElement;
  }
}
