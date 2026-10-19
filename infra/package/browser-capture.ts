const failurePrefix = 'FAIL browser during ';
const browserStep = /^(browser launch|[0-9]+px (home|SSO button|login name|password|return|session|signed-in page|chat turn))$/u;

export function browserFailure(step: string, error: unknown) {
  const safeStep = browserStep.test(step) ? step : 'unknown step';
  const message = error instanceof Error ? error.message : '';
  const firstLine = message.split('\n')[0] ?? '';
  // Keep only browser error forms that cannot contain page text or credential values.
  const timeout = firstLine.match(/^[a-zA-Z.]+: Timeout [0-9]+ms exceeded\./u);
  const network = firstLine.match(/^[a-zA-Z.]+: net::ERR_[A-Z_]+/u);
  let reason = timeout?.[0] ?? network?.[0] ?? 'Browser error (details withheld)';
  if (firstLine.includes('Executable doesn\'t exist')) reason = 'Browser executable is missing';
  if (firstLine.includes('Target page, context or browser has been closed')) {
    reason = 'Target page, context or browser has been closed';
  }
  return `${failurePrefix}${safeStep}: ${reason}`;
}

export function retainedBrowserFailure(stderr: string) {
  const lines = stderr.split('\n');
  for (const line of lines) {
    if (!line.startsWith(failurePrefix)) continue;
    const details = line.slice(failurePrefix.length);
    const separator = details.indexOf(': ');
    const step = details.slice(0, separator);
    const message = details.slice(separator + 2);
    return browserFailure(step, new Error(message));
  }
  return `${failurePrefix}unknown step: Browser process failed without a safe reason`;
}
