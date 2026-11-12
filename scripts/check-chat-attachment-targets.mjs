import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

async function assertTouchTarget(control, width) {
  await control.click({ trial: true });
  const box = await control.boundingBox();
  const name = await control.innerText();
  assert(box && box.width >= 44 && box.height >= 44,
    `${name} at ${width}px must be at least 44 × 44px; got ${box?.width} × ${box?.height}`);
}

export async function checkAttachmentTargets(page, width) {
  const filesPattern = '**/api/conversations/chat/files';
  async function refuseUpload(route) {
    if (route.request().method() === 'POST') {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: '{"rows":[]}' });
  }
  await page.route(filesPattern, refuseUpload);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload from computer', exact: true }).click();
  const file = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes') };
  await (await chooser).setFiles(file);
  const retry = page.getByRole('button', { name: 'Retry upload', exact: true });
  await retry.waitFor();
  await assertTouchTarget(retry, width);
  const remove = page.getByRole('button', { name: 'Remove notes.txt', exact: true });
  await assertTouchTarget(remove, width);
  await mkdir('docs/process/main-upload-retry-44', { recursive: true });
  await page.screenshot({
    path: `docs/process/main-upload-retry-44/retry-${width}.png`, fullPage: true,
  });
  await page.unroute(filesPattern, refuseUpload);
  let releaseUpload;
  const uploadHeld = new Promise(resolve => { releaseUpload = resolve; });
  async function holdUpload(route) {
    await uploadHeld;
    await route.abort('failed');
  }
  await page.route(filesPattern, holdUpload);
  try {
    await retry.click();
    await page.getByRole('progressbar', { name: 'notes.txt upload progress' }).waitFor();
    // Remove is also the shipped cancellation control while an upload is in progress.
    await assertTouchTarget(remove, width);
    await remove.click();
    await page.getByRole('list', { name: 'Attachments', exact: true }).waitFor({ state: 'detached' });
  } finally {
    releaseUpload();
    await page.unroute(filesPattern, holdUpload);
  }
}
