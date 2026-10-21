import { requireAutomatedJourney } from './journey-guard.ts';

if (process.argv[2] === 'journey') {
  requireAutomatedJourney();
}
