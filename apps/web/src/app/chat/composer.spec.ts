import { TestBed } from '@angular/core/testing';
import { ChatComposer } from './composer';

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
