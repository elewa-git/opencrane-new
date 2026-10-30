import { TestBed } from '@angular/core/testing';
import { ChatComposer } from './composer';

async function hidesDropStateWithoutAttach(mode: 'directMode' | 'teamSession' | 'reason') {
  const fixture = TestBed.createComponent(ChatComposer);
  const inputValue = mode === 'reason' ? 'Chat unavailable' : true;
  fixture.componentRef.setInput(mode, inputValue);
  fixture.componentRef.setInput('fileDrag', true);
  await fixture.whenStable();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No root');
  expect(root.querySelector('[aria-label="Attach"]')).toBeNull();
  expect(root.querySelector('.drop-label')).toBeNull();
  expect(root.querySelector('.file-drag')).toBeNull();
  expect(root.textContent).not.toContain('Drop files to add them');
}

it.each(['directMode', 'teamSession', 'reason'] as const)(
  'keeps drop controls out of the composer when Attach is unavailable: %s',
  hidesDropStateWithoutAttach,
);

it('sends on Enter, keeps Shift+Enter and IME composition, and swaps Send for Stop', async () => {
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.componentRef.setInput('draft', 'Hello');
  const sent: string[] = []; fixture.componentInstance.submitted.subscribe(text => sent.push(text));
  await fixture.whenStable();
  const value: unknown = fixture.nativeElement;
  if (!(value instanceof HTMLElement)) throw new Error('No root');
  const root = value;
  const field = root.querySelector('textarea')!;
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
  expect(sent).toEqual([]);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(sent).toEqual(['Hello']);
  fixture.componentRef.setInput('working', true); await fixture.whenStable();
  expect(root.querySelector('[type=submit]')).toBeNull();
  expect(root.textContent).toContain('Stop');
  expect(root.querySelector('[aria-label="Participants"]')).toBeNull();
});

it('chooses an upload from the attach menu', async () => {
  const fixture = TestBed.createComponent(ChatComposer);
  await fixture.whenStable();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No root');
  root.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.click();
  await fixture.whenStable();
  const upload = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('Upload from computer'))!;
  expect(upload.textContent).not.toContain('Coming soon');
  const chooser = root.querySelector<HTMLInputElement>('input[type=file]');
  expect(chooser).not.toBeNull();
  const clicked = vi.spyOn(chooser!, 'click'); upload.click();
  expect(clicked).toHaveBeenCalledOnce();
});

it('keeps file selection disabled while a message is queued for retry', async () => {
  const fixture = TestBed.createComponent(ChatComposer);
  fixture.componentRef.setInput('queued', true);
  await fixture.whenStable();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No root');
  root.querySelector<HTMLButtonElement>('[aria-label="Attach"]')!.click();
  await fixture.whenStable();
  expect([...root.querySelectorAll('button')].find(button => button.textContent?.includes('Upload from computer'))!.disabled).toBe(true);
});
