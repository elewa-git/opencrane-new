export const fleetProviderRefusal = 'Fleet tasks require the stand-in model';

const automatedJourneyRefusal =
  'Automated journeys require a secondary stack';

export function phase4JourneyScope(attempt: string): 'groups' | 'all' {
  if (attempt.startsWith('nightly-')) {
    return 'groups';
  }
  return 'all';
}

export function requireAutomatedJourney() {
  const id = process.env['DEV_STACK_ID'];
  if (id !== '1' && id !== '2') {
    throw new Error(automatedJourneyRefusal);
  }
  requireFleetStandInProvider(process.env['DEV_REAL_PROVIDER'] === '1');
}

export function requireJourneyProviderMode(settings: Record<string, string>) {
  const savedReal = settings['DEV_REAL_PROVIDER'] === '1';
  const requestedReal = process.env['DEV_REAL_PROVIDER'] === '1';
  requireFleetStandInProvider(savedReal || requestedReal);
  if (savedReal !== requestedReal) {
    throw new Error('Journey provider mode does not match the saved stack');
  }
}

export function requireStandInJourney(settings: Record<string, string>) {
  if (settings['DEV_REAL_PROVIDER'] === '1') {
    throw new Error('This journey requires the stand-in model');
  }
}

export function requireFleetStandInProvider(real: boolean) {
  if (real && process.env['OPENCRANE_FLEET_TASK'] !== undefined) {
    throw new Error(fleetProviderRefusal);
  }
}
