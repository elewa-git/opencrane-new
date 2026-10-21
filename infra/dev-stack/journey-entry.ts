import { requireAutomatedJourney } from './journey-guard.ts';

// Refuse automated owner access before any dependency evaluates stack configuration.
requireAutomatedJourney();
