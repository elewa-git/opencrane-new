import { expect, it } from 'vitest';
import { effectDetailResponseSchema, effectListResponseSchema } from '../src/effects.ts';

const effect = {
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
    };

it('accepts price table ids that contain a version dot', () => {
  const response = effectListResponseSchema.parse({
    effects: [effect],
  });

  expect(response.effects[0]?.priceTableId).toBe('anthropic-2026.10');
});

const receipt = { changeRef: 'saved-change', eventId: 'saved-event', position: 4,
  time: '2026-10-05T08:01:00.000Z', resolvedBy: 'owner', outcome: 'settled', settledCents: 60 };

function acceptsOriginalReceipt(resolutionReceipt: unknown) {
  const detail = { ...effect, csrf: 'session-check', resolutionReceipt };
  expect(effectDetailResponseSchema.parse(detail)).toEqual(detail);
}
it.each([receipt, null, undefined])('accepts an original detail receipt: %s', acceptsOriginalReceipt);

function refusesUnsafeReceipt(settledCents: number) {
  const resolutionReceipt = { ...receipt, settledCents };
  const detail = { ...effect, csrf: 'session-check', resolutionReceipt };
  expect(effectDetailResponseSchema.safeParse(detail).success).toBe(false);
}
it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe receipt cents: %s',
  refusesUnsafeReceipt);

function refusesPrivateReceiptFields() {
  const resolutionReceipt = { ...receipt, evidence: 'Private evidence canary' };
  const detail = { ...effect, csrf: 'session-check', resolutionReceipt };
  expect(effectDetailResponseSchema.safeParse(detail).success).toBe(false);
}
it('rejects extra private fields in a resolution receipt', refusesPrivateReceiptFields);
