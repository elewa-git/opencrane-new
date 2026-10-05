/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page, Locator } from 'playwright';
import { uploadPdf } from '../../apps/server/test/support/upload-pdf.ts';

export async function browserUploadJourney(page: Page, origin: string, screenshots = 'docs/design/chat/live') {
  const width = page.viewportSize()!.width;
  const target = async (locator: Locator) => {
    if (width !== 390) return;
    // Wait for the menu's opening animation before measuring its usable size.
    await locator.click({ trial: true });
    const box = await locator.boundingBox(); assert(box && box.width >= 44 && box.height >= 44, 'Touch target is at least 44px');
  };
  await page.keyboard.press('Control+n');
  await page.getByText('Draft', { exact: true }).waitFor();
  const choose = async (file: string | { name: string; mimeType: string; buffer: Buffer }) => {
    await target(page.getByRole('button', { name: 'Attach', exact: true }));
    await page.getByRole('button', { name: 'Attach', exact: true }).click();
    await target(page.getByRole('button', { name: 'Upload from computer', exact: true }));
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload from computer', exact: true }).click();
    await (await chooser).setFiles(file);
  };
  let retries = 0, previewRetries = 0, previewTransport = '';
  const openPreview = async (button: Locator) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      previewTransport = '';
      await button.click();
      const ready = page.getByText('Preview ready', { exact: true });
      const unavailable = page.getByText('Preview unavailable.', { exact: false });
      await ready.or(unavailable).waitFor();
      if (await ready.isVisible()) return;
      assert(previewTransport === 'net::ERR_NETWORK_CHANGED' && attempt < 2,
        `Promoted preview unavailable (${previewTransport || 'no browser transport error'})`);
      previewRetries++;
      await page.getByRole('button', { name: 'Close preview', exact: true }).click();
      await delay(1000);
    }
  };
  const uploaded = async (expected = 'Ready') => {
    const status = page.locator('.upload-status');
    // The transport has its own 120-second timeout; retry through the UI at most twice.
    for (let attempt = 0; attempt < 3; attempt++) {
      await status.filter({ hasText: expected }).or(status.filter({ hasText: 'Upload unavailable' })).waitFor({ timeout: 130_000 });
      if ((await status.innerText()).includes(expected)) return;
      assert(attempt < 2, 'Upload stayed unavailable after two retries');
      await delay(1000);
      const retry = page.getByRole('button', { name: 'Retry upload', exact: true });
      await target(retry); await retry.click(); retries++;
    }
  };
  // Lose the first response after the real server handles it, then retry through the shipped UI.
  const filesPattern = /\/api\/conversations\/[^/]+\/files$/u;
  page.on('requestfailed', request => {
    if (request.method() === 'POST' && filesPattern.test(request.url())) console.log('Upload transport:', request.failure()?.errorText);
    if (request.method() === 'GET' && request.url().includes('/files/view?')) {
      const error = request.failure()?.errorText;
      console.log('Preview transport:', error);
      if (error && /^net::[A-Z_]+$/u.test(error)) previewTransport = error;
    }
  });
  let loseResponse = true;
  await page.route(filesPattern, async route => {
    if (route.request().method() !== 'POST' || !loseResponse) { await route.continue(); return; }
    const response = await route.fetch({ maxRetries: 0 });
    if (response.status() !== 201) { await route.fulfill({ response }); return; }
    loseResponse = false; await route.abort('failed');
  });
  await choose({ name: 'project.pdf', mimeType: 'application/pdf', buffer: uploadPdf() });
  await uploaded();
  await page.unroute(filesPattern);
  assert(!loseResponse && retries >= 1, 'The browser recovered from the lost successful upload response');
  const conversation = new URL(page.url()).searchParams.get('conversation'); assert(conversation);
  const filesUrl = `${origin}/api/conversations/${conversation}/files`;
  const list = await (await page.request.get(filesUrl)).json() as { rows: Array<{ textPath: string }> };
  assert.equal(list.rows.length, 1);
  await page.locator('.transcript .file-card').filter({ hasText: 'project.pdf' }).waitFor();
  if (width === 390) await page.getByRole('button', { name: 'Session panel', exact: true }).click();
  const panel = width === 390
    ? page.getByRole('dialog', { name: 'Session', exact: true })
    : page.getByRole('complementary', { name: 'Session panel', exact: true });
  await panel.getByRole('heading', { name: 'Attached by you · 1' }).waitFor();
  if (width === 390) await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await page.screenshot({ path: `${screenshots}/upload-${width}.png`, fullPage: true });
  const uploadedFileCard = page.locator('.transcript .file-card');
  const openProjectFile = uploadedFileCard.getByRole('button', {
    name: 'Open project.pdf',
    exact: true,
  });
  await target(openProjectFile);
  await openPreview(openProjectFile);
  let preview = page.getByRole('dialog', { name: 'project.pdf', exact: true });
  assert.equal(await preview.locator('iframe').count(), 1);
  // Full Chromium includes the native PDF viewer; headless-shell cannot render PDF.
  const renderedBy = Date.now() + 30_000;
  while (true) {
    const viewer = page.frames().find(frame => frame.url().startsWith('chrome-extension://'));
    const number = viewer?.getByRole('textbox', { name: 'Page number', exact: true, includeHidden: true });
    if (number && await number.count() && await number.inputValue() === '1') break;
    assert(Date.now() < renderedBy, 'Native PDF viewer did not render its first page'); await delay(100);
  }

  const original = await page.request.get(`${filesUrl}/view?path=${encodeURIComponent(list.rows[0]!.textPath.slice(0, -3))}`);
  assert.equal(original.headers()['content-type'], 'application/pdf');
  assert((await original.body()).equals(uploadPdf()), 'Preview/download are the promoted original');
  if (width === 390) {
    await target(preview.getByRole('button', { name: 'Close preview', exact: true }));
    await target(preview.getByRole('link', { name: 'Download original file', exact: false }));
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.screenshot({ path: `${screenshots}/preview-${width}.png`, fullPage: true });
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  // The answer is absent from the question. The stub must receive the converted text in the turn.
  await composer.fill('What is the project code in the attached PDF?');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('article', { name: 'Agent reply', exact: true }).filter({ hasText: 'The project code is Willow-47.' }).getByText('Done', { exact: true }).waitFor({ timeout: 120_000 });
  await page.reload();
  await page.locator('.transcript .file-card').filter({ hasText: 'project.pdf' }).waitFor();
  await choose({ name: 'eicar.txt', mimeType: 'text/plain', buffer: Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*') });
  await uploaded('File refused: malware detected.');
  await target(page.getByRole('button', { name: 'Retry upload', exact: true }));
  await choose({ name: 'program.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZbinary') });
  await uploaded('File type is unsupported');
  const directory = await mkdtemp(`${tmpdir()}/oc-upload-size-`);
  try {
    const path = `${directory}/huge.txt`, file = await open(path, 'wx');
    try { await file.truncate(20 * 1024 * 1024 + 1); } finally { await file.close(); }
    // Native selection checks the real file size without copying 20 MiB through the browser driver.
    await choose(path);
    await page.getByText('File too large', { exact: false }).waitFor();
  } finally { await rm(directory, { recursive: true, force: true }); }
  for (const file of [
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Preview text from the promoted object.') },
    { name: 'pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPg3XqGJMQwqmFUw/DVAADXsI4Q6+7dzAAAAABJRU5ErkJggg==', 'base64') },
  ]) {
    await choose(file);
    await uploaded();
    const fileCard = page.locator('.transcript .file-card').filter({ hasText: file.name });
    const openFile = fileCard.getByRole('button', {
      name: `Open ${file.name}`,
      exact: true,
    });
    await openPreview(openFile);
    preview = page.getByRole('dialog', { name: file.name, exact: true });
    if (file.name.endsWith('.txt')) assert.equal(await preview.locator('pre').innerText(), file.buffer.toString());
    else assert(await preview.locator('img').evaluate(async img => { await (img as HTMLImageElement).decode(); return (img as HTMLImageElement).naturalWidth > 0; }));
    await preview.getByRole('button', { name: 'Close preview', exact: true }).click();
  }
  assert.equal(((await (await page.request.get(filesUrl)).json()) as { rows: unknown[] }).rows.length, 3, 'Refused files never appear');
  console.log(`PASS browser upload ${width}px: PDF → ClamAV → MarkItDown → bounded turn context → Willow-47; ${retries} upload retries, ${previewRetries} preview retries, no duplicate files; reload; EICAR/type/size refused; promoted PDF/text/image previews; screenshots`);
}
