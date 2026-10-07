import type { IntegrationFact } from '../integrations/integration-facts-map';
import type { ProviderRow } from './provider-api';

const statusLabels: Record<string, string> = {
  needs_key: 'Needs a key',
  saved_unverified: 'Saved, not verified',
  connected_not_tested: 'Connected, not tested',
  ready: 'Model answered',
  model_test_fail: 'Model test failed',
  model_test_unknown: 'Model test outcome unknown',
  model_test_outcome_unknown: 'Model test outcome unknown; cost may be held',
  model_test_budget_refused: 'Model test refused by budget',
};

export function providerStatus(provider: ProviderRow): string {
  return statusLabels[provider.status] ?? 'Status not supplied';
}

export function formatTime(value: string | undefined): string {
  if (!value) {
    return 'No receipt yet';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Time not supplied';
  }
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  };
  return date.toLocaleString('en-GB', options) + ' UTC';
}

export function isSettledOutcome(outcome: string): boolean {
  // Keep uncertain attempts locked because their money may still be held.
  return ['pass', 'fail', 'skipped', 'budget_refused'].includes(outcome);
}

export function outcomeKind(outcome: string): 'confirmed' | 'failed' | 'blocked' | 'unknown' {
  if (outcome === 'pass' || outcome === 'skipped') {
    return 'confirmed';
  }
  if (outcome === 'fail') {
    return 'failed';
  }
  if (outcome === 'budget_refused') {
    return 'blocked';
  }
  return 'unknown';
}

export function outcomeText(outcome: string, action: string): string {
  if (outcome === 'pass') {
    if (action === 'reachability') {
      return 'The provider is reachable.';
    }
    return 'The model answered.';
  }
  if (outcome === 'skipped') {
    return 'Connected, not tested.';
  }
  if (outcome === 'fail') {
    return 'The test failed. Nothing else changed.';
  }
  if (outcome === 'budget_refused') {
    return 'The test was refused by the budget. Nothing was charged.';
  }
  if (action === 'test') {
    return 'We could not tell whether the test ran. The cost may be held. '
      + 'Check status before sending another test.';
  }
  return 'We could not tell whether this check finished. '
    + 'Check status before sending another check.';
}

export function providerFacts(provider: ProviderRow): IntegrationFact[] {
  return [keyFact(provider), reachabilityFact(provider), modelAnswerFact(provider)];
}

function keyFact(provider: ProviderRow): IntegrationFact {
  return {
    label: 'Key saved', kind: provider.saved ? 'confirmed' : 'not_configured',
    value: provider.saved ? 'Stored' : 'No key saved',
    evidence: provider.saved ? formatTime(provider.saved.time) + ' · metadata only; never shown'
      : 'A key is never read back.',
  };
}

function reachabilityFact(provider: ProviderRow): IntegrationFact {
  const fact = provider.reachable;
  if (!fact) {
    return {
      label: 'Provider reachable', kind: 'not_configured', value: 'Not checked',
      evidence: 'A saved key alone does not prove the provider can be reached.',
    };
  }
  return {
    label: 'Provider reachable', kind: outcomeKind(fact.outcome),
    value: outcomeText(fact.outcome, 'reachability'), evidence: formatTime(fact.time),
  };
}

function modelAnswerFact(provider: ProviderRow): IntegrationFact {
  const fact = provider.modelAnswer;
  if (!fact || fact.outcome === 'skipped') {
    return {
      label: 'Model answer', kind: 'not_configured',
      value: fact?.outcome === 'skipped' ? 'Connected, not tested' : 'Not tested',
      evidence: fact ? formatTime(fact.time) : 'A model answer needs a separate priced test.',
    };
  }
  let evidence = formatTime(fact.time);
  if (fact.settledCents !== undefined) {
    evidence += ` · €${(fact.settledCents / 100).toFixed(2)} settled`;
  }
  let value = outcomeText(fact.outcome, 'test');
  if (fact.outcome === 'pass') {
    value = `${fact.model ?? 'Model'} answered`;
  }
  return {
    label: 'Model answer', kind: outcomeKind(fact.outcome), value, evidence,
  };
}
