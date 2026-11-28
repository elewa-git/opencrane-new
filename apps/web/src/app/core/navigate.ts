import { InjectionToken } from '@angular/core';

export type Navigate = (url: string) => void;

export const NAVIGATE = new InjectionToken<Navigate>('NAVIGATE', {
  factory: () => (url: string) => window.location.assign(url),
});

export function navigateInApp(url: string): void {
  history.pushState(null, '', url);
  // Notify Angular to recreate the page because pushState does not emit popstate.
  window.dispatchEvent(new PopStateEvent('popstate'));
}
