import { TestBed } from '@angular/core/testing';
import { App } from './app';

afterEach(function restoreAddress() {
  history.replaceState(null, '', '/');
});

function changesPageOnBrowserNavigation(): void {
  history.replaceState(null, '', '/account/preferences');
  const fixture = TestBed.createComponent(App);
  fixture.detectChanges();
  const root: unknown = fixture.nativeElement;
  if (!(root instanceof HTMLElement)) throw new Error('No app element');
  expect(root.textContent).toContain('Personal preferences are not available yet.');
  history.pushState(null, '', '/account/assistant');
  window.dispatchEvent(new PopStateEvent('popstate'));
  fixture.detectChanges();
  expect(root.textContent).toContain('Review your saved persona');
  expect(root.textContent).not.toContain('Personal preferences are not available yet.');
  history.replaceState(null, '', '/account/preferences');
  window.dispatchEvent(new PopStateEvent('popstate'));
  fixture.detectChanges();
  expect(root.textContent).toContain('Personal preferences are not available yet.');
}
it('draws the requested app page after internal navigation and browser history changes',
  changesPageOnBrowserNavigation);
