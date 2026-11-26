import { surveyHistory } from './history.ts';
import type { OnboardingOptions } from './options.ts';
import { welcomeRequiredStep } from './welcome.ts';

export async function onboardingDestination(options: OnboardingOptions, memberId: string) {
  const history = await surveyHistory(options, memberId);
  if (history.skipped || history.welcome?.completion) {
    return 'workspace';
  }
  if (history.welcome) {
    return 'welcome';
  }
  // Send members to the persona page, where they can continue without an assistant.
  return welcomeRequiredStep(history, true) ?? 'welcome';
}
