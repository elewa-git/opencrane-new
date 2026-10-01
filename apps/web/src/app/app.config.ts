import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';

// No zone.js, no provideZonelessChangeDetection() call needed: Angular 21
// runs zoneless by default once zone.js is absent from the build (it is —
// nothing here imports it), so change detection is driven entirely by
// signals.
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners()],
};
