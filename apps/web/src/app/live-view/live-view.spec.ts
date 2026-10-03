import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveView } from './live-view';

afterEach(() => vi.unstubAllGlobals());
it('clears the desktop and explains a refused view without offering control', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })));
  const fixture = TestBed.createComponent(LiveView); fixture.componentRef.setInput('conversationId', 'chat');
  await fixture.whenStable();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing viewer');
  element.querySelector<HTMLButtonElement>('button')!.click(); await fixture.whenStable();
  expect(element.textContent).toContain('Access changed');
  expect(element.textContent).toContain('Read-only');
  expect(element.querySelector('canvas')).toBeNull();
  expect(element.textContent).not.toMatch(/Take control|Clipboard/u);
});

it('cancels an old conversation view when the session panel switches conversation', async () => {
  let finish!: (response: Response) => void;
  const request = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal('fetch', request);
  const fixture = TestBed.createComponent(LiveView); fixture.componentRef.setInput('conversationId', 'old');
  await fixture.whenStable();
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Missing viewer');
  element.querySelector<HTMLButtonElement>('button')!.click(); await fixture.whenStable();
  expect(element.textContent).toContain('Connecting');
  fixture.componentRef.setInput('conversationId', 'new'); await fixture.whenStable();
  expect(element.textContent).toContain('Disconnected');
  finish(new Response('{"ticket":"old-ticket"}')); await fixture.whenStable();
  expect(element.textContent).toContain('View computer');
  expect(element.querySelector('canvas')).toBeNull();
  element.querySelector<HTMLButtonElement>('button')!.click(); await fixture.whenStable();
  expect(request).toHaveBeenLastCalledWith('/api/conversations/new/view', expect.objectContaining({ method: 'POST' }));
  finish(new Response('{}', { status: 403 })); await fixture.whenStable();
});
