/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Locator, Page } from 'playwright';
import { directory } from './config.ts';
import { namespace } from './identity.ts';

function hasVisiblePixels(dialog: Element): boolean {
  const canvas = dialog.querySelector<HTMLCanvasElement>('canvas');
  if (!canvas || canvas.width !== 800 || canvas.height !== 600) return false;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const bytes = context.getImageData(0, 0, 800, 600).data;
  for (let pixelIndex = 4; pixelIndex < bytes.length; pixelIndex++) {
    const channel = pixelIndex % 4;
    if (channel !== 3 && bytes[pixelIndex] !== bytes[channel]) return true;
  }
  return false;
}

export async function waitForDesktopPixels(page: Page, viewer: Locator) {
  await viewer.getByText('Viewing', { exact: true }).waitFor({ timeout: 20_000 });
  const element = await viewer.elementHandle();
  assert(element, 'Computer view dialog is present');
  try {
    await page.waitForFunction(hasVisiblePixels, element);
  } finally {
    await element.dispose();
  }
}

export function desktopViewer(page: Page) {
  return page.getByRole('dialog', { name: 'Computer view', exact: true });
}

export async function openMobileSessionPanel(page: Page) {
  if (page.viewportSize()?.width === 390) {
    const control = page.getByRole('button', { name: 'Session panel', exact: true });
    await control.focus();
    await page.keyboard.press('Enter');
  }
}

const exec = promisify(execFile);

export async function showDesktopMarker(computerId: string) {
  const args = ['--kubeconfig', `${directory}/computer-kubeconfig.json`, '-n', namespace,
    'exec', computerId, '-c', 'computer', '--', 'sh', '-c',
    'DISPLAY=:1 xmessage -geometry 600x250+80+100 "OpenCrane desktop check" >/dev/null 2>&1 &'];
  await exec('kubectl', args, { timeout: 10_000 });
}
