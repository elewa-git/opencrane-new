import { InjectionToken } from '@angular/core';

export type Navigate = (url: string) => void;

export const NAVIGATE = new InjectionToken<Navigate>('NAVIGATE', {
  factory: () => (url: string) => window.location.assign(url),
});
