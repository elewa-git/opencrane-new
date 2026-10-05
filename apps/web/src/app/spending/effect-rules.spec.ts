import type { EffectStatus } from '@opencrane/protocol';
import {
  canRelease, canResolve, needsReview, normaliseDigest, parseCents, recordedAmounts,
  validReference, waitingForUsage,
} from './effect-rules';

function effect(overrides: Partial<EffectStatus> = {}): EffectStatus {
  return {
    permitId: 'permit-1', reservationId: 'permit-1', reservedAt: '2026-10-05T00:00:00.000Z',
    reservedCents: 120, settledCents: null, model: 'model-a', priceTableId: 'prices-1',
    sequence: 1, state: 'outcome_unknown', label: 'Outcome unknown', conflict: false, reasons: [],
    observations: [], resolution: null,
    ...overrides,
  };
}

it('keeps running calls out of review until the server records a reason or conflict', () => {
  const running = effect();
  expect(needsReview(running)).toBe(false);
  expect(waitingForUsage(running)).toBe(true);
  expect(needsReview(effect({ reasons: ['settle_timeout'] }))).toBe(true);
  expect(needsReview(effect({ conflict: true }))).toBe(true);
});

it('blocks resolution when observations disagree or a resolution is already recorded', () => {
  const records = [
    { eventId: 'event-1', outcome: 'success' as const, costCents: 120 },
    { eventId: 'event-2', outcome: 'success' as const, costCents: 180 },
  ];
  expect(recordedAmounts(effect({ reasons: ['settle_timeout'], observations: records }))).toEqual([120, 180]);
  expect(canResolve(effect({ reasons: ['settle_timeout'], observations: records }))).toBe(false);
  expect(canResolve(effect({ reasons: ['settle_timeout'], resolution: {
    outcome: 'settled', settledCents: 120, evidence: [],
  } }))).toBe(false);
});

it('allows release only when no recorded observation has a cost', () => {
  const free = effect({ reasons: ['transport_failure'], observations: [
    { eventId: 'event-1', outcome: 'error', costCents: 0 },
  ] });
  const charged = effect({ reasons: ['transport_failure'], observations: [
    { eventId: 'event-1', outcome: 'error', costCents: 1 },
  ] });
  expect(canRelease(free)).toBe(true);
  expect(canRelease(charged)).toBe(false);
});

it.each(['1.2', '1e3', '0x10', '-1', '01', '', '9007199254740992'])(
  'rejects invalid cents text %s', (text) => {
    expect(parseCents(text)).toBeUndefined();
  },
);

it.each(['0', '120'])(
  'accepts whole cents text %s', (text) => {
    expect(parseCents(text)).toBe(Number(text));
  },
);

it('normalises digest text and rejects the wrong length', () => {
  expect(normaliseDigest('A'.repeat(64))).toBe('a'.repeat(64));
  expect(normaliseDigest('a'.repeat(63))).toBeUndefined();
  expect(normaliseDigest('a'.repeat(65))).toBeUndefined();
});

it('accepts only the structured reference shape', () => {
  expect(validReference(' receipt-1 ')).toBe(true);
  expect(validReference('receipt one')).toBe(false);
});
