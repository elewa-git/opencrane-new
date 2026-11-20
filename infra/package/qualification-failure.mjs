export function journeyFailure(step, error) {
  const code = /^[A-Z_]+$/u.test(error.code ?? '') ? error.code : 'withheld';
  return { step, result: 'FAIL', code };
}

export async function captureJourneyFailure(page, error, options) {
  const failure = journeyFailure(options.step, error);
  try {
    await page.screenshot({ path: options.path, fullPage: true });
    return { ...failure, screenshot: 'PASS' };
  } catch {
    return { ...failure, screenshot: 'FAIL' };
  }
}

export async function closeAfterJourney(context, run, capture) {
  try {
    try {
      return await run();
    } finally {
      await context.close();
    }
  } catch (error) {
    await capture(error);
    throw error;
  }
}
