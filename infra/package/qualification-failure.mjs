const roleAndWidth = '(owner|admin|member|wrong-organisation) (1280|390)px ';
const operation = '(sign-in|session|claim|workspace|composer|draft|send|reply|completion|' +
  'screenshot|invitation|directory|token reuse)';
const safeStep = new RegExp(`^(${roleAndWidth}${operation}|browser launch)$`, 'u');

export function journeyFailure(step, error) {
  let code = 'BROWSER_ERROR';
  if (error?.name === 'TimeoutError') code = 'BROWSER_TIMEOUT';
  else if (error?.code === 'ERR_ASSERTION') code = 'ASSERTION_FAILED';
  else if (/net::ERR_[A-Z_]+/u.test(error?.message ?? '')) code = 'BROWSER_NETWORK_ERROR';
  return { step: safeStep.test(step) ? step : 'unknown step', result: 'FAIL', code };
}

export async function captureJourneyFailure(page, error, options) {
  const failure = journeyFailure(options.step, error);
  try {
    // Mask form values even when the failed step is on the external sign-in page.
    const fields = page.locator('input, textarea');
    await page.screenshot({ path: options.path, fullPage: true, mask: [fields] });
    return { ...failure, screenshot: 'PASS' };
  } catch {
    // Preserve the original failure and report missing evidence explicitly.
    return { ...failure, screenshot: 'FAIL' };
  }
}

export async function closeAfterJourney(context, run, capture) {
  try {
    return await run();
  } catch (error) {
    await capture(error);
    throw error;
  } finally {
    await context.close();
  }
}
