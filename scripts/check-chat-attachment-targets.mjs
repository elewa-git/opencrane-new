import assert from 'node:assert/strict';
import { waitForUpload } from '../infra/dev-stack/browser-upload-status.ts';
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
  const heldUpload = Promise.withResolvers();
  async function holdUpload(route) {
    await heldUpload.promise;
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
    heldUpload.resolve();
    await page.unroute(filesPattern, holdUpload);
  }
}

export async function checkUploadStatusFlow(page, fixture) {
  const filesPattern = '**/api/conversations/chat/files';
  const requestKeys = [];
  async function uploadReply(route) {
    const request = route.request();
    const headers = request.headers();
    if (request.method() !== 'POST') {
      await route.fulfill({ contentType: 'application/json', body: '{"rows":[]}' });
      return;
    }
    if (headers['x-file-name'] === 'refused.txt') {
      await route.fulfill({ status: 422, contentType: 'application/json', body: '{}' });
      return;
    }
    requestKeys.push(headers['idempotency-key']);
    if (requestKeys.length === 1) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({ status: 201, contentType: 'application/json',
      body: '{"fileId":"ready-file"}' });
  }
  await page.route(filesPattern, uploadReply);
  const input = page.locator('input[type=file]');
  await input.setInputFiles({ name: 'refused.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Refusal fixture') });
  await page.getByText('File refused: malware detected.', { exact: true }).waitFor();
  await input.setInputFiles({ name: 'ready.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Ready fixture') });
  const retries = await waitForUpload(page, 'ready.txt', checkTarget);
  assert.equal(retries, 1);
  assert.equal(requestKeys.length, 2);
  assert.equal(requestKeys[0], requestKeys[1], 'Retry keeps the original request key');
  assert.equal(await waitForUpload(page, 'refused.txt', checkTarget,
    'File refused: malware detected.'), 0);
  fixture.add('file.delivered', { fileId: 'ready-file' });
  await page.getByRole('textbox', { name: 'Message your agent' }).fill('Read the attached file');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('list', { name: 'Attachments', exact: true }).waitFor({ state: 'detached' });
  const message = fixture.commands.at(-1);
  assert.deepEqual(message.attachmentIds, ['ready-file']);
  assert.equal(message.text, 'Read the attached file');
  await page.unroute(filesPattern, uploadReply);
}

async function checkTarget(control) {
  await assertTouchTarget(control, control.page().viewportSize().width);
}
