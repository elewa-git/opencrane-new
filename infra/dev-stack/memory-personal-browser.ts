import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import type { Page, Response } from 'playwright';

export const memoryOutput = 'docs/process/memory-fresh-personal/fixed-rerun';
export async function recordMemory(name: string, value: unknown) {
  const record = JSON.stringify({ name, value, at: new Date().toISOString() });
  await appendFile(`${memoryOutput}/observations.jsonl`, record + '\n', { mode: 0o600 });
}

export async function captureMemory(page: Page, name: string) {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate('document.fonts.ready');
    const tab = page.getByRole('tab', { name: 'Memory', exact: true });
    const panel = page.getByRole('button', { name: 'Session panel', exact: true });
    if (width === 390 && await panel.count() && !await tab.isVisible()) {
      await panel.click();
    }
    const addresses = page.getByText(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    const privateFields = page.locator('input[type=password], input[type=email]');
    const bootstrap = page.getByLabel('Bootstrap token', { exact: true });
    await page.screenshot({ path: `${memoryOutput}/${name}-${width}.png`,
      fullPage: true, animations: 'disabled', mask: [addresses, privateFields, bootstrap] });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function openMemory(page: Page, origin: string) {
  function scopesReply(response: import('playwright').Response) {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === '/api/memory/scopes';
  }
  await page.goto(`${origin}/workspace`);
  const pending = page.waitForResponse(scopesReply);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  const response = await pending;
  const body = await recordScopesResponse(response);
  const applying = response.status() === 503 && permissionsApplying(body);
  assert(response.status() === 200 || applying, 'The first memory scopes read must be usable');
  await page.getByRole('button', { name: 'Your memory', exact: true })
    .waitFor({ timeout: 35_000 });
  await page.getByRole('button', { name: 'Your memory', exact: true }).click();
  await page.getByRole('button', { name: 'Remember a fact', exact: true }).waitFor();
}

export async function recordScopesResponse(response: Pick<Response, 'status' | 'json'>,
  record = recordMemory): Promise<unknown> {
  // Keep the HTTP result even if Playwright never finishes reading its body.
  await record('scopes', { status: response.status() });
  let timer: ReturnType<typeof setTimeout> | undefined;
  function expire(_resolve: (value: never) => void, reject: (error: Error) => void) {
    function timedOut() {
      reject(new Error('Memory scopes response body timed out'));
    }
    timer = setTimeout(timedOut, 10_000);
  }
  const timeout = new Promise<never>(expire);
  try {
    const body: unknown = await Promise.race([response.json(), timeout]);
    await record('scopes_body', { status: 'read', body });
    return body;
  } catch (error) {
    await record('scopes_body', { status: 'unavailable' });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function permissionsApplying(body: unknown): boolean {
  return typeof body === 'object' && body !== null && 'status' in body &&
    body.status === 'unavailable' && 'reason' in body && body.reason === 'permissions_applying';
}
