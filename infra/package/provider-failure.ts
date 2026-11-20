import { AssertionError } from 'node:assert';

export type ProviderJourneyStep = {
  check: string;
  detail: string;
  expectedHttpStatus?: number;
};

function failureDetail(step: ProviderJourneyStep, error: unknown): string {
  if (error instanceof Error && error.message.includes('strict mode violation:')) {
    return `More than one control matched the current operation. ${step.detail}`;
  }
  if (error instanceof AssertionError && step.expectedHttpStatus !== undefined
      && error.expected === step.expectedHttpStatus && typeof error.actual === 'number'
      && Number.isInteger(error.actual) && error.actual >= 100 && error.actual <= 599) {
    return `Expected HTTP ${step.expectedHttpStatus}; received HTTP ${error.actual}. ${step.detail}`;
  }
  return step.detail;
}

export function providerFailure(step: ProviderJourneyStep, error: unknown) {
  let errorType = 'Error';
  if (error instanceof Error && error.name === 'TimeoutError') errorType = 'TimeoutError';
  if (error instanceof Error && error.name === 'AssertionError') errorType = 'AssertionError';
  // Use authored expectations only: upstream errors can contain keys, page content or paths.
  const detail = failureDetail(step, error);
  return { check: step.check, result: 'FAIL' as const, errorType, detail };
}
