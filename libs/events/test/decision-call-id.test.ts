import { expect, it } from 'vitest';
import { decisionRecordedDataSchema } from '../src/index.ts';

const decision = { requestId: 'request', route: 'mcp', outcome: 'deny',
  reason: 'request_refused', contextDigest: 'a'.repeat(64) };
const unsafeCallIds = ['call\u0000', 'call\u202e'];

function refusesUnsafeCallId(callId: string) {
  const data = { ...decision, callId };
  expect(decisionRecordedDataSchema.safeParse(data).success).toBe(false);
}
it.each(unsafeCallIds)('refuses unsafe call id %j before storing a decision', refusesUnsafeCallId);

const supportedCallIds = [undefined, 'call_1', 'c'.repeat(200)];

function acceptsSupportedCallId(callId: string | undefined) {
  const data = { ...decision, callId };
  expect(decisionRecordedDataSchema.safeParse(data).success).toBe(true);
}
it.each(supportedCallIds)('accepts a safe call id or an older decision without one: %j',
  acceptsSupportedCallId);
