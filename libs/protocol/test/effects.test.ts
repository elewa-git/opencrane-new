import { expect, it } from 'vitest';
import { effectListResponseSchema } from '../src/effects.ts';

it('accepts price table ids that contain a version dot', () => {
  const response = effectListResponseSchema.parse({
    effects: [{
      permitId: 'permit-1',
      reservationId: 'permit-1',
      reservedAt: '2026-10-05T08:00:00.000Z',
      reservedCents: 120,
      settledCents: null,
      model: 'model-a',
      priceTableId: 'anthropic-2026.10',
      sequence: 3,
      state: 'outcome_unknown',
      label: 'Outcome unknown',
      conflict: false,
      reasons: ['settle_timeout'],
      observations: [],
      resolution: null,
    }],
  });

  expect(response.effects[0]?.priceTableId).toBe('anthropic-2026.10');
});
