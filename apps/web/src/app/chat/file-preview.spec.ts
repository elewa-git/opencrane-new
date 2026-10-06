import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { FilePreview } from './file-preview';

const facts = {
  computerId: 'kijani-sales-01', generation: 4,
  capturedAt: '2026-10-02T10:42:00Z', width: 1440, height: 900, size: 421888,
};
const revokedUrls: string[] = [];

afterEach(function restorePreviewMocks() {
  vi.restoreAllMocks();
  revokedUrls.length = 0;
  TestBed.resetTestingModule();
});

function pngResponse(): Response {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'content-type': 'image/png' },
  });
}

async function createPreview(downloadAllowed = true) {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:screenshot');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(function recordRevokedUrl(url) {
    revokedUrls.push(url);
  });
  const fixture = TestBed.createComponent(FilePreview);
  fixture.componentRef.setInput('path', 'uploads/chat/screen/screen.png');
  fixture.componentRef.setInput('conversationId', 'chat');
  fixture.componentRef.setInput('screenshot', facts);
  fixture.componentRef.setInput('conversationTitle', 'quarterly-review');
  fixture.componentRef.setInput('downloadAllowed', downloadAllowed);
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('Missing preview');
  const dialog = root.querySelector('dialog');
  if (!dialog) throw new Error('Missing preview dialog');
  Object.defineProperty(dialog, 'showModal', {
    configurable: true,
    value: function showDialog() { dialog.setAttribute('open', ''); },
  });
  Object.defineProperty(dialog, 'close', {
    configurable: true,
    value: function closeDialog() { dialog.removeAttribute('open'); },
  });
  fixture.detectChanges();
  await fixture.whenStable();
  await vi.waitFor(() => expect(root.querySelector('[data-state]')
    ?.getAttribute('data-state')).not.toBe('checking'));
  return { fixture, root };
}

it('shows a screenshot image, its facts and the original download link', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(pngResponse());
  const { root } = await createPreview();
  expect(root.textContent).toContain('Preview ready');
  expect(root.querySelector('img')?.getAttribute('alt')).toBe(
    'Screenshot of kijani-sales-01. No description of its contents is generated.',
  );
  expect(root.textContent).toContain('PNG · 1440 × 900 · 412 KB');
  expect(root.textContent).toContain('kijani-sales-01 · generation 4');
  expect(root.textContent).toContain('Files · #quarterly-review');
  expect(root.querySelector('a')?.textContent).toContain('Download original file');
  const closeButtons = [...root.querySelectorAll('button')]
    .filter(button => button.textContent?.includes('Close preview'));
  expect(closeButtons).toHaveLength(1);
});

it('checks access and reloads the image after a 403', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(new Response('{}', { status: 403 }));
  fetch.mockResolvedValueOnce(pngResponse());
  const { fixture, root } = await createPreview();
  expect(root.textContent).toContain('Preview unavailable. Your access is checked again');
  const requested = vi.fn();
  fixture.componentInstance.accessCheckRequested.subscribe(requested);
  const button = [...root.querySelectorAll('button')]
    .find(candidate => candidate.textContent?.includes('Check access and reopen'));
  if (!button) throw new Error('Missing access check action');
  button.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Preview ready'));
  expect(requested).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(root.textContent).toContain('Preview ready');
});

it('shows a refused state without retry for a missing file', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 404 }));
  const { root } = await createPreview();
  expect(root.textContent).toContain('Preview unavailable. This file is not available to you.');
  expect(root.querySelector('button')?.textContent).not.toContain('Try preview again');
});

it('retries a failed preview and revokes the old object URL', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  fetch.mockResolvedValueOnce(pngResponse());
  fetch.mockResolvedValueOnce(new Response('{}', { status: 500 }));
  fetch.mockResolvedValueOnce(pngResponse());
  const { fixture, root } = await createPreview();
  await fixture.componentInstance['reload']();
  fixture.detectChanges();
  const button = [...root.querySelectorAll('button')]
    .find(candidate => candidate.textContent?.includes('Try preview again'));
  if (!button) throw new Error('Missing preview retry');
  button.click();
  await vi.waitFor(() => expect(root.textContent).toContain('Preview ready'));
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(revokedUrls).toContain('blob:screenshot');
});

it('hides download when the caller does not allow it and revokes on destroy', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(pngResponse());
  const { fixture, root } = await createPreview(false);
  expect(root.querySelector('a')).toBeNull();
  fixture.destroy();
  expect(revokedUrls).toContain('blob:screenshot');
});
