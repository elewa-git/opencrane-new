// A whole-page navigation, behind a token so tests can swap it out. jsdom
// does not let a test stub `window.location.assign` directly (it throws
// "Cannot redefine property"), so the component asks for this instead of
// calling `window.location` itself.
import { InjectionToken } from '@angular/core';

export type Navigate = (url: string) => void;

export const NAVIGATE = new InjectionToken<Navigate>('NAVIGATE', {
  factory: () => (url: string) => window.location.assign(url),
});
