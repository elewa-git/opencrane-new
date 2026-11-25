import { AssertionError } from 'node:assert';
import { appendFile } from 'node:fs/promises';
import { ReplyCoverageFailure } from './provider-reply-coverage.ts';
import { BrowserReplyFailure, type ShutdownStep } from './provider-navigation.ts';

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
  if (error instanceof BrowserReplyFailure || error instanceof ReplyCoverageFailure) {
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

function errorDetails(error: unknown) {
  const details = [];
  const seen = new Set<Error>();
  let cause = error;
  while (cause instanceof Error && !seen.has(cause)) {
    details.push({ class: cause.constructor.name, message: cause.message, stack: cause.stack });
    seen.add(cause);
    cause = cause.cause;
  }
  if (!(cause instanceof Error) && (cause !== undefined || details.length === 0)) {
    details.push({ class: typeof cause, message: String(cause) });
  }
  return details;
}

export async function writeShutdownFailure(file: string, secrets: readonly string[],
  step: ShutdownStep, error: unknown): Promise<void> {
  const errors = errorDetails(error);
  let line = JSON.stringify({ step, errors });
  // Keep the exception in the claimed slot. Remove known credentials even from this copy.
  for (const secret of secrets) {
    if (!secret) continue;
    const serialised = JSON.stringify(secret);
    line = line.replaceAll(serialised.slice(1, -1), '[Redacted]');
  }
  await appendFile(file, `${line}\n`, { mode: 0o600 });
}
