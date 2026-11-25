import { AssertionError } from 'node:assert';
import { BrowserReplyFailure } from './provider-navigation.ts';

export type ProviderJourneyStep = {
  check: string;
  detail: string;
  expectedHttpStatus?: number;
};

function isHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599;
}

function httpFailureDetail(step: ProviderJourneyStep, error: unknown): string | undefined {
  if (!(error instanceof AssertionError)) {
    return undefined;
  }
  if (step.expectedHttpStatus === undefined || error.expected !== step.expectedHttpStatus) {
    return undefined;
  }
  if (!isHttpStatus(error.actual)) {
    return undefined;
  }
  const status = `Expected HTTP ${step.expectedHttpStatus}; received HTTP ${error.actual}.`;
  return `${status} ${step.detail}`;
}

function failureDetail(step: ProviderJourneyStep, error: unknown): string {
  if (error instanceof BrowserReplyFailure) {
    return `${error.message} ${step.detail}`;
  }
  if (error instanceof Error && /^apiRequestContext\.[a-z]+: socket hang up\b/u.test(error.message)) {
    return `The browser request lost its connection. ${step.detail}`;
  }
  if (error instanceof Error && error.message.includes('strict mode violation:')) {
    return `More than one control matched the current operation. ${step.detail}`;
  }
  const httpDetail = httpFailureDetail(step, error);
  if (httpDetail) {
    return httpDetail;
  }
  return step.detail;
}

export function providerFailure(step: ProviderJourneyStep, error: unknown) {
  let errorType = 'Error';
  if (error instanceof Error && error.name === 'TimeoutError') {
    errorType = 'TimeoutError';
  }
  if (error instanceof Error && error.name === 'AssertionError') {
    errorType = 'AssertionError';
  }
  // Use only fixed expectations: upstream errors can contain keys, page content or paths.
  const detail = failureDetail(step, error);
  return { check: step.check, result: 'FAIL' as const, errorType, detail };
}
