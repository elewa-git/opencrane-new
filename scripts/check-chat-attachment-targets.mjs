import assert from 'node:assert/strict';
import { sendUploadedMessage } from '../infra/dev-stack/browser-upload-message.ts';
import { assertTouchTarget } from '../infra/dev-stack/browser-target.ts';
import { waitForUpload } from '../infra/dev-stack/browser-upload-status.ts';
import { mkdir } from 'node:fs/promises';

const emptyFiles = { contentType: 'application/json', body: '{"rows":[]}' };
const detached = { state: 'detached' };

export async function checkAttachmentTargets(page, width) {
  const filesPattern = '**/api/conversations/chat/files';
  async function refuseUpload(route) {
    if (route.request().method() === 'POST') {
      await route.abort('failed');
      return;
    }
    await route.fulfill(emptyFiles);
  }
  await page.route(filesPattern, refuseUpload);
  const attach = page.getByRole('button', { name: 'Attach', exact: true });
  await attach.click();
  const chooser = page.waitForEvent('filechooser');
  const upload = page.getByRole('button', { name: 'Upload from computer', exact: true });
  await upload.click();
  const file = { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes') };
  const fileChooser = await chooser;
  await fileChooser.setFiles(file);
  const retry = page.getByRole('button', { name: 'Retry upload', exact: true });
  await retry.waitFor();
  await assertTouchTarget(retry);
  const remove = page.getByRole('button', { name: 'Remove notes.txt', exact: true });
  await assertTouchTarget(remove);
  await mkdir('docs/process/main-upload-retry-44', { recursive: true });
  const screenshot = {
    path: `docs/process/main-upload-retry-44/retry-${width}.png`, fullPage: true,
  };
  await page.screenshot(screenshot);
  await page.unroute(filesPattern, refuseUpload);
  const heldUpload = Promise.withResolvers();
  async function holdUpload(route) {
    await heldUpload.promise;
    await route.abort('failed');
  }
  await page.route(filesPattern, holdUpload);
  try {
    await retry.click();
    const progress = page.getByRole('progressbar', { name: 'notes.txt upload progress' });
    await progress.waitFor();
    // Remove is also the shipped cancellation control while an upload is in progress.
    await assertTouchTarget(remove);
    await remove.click();
    const attachments = page.getByRole('list', { name: 'Attachments', exact: true });
    await attachments.waitFor(detached);
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
      await route.fulfill(emptyFiles);
      return;
    }
    if (headers['x-file-name'] === 'program.exe') {
      const reply = { status: 415, contentType: 'application/json',
        body: '{"reason":"unsupported_type"}' };
      await route.fulfill(reply);
      return;
    }
    if (headers['x-file-name'] === 'refused.txt') {
      const reply = { status: 422, contentType: 'application/json', body: '{}' };
      await route.fulfill(reply);
      return;
    }
    requestKeys.push(headers['idempotency-key']);
    if (requestKeys.length === 1) {
      await route.abort('failed');
      return;
    }
    const reply = { status: 201, contentType: 'application/json',
      body: '{"fileId":"ready-file"}' };
    await route.fulfill(reply);
  }
  await page.route(filesPattern, uploadReply);
  const input = page.locator('input[type=file]');
  const refused = { name: 'refused.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Refusal fixture') };
  await input.setInputFiles(refused);
  const malware = page.getByText('File refused: malware detected.', { exact: true });
  await malware.waitFor();
  const ready = { name: 'ready.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Ready fixture') };
  await input.setInputFiles(ready);
  const retries = await waitForUpload(page, 'ready.txt', assertTouchTarget);
  assert.equal(retries, 1);
  assert.equal(requestKeys.length, 2);
  assert.equal(requestKeys[0], requestKeys[1], 'Retry keeps the original request key');
  const refusedRetries = await waitForUpload(page, 'refused.txt', assertTouchTarget,
    'File refused: malware detected.');
  assert.equal(refusedRetries, 0);
  const delivery = { fileId: 'ready-file' };
  fixture.add('file.delivered', delivery);
  await checkSendCompletion(page, fixture);
  const unsupported = { name: 'program.exe', mimeType: 'application/octet-stream',
    buffer: Buffer.from('MZbinary') };
  await input.setInputFiles(unsupported);
  const refusal = 'This file type is not supported. Try a supported document, image or text file.';
  const unsupportedRetries = await waitForUpload(page, 'program.exe', assertTouchTarget, refusal);
  assert.equal(unsupportedRetries, 0);
  await page.unroute(filesPattern, uploadReply);
}

async function checkSendCompletion(page, fixture) {
  const acknowledgement = Promise.withResolvers();
  const requested = Promise.withResolvers();
  async function holdMessage(route) {
    requested.resolve();
    await acknowledgement.promise;
    await route.fallback();
  }
  const messagesPattern = '**/api/conversations/chat/messages';
  await page.route(messagesPattern, holdMessage);
  const sending = sendUploadedMessage(page, 'Read the attached file', 'Hello from your computer.');
  let sent = false;
  let sendFailure;
  function markSent() {
    sent = true;
  }
  function markFailed(error) {
    sendFailure = error;
  }
  const checkedSend = sending.then(markSent, markFailed);
  try {
    await requested.promise;
    await page.waitForFunction(composerIsSending);
    await page.evaluate(nextFrame);
    await page.evaluate(nextFrame);
    assert.equal(sent, false, 'Wait for the new reply, even while Send remains visible');
  } finally {
    acknowledgement.resolve();
  }
  const attachments = page.getByRole('list', { name: 'Attachments', exact: true });
  await attachments.waitFor(detached);
  const messages = page.getByRole('article', { name: 'Your message', exact: true });
  const posted = messages.filter({ hasText: 'Read the attached file' });
  await posted.waitFor();
  const message = fixture.commands.at(-1);
  assert.deepEqual(message.attachmentIds, ['ready-file']);
  assert.equal(message.text, 'Read the attached file');
  const turn = { turnId: message.id };
  fixture.add('agent.turn_started', turn);
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  const trial = { trial: true };
  await stop.click(trial);
  assert.equal(sent, false, 'Wait for the new reply to finish before the next attachment');
  const answer = { turnId: message.id, messageId: 'attachment-answer',
    text: 'Hello from your computer.' };
  fixture.add('agent.message_delta', answer);
  fixture.add('agent.turn_completed', turn);
  await checkedSend;
  if (sendFailure !== undefined) throw sendFailure;
  await page.unroute(messagesPattern, holdMessage);
}

function composerIsSending() {
  const send = globalThis.document.querySelector('button.send');
  return send?.disabled === true;
}

function nextFrame() {
  return new Promise(globalThis.requestAnimationFrame);
}
