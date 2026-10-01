import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { SharedStateKind } from '@opencrane/protocol';
import { SharedState } from './shared-state';

@Component({ imports: [SharedState], template: `<oc-shared-state [kind]="kind()" [message]="message"
  [detail]="detail" [actionLabel]="actionLabel" [safeToRetry]="safe()" />` })
class Host {
  readonly kind = signal<SharedStateKind>('ready');
  message = 'Visible words';
  detail = 'Evidence';
  actionLabel = 'Manage';
  readonly safe = signal(false);
}

const stateCases: ReadonlyArray<[SharedStateKind, string | undefined, boolean, string | undefined]> = [
  ['not_configured', 'Start setup', false, 'Start setup'], ['draft', 'Continue', false, 'Continue'],
  ['checking', 'Submit again', false, undefined], ['needs_input', 'Connect account', false, 'Connect account'],
  ['ready', 'Manage', false, 'Manage'], ['failed', 'Wrong retry label', true, 'Try the same change again'],
  ['failed', 'Wrong retry label', false, undefined],
  ['unknown', 'Wrong status label', false, 'Check status'], ['access_changed', 'Ask an admin', false, 'Ask an admin'],
  ['disabled', 'Set up again', false, 'Set up again'],
];

describe('SharedState', () => {
  function rootOf(fixture: ComponentFixture<Host>): HTMLElement {
    const element: unknown = fixture.nativeElement;
    if (!(element instanceof HTMLElement)) throw new Error('Expected HTML root');
    return element;
  }

  it.each(stateCases)(
    'shows the glyph, words, action rule and polite live region for %s', (kind, action, safe, expectedAction) => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.kind.set(kind);
    fixture.componentInstance.actionLabel = action ?? '';
    fixture.componentInstance.safe.set(safe);
    fixture.detectChanges();
    const root = rootOf(fixture);
    expect(root.querySelector('[data-glyph]')?.getAttribute('aria-hidden')).toBe('true');
    expect(root.textContent).toContain('Visible words');
    expect(root.textContent).toContain('Evidence');
    expect(root.querySelector('.state')?.getAttribute('aria-live')).toBe('polite');
    expect(root.querySelector('button')?.textContent.trim()).toBe(expectedAction);
    },
  );
});
