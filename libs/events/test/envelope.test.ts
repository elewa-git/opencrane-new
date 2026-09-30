import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema, unknownEventEnvelopeSchema } from '../src/envelope.ts';
import { z } from 'zod';

describe('eventEnvelopeSchema', () => {
  const validEnvelope = {
    id: 'evt_1',
    type: 'member.joined',
    source: 'opencrane-server',
    time: '2026-09-30T10:00:00.000Z',
    subject: 'member-alice',
    silo: 'acme',
    principal: { id: 'alice', kind: 'human' },
    correlation: { conversation: 'conv_1' },
    data: { hello: 'world' },
  };

  it('accepts a fully-formed envelope', () => {
    const result = unknownEventEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
  });

  it('defaults correlation ids to an empty object when omitted', () => {
    const { correlation: _correlation, ...withoutCorrelation } = validEnvelope;
    const result = unknownEventEnvelopeSchema.parse(withoutCorrelation);
    expect(result.correlation).toEqual({});
  });

  it('allows an event with no principal (e.g. a timer firing)', () => {
    const { principal: _principal, ...withoutPrincipal } = validEnvelope;
    const result = unknownEventEnvelopeSchema.safeParse(withoutPrincipal);
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const { silo: _silo, ...withoutSilo } = validEnvelope;
    const result = unknownEventEnvelopeSchema.safeParse(withoutSilo);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid timestamp', () => {
    const result = unknownEventEnvelopeSchema.safeParse({ ...validEnvelope, time: 'not-a-date' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field (the envelope is strict)', () => {
    const result = unknownEventEnvelopeSchema.safeParse({ ...validEnvelope, extra: 'nope' });
    expect(result.success).toBe(false);
  });

  it('checks data against the schema it was built with', () => {
    const typed = eventEnvelopeSchema(z.object({ count: z.number() }).strict());
    expect(typed.safeParse({ ...validEnvelope, data: { count: 1 } }).success).toBe(true);
    expect(typed.safeParse({ ...validEnvelope, data: { count: 'one' } }).success).toBe(false);
  });
});
