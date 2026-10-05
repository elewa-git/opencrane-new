import type { EffectDetail, EffectStatus } from '@opencrane/protocol';
import { money } from './spending-money';

export interface ResolutionCommand {
  commandId: string;
  expectedSequence: number;
  outcome: 'settled' | 'released';
  settledCents: number;
  evidence: Array<Record<string, string | number | boolean>>;
}

export interface SentResolution {
  permitId: string;
  expectedSequence: number;
  command: ResolutionCommand;
}

export interface PendingResolution extends SentResolution {
  inFlight: boolean;
  noticeShown: boolean;
  controller: AbortController;
  noticeMessage: string;
}

type ResolutionViewState = 'matching' | 'already' | 'settled' | 'released'
  | 'pending' | 'not_recorded' | 'changed' | 'idle';

export interface ResolutionView {
  state: ResolutionViewState;
  message: string;
  clearSentCommand: boolean;
}

export function resolutionView(
  detail: EffectDetail,
  sent: SentResolution | undefined,
  checkedAt: string,
): ResolutionView {
  if (detail.resolution && sent?.permitId === detail.permitId) {
    return matchingResolutionView(detail, sent.command);
  }
  if (detail.state === 'settled' || detail.state === 'released') {
    return resolvedView(detail, checkedAt);
  }
  if (detail.state === 'resolution_pending') {
    return {
      state: 'pending', message: 'Recorded. Waiting for the budget to apply it.',
      clearSentCommand: false,
    };
  }
  if (sent?.permitId === detail.permitId) {
    return notRecordedView(detail, sent);
  }
  return {
    state: 'idle', message: `No new evidence (checked ${checkedAt}). The hold stays.`,
    clearSentCommand: false,
  };
}

function matchingResolutionView(
  detail: EffectDetail,
  command: ResolutionCommand,
): ResolutionView {
  const resolution = detail.resolution;
  if (!resolution) throw new Error('Missing resolution');
  if (!resolutionMatches(resolution, command)) {
    const outcome = resolutionWord(resolution.outcome);
    return {
      state: 'already',
      message: `This hold was already resolved: ${outcome} `
        + `${money(resolution.settledCents)}. Your resolution was not applied.`,
      clearSentCommand: true,
    };
  }
  if (detail.state === 'resolution_pending') {
    return {
      state: 'pending',
      message: 'A resolution matching yours is recorded. Waiting for the budget to apply it.',
      clearSentCommand: true,
    };
  }
  if (detail.state === 'settled' || detail.state === 'released') {
    const outcome = resolutionWord(detail.state);
    return {
      state: detail.state,
      message: `A resolution matching yours is recorded. ${outcome} `
        + `${money(resolution.settledCents)} for ${detail.permitId}.`,
      clearSentCommand: true,
    };
  }
  return {
    state: 'matching', message: 'A resolution matching yours is recorded. The hold stays reserved.',
    clearSentCommand: true,
  };
}

function resolvedView(detail: EffectDetail, checkedAt: string): ResolutionView {
  const outcome = detail.state === 'settled' ? 'settled' : 'released';
  const amount = detail.settledCents ?? 0;
  let message = `${resolutionWord(outcome)} ${money(amount)} for ${detail.permitId}. `
    + `Checked ${checkedAt}.`;
  if (detail.state === 'settled' && amount > detail.reservedCents) {
    message += ` Settled ${money(amount)} (${amount} cents). This is more than the `
      + `${money(detail.reservedCents)} hold. The full amount is recorded.`;
  }
  return { state: outcome, message, clearSentCommand: true };
}

function notRecordedView(detail: EffectDetail, sent: SentResolution): ResolutionView {
  if (detail.sequence === sent.expectedSequence) {
    return {
      state: 'not_recorded', message: 'Not recorded. Nothing changed.', clearSentCommand: true,
    };
  }
  return {
    state: 'changed',
    message: 'The evidence changed while you were reviewing. Refresh and review again.',
    clearSentCommand: true,
  };
}

function resolutionMatches(
  resolution: NonNullable<EffectDetail['resolution']>,
  command: ResolutionCommand,
): boolean {
  return resolution.outcome === command.outcome
    && resolution.settledCents === command.settledCents
    && evidenceMatches(resolution.evidence, command.evidence);
}

// Compare named fields so harmless object key order changes do not change the receipt.
function evidenceMatches(
  recorded: Array<Record<string, string | number | boolean>>,
  command: ResolutionCommand['evidence'],
): boolean {
  if (recorded.length !== command.length) return false;
  for (let index = 0; index < recorded.length; index += 1) {
    if (!evidenceEntryMatches(recorded[index]!, command[index]!)) return false;
  }
  return true;
}

function evidenceEntryMatches(
  recorded: Record<string, string | number | boolean>,
  command: Record<string, string | number | boolean>,
): boolean {
  const recordedKeys = Object.keys(recorded);
  const commandKeys = Object.keys(command);
  if (recordedKeys.length !== commandKeys.length) return false;
  for (const key of recordedKeys) {
    if (recorded[key] !== command[key]) return false;
  }
  return true;
}

export function resolutionWord(outcome: 'settled' | 'released'): string {
  if (outcome === 'settled') return 'Settled';
  return 'Released';
}

export function needsReview(effect: EffectStatus): boolean {
  return effect.state === 'outcome_unknown'
    && (effect.reasons.length > 0 || effect.conflict);
}

export function isRecordedNotApplied(effect: EffectStatus): boolean {
  return effect.state === 'resolution_pending';
}

export function waitingForUsage(effect: EffectStatus): boolean {
  return effect.state === 'outcome_unknown'
    && effect.reasons.length === 0 && !effect.conflict;
}

export function recordedAmounts(effect: EffectStatus): number[] {
  const amounts = new Set<number>();
  for (const observation of effect.observations) amounts.add(observation.costCents);
  return Array.from(amounts);
}

export function canResolve(effect: EffectStatus): boolean {
  return needsReview(effect) && !effect.conflict && effect.resolution === null
    && recordedAmounts(effect).length <= 1;
}

export function canRelease(effect: EffectStatus): boolean {
  if (!canResolve(effect)) return false;
  return effect.observations.every(hasNoCost);
}

function hasNoCost(observation: EffectStatus['observations'][number]): boolean {
  return observation.costCents === 0;
}

export function parseCents(text: string): number | undefined {
  const value = text.trim();
  if (!/^(0|[1-9]\d*)$/u.test(value)) return undefined;
  const cents = Number(value);
  if (!Number.isSafeInteger(cents)) return undefined;
  return cents;
}

export function validReference(text: string): boolean {
  return /^[\w-]{1,200}$/u.test(text.trim());
}

export function normaliseDigest(text: string): string | undefined {
  const digest = text.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(digest)) return undefined;
  return digest;
}

export function utcDateTime(value: string): string {
  const date = new Date(value);
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'UTC', hourCycle: 'h23',
  }).format(date) + ' UTC';
}

export function utcClockTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hourCycle: 'h23',
  }).format(date) + ' UTC';
}

export function monthPeriod(value: string): string {
  const date = new Date(value);
  const month = new Intl.DateTimeFormat('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(date);
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const reset = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(nextMonth);
  return `${month} · resets ${reset}, 00:00 UTC`;
}

function reasonLabel(reason: EffectStatus['reasons'][number]): string {
  const labels: Record<EffectStatus['reasons'][number], string> = {
    settle_timeout: '? Final usage not received',
    computer_lost: '? Computer lost',
    unknown_tariff: '? No price for this model revision',
    missing_usage: '? Usage record missing',
    transport_failure: '? Reply lost in transit',
  };
  return labels[reason];
}

export function reasons(effect: EffectStatus): string[] {
  const labels: string[] = [];
  for (const reason of effect.reasons) labels.push(reasonLabel(reason));
  if (effect.conflict) labels.push('⚠ Conflicting evidence');
  if (labels.length === 0) labels.push('✓ No hold reason');
  return labels;
}
