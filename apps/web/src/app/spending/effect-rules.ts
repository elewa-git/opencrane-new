import type { EffectStatus } from '@opencrane/protocol';

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
  return needsReview(effect) && effect.resolution === null && recordedAmounts(effect).length <= 1;
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

export function reasonLabel(reason: EffectStatus['reasons'][number]): string {
  const labels: Record<EffectStatus['reasons'][number], string> = {
    settle_timeout: '? Final usage not received',
    computer_lost: '? Computer lost',
    unknown_tariff: '? No price for this model revision',
    missing_usage: '? Usage record missing',
    transport_failure: '? Reply lost in transit',
  };
  return labels[reason];
}
