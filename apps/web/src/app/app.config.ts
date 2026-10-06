import { type ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';

// Angular 21 uses signals to update the screen because this build does not
// include zone.js. No extra change-detection provider is needed.
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners()],
};
