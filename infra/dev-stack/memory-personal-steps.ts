import assert from 'node:assert/strict';
import type { Page, Response } from 'playwright';
import { captureMemory, openMemory, recordMemory } from './memory-personal-browser.ts';

const originalText = 'The synthetic garden gate is blue.';
const correctedText = 'The synthetic garden gate is green.';

function memoryWrite(response: Response) {
  return new URL(response.url()).pathname.startsWith('/api/memory/') &&
    response.request().method() === 'POST';
}

async function submitMemory(page: Page, button: string, step: string) {
  const pending = page.waitForResponse(memoryWrite);
  await page.getByRole('button', { name: button, exact: true }).click();
  const response = await pending;
  const body = await response.json() as Record<string, unknown>;
  const input = response.request().postDataJSON() as { commandId: string };
  await recordMemory(step, { status: response.status(), body, commandId: input.commandId });
  assert.equal(response.status(), 200, `${step} must succeed`);
  return body;
}

async function captureDesktop(page: Page, name: string) {
  // Keep the submitted dialog at its original width until its receipt is read.
  const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
  await page.screenshot({ path: `docs/process/memory-fresh-personal/rerun/${name}-1280.png`,
    fullPage: true, animations: 'disabled', mask: [addresses] });
}

export async function exercisePersonalMemory(page: Page, origin: string) {
  await openMemory(page, origin);
  await page.getByRole('button', { name: 'Remember a fact', exact: true }).click();
  await page.getByLabel('Fact', { exact: true }).fill(originalText);
  await captureDesktop(page, 'store-form');
  const saved = await submitMemory(page, 'Store in this scope', 'store');
  assert.equal(saved['outcome'], 'saved');
  await page.getByRole('heading', { name: 'Saved', exact: true }).waitFor();
  await captureDesktop(page, 'saved');
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Search memory', { exact: true }).fill('synthetic garden');
  await page.getByRole('button', { name: new RegExp(originalText, 'u') }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).waitFor();
  await recordMemory('search-and-open', { result: 'PASS' });
  await captureDesktop(page, 'detail');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Fact', { exact: true }).fill(correctedText);
  await captureDesktop(page, 'correction-form');
  const corrected = await submitMemory(page, 'Save correction', 'correct');
  assert.equal(corrected['outcome'], 'accepted');
  assert.equal(corrected['revision'], 2);
  await page.getByText('Corrected in your memory · r2', { exact: true }).waitFor();
  await captureDesktop(page, 'corrected');
  await page.getByRole('button', { name: 'Forget', exact: true }).click();
  await captureDesktop(page, 'forget-form');
  const forgotten = await submitMemory(page, 'Forget from your memory', 'forget');
  assert.equal(forgotten['outcome'], 'accepted');
  assert.equal(forgotten['hidden'], true);
  await captureDesktop(page, 'forgotten');
  await openMemory(page, origin);
  await page.getByLabel('Search memory', { exact: true }).fill('synthetic garden');
  await page.getByText('No matching facts.', { exact: true }).waitFor();
  await recordMemory('reload', { result: 'PASS' });
  await captureMemory(page, 'after-reload');
}
