import { describe, expect, it } from 'vitest';
import {
  clientMessageSchema,
  errorMessageSchema,
  eventValidationResultSchema,
  helloEchoSchema,
  helloMessageSchema,
  serverMessageSchema,
} from '../src/messages.ts';

describe('hello message', () => {
  it('accepts a well-formed hello', () => {
    const result = helloMessageSchema.safeParse({ type: 'hello', text: 'hi' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty text', () => {
    const result = helloMessageSchema.safeParse({ type: 'hello', text: '' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field (schema is strict)', () => {
    const result = helloMessageSchema.safeParse({ type: 'hello', text: 'hi', extra: true });
    expect(result.success).toBe(false);
  });
});

describe('hello echo', () => {
  it('requires an ISO timestamp with an offset', () => {
    const good = helloEchoSchema.safeParse({ type: 'hello', text: 'hi', echoedAt: '2026-09-30T10:00:00.000Z' });
    expect(good.success).toBe(true);

    const bad = helloEchoSchema.safeParse({ type: 'hello', text: 'hi', echoedAt: 'not a date' });
    expect(bad.success).toBe(false);
  });
});

describe('error message', () => {
  it('requires a non-empty message', () => {
    const result = errorMessageSchema.safeParse({ type: 'error', message: '' });
    expect(result.success).toBe(false);
  });
});

describe('eventValidationResult', () => {
  it('accepts a failure with a reason', () => {
    const result = eventValidationResultSchema.safeParse({
      type: 'eventValidationResult',
      valid: false,
      reason: 'unknown_event_type',
    });
    expect(result.success).toBe(true);
  });
});

describe('serverMessageSchema', () => {
  it('matches any one of the three server message shapes', () => {
    const hello = serverMessageSchema.safeParse({ type: 'hello', text: 'hi', echoedAt: '2026-09-30T10:00:00.000Z' });
    const error = serverMessageSchema.safeParse({ type: 'error', message: 'oops' });
    const result = serverMessageSchema.safeParse({ type: 'eventValidationResult', valid: true });
    expect(hello.success).toBe(true);
    expect(error.success).toBe(true);
    expect(result.success).toBe(true);
  });

  it('rejects a message that matches none of them', () => {
    const result = serverMessageSchema.safeParse({ type: 'not-a-real-type' });
    expect(result.success).toBe(false);
  });
});

describe('clientMessageSchema', () => {
  it('matches hello and validateEvent, nothing else', () => {
    expect(clientMessageSchema.safeParse({ type: 'hello', text: 'hi' }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: 'validateEvent', event: { any: 'thing' } }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: 'error', message: 'nope' }).success).toBe(false);
  });
});
