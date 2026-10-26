import assert from 'node:assert/strict';

export type JourneyBinding = {
  source: string; image: string; context: string; namespace: string;
  namespaceUid: string; releaseUid: string; installId: string;
  pvcUids: string[]; storeId: string; origin: string;
};
type Outcome = {
  width: number; authenticated: boolean; subject: string; chat: boolean; historyRefused: boolean;
};

function width(outcome: Outcome) {
  return outcome.width;
}

export function checkJourney(value: unknown, binding: JourneyBinding): Outcome[] {
  assert(/^http:\/\/127\.0\.0\.1:25[12]06$/u.test(binding.origin),
    'Journey origin must be the claimed loopback address');
  const receipt = value as { binding?: JourneyBinding; outcomes?: Outcome[] } | null;
  // Use a fixed error so a foreign receipt cannot print private values through an assertion diff.
  const matches = JSON.stringify(receipt?.binding) === JSON.stringify(binding);
  assert(matches, 'Journey receipt belongs to another install');
  assert(Array.isArray(receipt?.outcomes), 'Journey outcomes are missing');
  const outcomes = receipt.outcomes;
  const widths = outcomes.map(width);
  assert(widths.length === 2 && widths[0] === 1280 && widths[1] === 390,
    'Journey widths are incomplete');
  for (const outcome of outcomes) {
    assert(outcome.authenticated === true, 'Journey sign-in failed');
    assert(outcome.chat === true, 'Journey chat failed');
    assert(outcome.historyRefused === true, 'Journey history refusal failed');
  }
  function checkedOutcome(outcome: Outcome): Outcome {
    return { width: outcome.width, authenticated: outcome.authenticated, subject: outcome.subject,
      chat: outcome.chat, historyRefused: outcome.historyRefused };
  }
  return outcomes.map(checkedOutcome);
}

export function checkHistoryRefusal(status: number, body: string) {
  // Accept only the public refusal bytes; extra fields could contain protected history.
  assert(status === 401 && body === '{"status":"refused"}',
    'Unauthenticated history returned unexpected bytes');
}

export function checkCollectorOwner(binding: JourneyBinding, owner: {
  context: string; namespaceUid: string; releaseSecretUid?: string; installId?: string;
} | undefined) {
  assert(owner && owner.context === binding.context &&
    owner.namespaceUid === binding.namespaceUid && owner.releaseSecretUid === binding.releaseUid &&
    owner.installId === binding.installId, 'Collector requires the current owned install');
}
