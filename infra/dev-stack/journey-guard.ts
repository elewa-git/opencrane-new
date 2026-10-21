const automatedJourneyRefusal =
  'Automated journeys require a secondary stack and no fleet task';

export function requireAutomatedJourney() {
  const id = process.env['DEV_STACK_ID'];
  if ((id !== '1' && id !== '2') || process.env['OPENCRANE_FLEET_TASK'] !== undefined) {
    throw new Error(automatedJourneyRefusal);
  }
}

export function requireJourneyProviderMode(settings: Record<string, string>) {
  const savedReal = settings['DEV_REAL_PROVIDER'] === '1';
  const requestedReal = process.env['DEV_REAL_PROVIDER'] === '1';
  if (savedReal !== requestedReal) {
    throw new Error('Journey provider mode does not match the saved stack');
  }
}

export function requireStandInJourney(settings: Record<string, string>) {
  if (settings['DEV_REAL_PROVIDER'] === '1') {
    throw new Error('This journey requires the stand-in model');
  }
}
