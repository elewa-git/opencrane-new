export type ProviderJourneyStep = {
  check: string;
  detail: string;
};

export function providerFailure(step: ProviderJourneyStep, error: unknown) {
  let errorType = 'Error';
  if (error instanceof Error && error.name === 'TimeoutError') errorType = 'TimeoutError';
  if (error instanceof Error && error.name === 'AssertionError') errorType = 'AssertionError';
  // Use authored expectations only: upstream errors can contain keys, page content or paths.
  return { check: step.check, result: 'FAIL' as const, errorType, detail: step.detail };
}
