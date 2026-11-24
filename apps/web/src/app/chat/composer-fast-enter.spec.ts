import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ChatComposer } from './composer';

@Component({
  imports: [ChatComposer],
  template: `<oc-chat-composer [draft]="draft()" (draftChange)="draft.set($event)"
    (submitted)="submitted.push($event)" />`,
})
class ComposerHost {
  readonly draft = signal('');
  readonly submitted: string[] = [];
}

async function submitsCurrentInputBeforeTheNextRender(
  initialText: string, currentText: string, expected: string[],
): Promise<void> {
  const fixture = TestBed.createComponent(ComposerHost);
  fixture.componentInstance.draft.set(initialText);
  await fixture.whenStable();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No composer host');
  const field = root.querySelector('textarea');
  if (!field) throw new Error('No composer field');
  field.value = currentText;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(fixture.componentInstance.submitted).toEqual(expected);
}

const fastEnterCases: [string, string, string[]][] = [
  ['', 'Say hello briefly.', ['Say hello briefly.']],
  ['Earlier text', 'Current text', ['Current text']],
  ['Earlier text', '', []],
];

it.each(fastEnterCases)('submits current text %j → %j when Enter precedes the next render',
  submitsCurrentInputBeforeTheNextRender);
