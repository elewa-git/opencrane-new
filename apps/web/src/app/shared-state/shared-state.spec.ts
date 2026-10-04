import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { SharedState, type PresentationState } from './shared-state';

function create(kind: PresentationState): ComponentFixture<SharedState> {
  const fixture = TestBed.createComponent(SharedState);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('message', 'Visible operation words');
  fixture.detectChanges();
  return fixture;
}

function rootOf(fixture: ComponentFixture<SharedState>): HTMLElement {
  const element: unknown = fixture.nativeElement;
  if (!(element instanceof HTMLElement)) throw new Error('Expected HTML root');
  return element;
}

function actionText(fixture: ComponentFixture<SharedState>): string | undefined {
  return rootOf(fixture).querySelector('button')?.textContent.trim();
}

describe('SharedState action and announcement contract', () => {
  it('offers retry only for a server-established safe failure, never for an unknown outcome', () => {
    const fixture = create('failed');
    fixture.componentRef.setInput('actionLabel', 'Try again');
    fixture.detectChanges();
    expect(actionText(fixture)).toBeUndefined();
    expect(rootOf(fixture).textContent).not.toContain('nothing changed');
    fixture.componentRef.setInput('safeToRetry', true);
    fixture.detectChanges();
    expect(actionText(fixture)).toBe('Try again');
    expect(rootOf(fixture).textContent).toContain('Failed — nothing changed');
    fixture.componentRef.setInput('kind', 'unknown');
    fixture.componentRef.setInput('changeReference', 'chg_original');
    fixture.detectChanges();
    expect(actionText(fixture)).toBe('Check status');
    expect(rootOf(fixture).textContent).toContain('chg_original');
    const action = vi.fn();
    fixture.componentInstance.action.subscribe(action);
    rootOf(fixture).querySelector('button')?.click();
    expect(action).toHaveBeenCalledOnce();
  });

  it('keeps repeated rows silent and allows one explicit operation announcement', () => {
    const fixture = create('checking');
    fixture.componentRef.setInput('actionLabel', 'Submit again');
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('[aria-live]')).toBeNull();
    expect(actionText(fixture)).toBeUndefined();
    fixture.componentRef.setInput('announce', true);
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('[role=status]')?.textContent)
      .toContain('Visible operation words');
    expect(rootOf(fixture).querySelector('[data-glyph]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('shows supplied evidence and timestamps in UTC without inventing dates', () => {
    const fixture = create('ready');
    expect(rootOf(fixture).querySelector('time')).toBeNull();
    fixture.componentRef.setInput('evidenceAt', '2026-10-04T08:40:00Z');
    fixture.detectChanges();
    expect(rootOf(fixture).querySelector('time')?.textContent).toContain('4 Oct 2026, 08:40 UTC');
    fixture.componentRef.setInput('kind', 'scheduled');
    fixture.componentRef.setInput('timestamp', '2026-10-04T12:00:00+02:00');
    fixture.detectChanges();
    expect(rootOf(fixture).textContent).toContain('Scheduled');
    expect(rootOf(fixture).textContent).toContain('10:00 UTC');
    fixture.componentRef.setInput('timestamp', 'invalid');
    fixture.detectChanges();
    expect(rootOf(fixture).textContent).not.toContain('Invalid Date');
  });

  it.each<PresentationState>(['draft', 'paused', 'blocked', 'removed', 'waiting', 'ready'])(
    'refuses an inappropriate retry label for %s', (kind) => {
      const fixture = create(kind);
      fixture.componentRef.setInput('actionLabel', 'Try again');
      fixture.detectChanges();
      expect(actionText(fixture)).toBeUndefined();
    },
  );
});
