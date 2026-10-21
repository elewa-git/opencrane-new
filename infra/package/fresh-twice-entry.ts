import { requireAutomatedJourney } from '../dev-stack/journey-guard.ts';

// Keep imported assertion helpers usable without starting a qualification run.
if (process.argv[1]?.endsWith('/fresh-twice.ts')) {
  requireAutomatedJourney();
}
