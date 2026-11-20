export type ProviderJourneyStep = {
  check: string;
  detail: string;
};

export function providerFailure(step: ProviderJourneyStep, _error: unknown) {
  return { check: step.check, result: 'FAIL' as const };
}
