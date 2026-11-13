/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { assertTouchTarget } from './browser-target.ts';

async function measuresFinishedTarget() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // A nearly finished transform can look stable to Playwright while still reducing the target.
    await page.setContent(`<style>
      @keyframes opening {
        0%, 99% { transform: scale(.999); }
        100% { transform: none; }
      }
      nav { animation: opening 380ms linear paused; transform-origin: top left; }
      button { box-sizing: border-box; width: 100px; height: 44px; }
    </style><nav><button>Upload from computer</button></nav>`);
    const upload = page.getByRole('button', { name: 'Upload from computer', exact: true });
    await upload.evaluate(pauseOpening);
    let settled = false;
    let failure: Error | undefined;
    function finished() {
      settled = true;
    }
    function failed(error: unknown) {
      settled = true;
      failure = new Error('Target measurement failed', { cause: error });
    }
    const checking = assertTouchTarget(upload).then(finished, failed);
    try {
      await upload.click({ trial: true });
      await page.evaluate(nextFrame);
      assert.equal(settled, false, 'A stable but unfinished animation must not count as measured');
    } finally {
      await upload.evaluate(finishOpening);
      await checking;
    }
    if (failure !== undefined) throw failure;
    const box = await upload.boundingBox();
    assert.equal(box?.height, 44, 'Measure the complete target after the menu finishes opening');
    await page.setContent('<button style="width:100px;height:28px">Retry upload</button>');
    const retry = page.getByRole('button', { name: 'Retry upload', exact: true });
    async function measureUndersizedTarget() {
      await assertTouchTarget(retry);
    }
    await assert.rejects(measureUndersizedTarget, /Touch target is at least 44px/u);
  } finally {
    await browser.close();
  }
}

void test('waits for the menu animation and still refuses an undersized control', measuresFinishedTarget);

function pauseOpening(button: Element) {
  const animation = button.parentElement!.getAnimations()[0]!;
  animation.pause();
  animation.currentTime = 350;
}

function nextFrame() {
  return new Promise(requestAnimationFrame);
}

function finishOpening(button: Element) {
  for (const animation of button.parentElement!.getAnimations()) animation.finish();
}
