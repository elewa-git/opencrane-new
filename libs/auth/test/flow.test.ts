import { describe, expect, it } from 'vitest';
import { decodeFlow, encodeFlow, FlowInvalidError, FLOW_MAX_AGE_SECONDS, type FlowData } from '../src/flow.ts';
import { replaceInCiphertext, tamperCookie, testAuthConfig, truncateAuthTag } from './fixtures.ts';

const config = testAuthConfig();
const now = new Date('2026-09-30T12:00:00.000Z');
const nowSeconds = Math.floor(now.getTime() / 1000);

function validFlow(overrides: Partial<FlowData> = {}): FlowData {
  return { state: 'state-1', nonce: 'nonce-1', codeVerifier: 'verifier-1', returnTo: '/dashboard', createdAt: nowSeconds, ...overrides };
}

describe('login-flow cookie', () => {
  it('round-trips flow state through encode and decode', () => {
    const flow = validFlow();
    expect(decodeFlow(config, encodeFlow(config, flow), now)).toEqual(flow);
  });

  it('rejects a tampered flow cookie', () => {
    const cookieValue = encodeFlow(config, validFlow());
    expect(() => decodeFlow(config, tamperCookie(cookieValue), now)).toThrow(FlowInvalidError);
  });

  it('rejects a forged cookie that turns state "state-1" into "state-2" (valid JSON, valid schema)', () => {
    const flow = validFlow();
    const forged = replaceInCiphertext(encodeFlow(config, flow), JSON.stringify(flow), '"state-1"', '"state-2"');
    expect(() => decodeFlow(config, forged, now)).toThrow(FlowInvalidError);
  });

  it('rejects a flow cookie whose authentication tag has been cut down to 4 bytes', () => {
    const cookieValue = encodeFlow(config, validFlow());
    expect(() => decodeFlow(config, truncateAuthTag(cookieValue, 4), now)).toThrow(FlowInvalidError);
  });

  it('rejects a flow cookie after the OIDC issuer changes, even with the same cookie secret', () => {
    const cookieValue = encodeFlow(config, validFlow());
    const otherConfig = testAuthConfig({ issuerUrl: 'https://a-different-idp.example.test' });
    expect(() => decodeFlow(otherConfig, cookieValue, now)).toThrow(FlowInvalidError);
  });

  it('rejects a flow older than the login window', () => {
    const cookieValue = encodeFlow(config, validFlow({ createdAt: nowSeconds - FLOW_MAX_AGE_SECONDS - 1 }));
    expect(() => decodeFlow(config, cookieValue, now)).toThrow(FlowInvalidError);
  });

  it('accepts a flow right at the edge of the login window', () => {
    const cookieValue = encodeFlow(config, validFlow({ createdAt: nowSeconds - FLOW_MAX_AGE_SECONDS }));
    expect(() => decodeFlow(config, cookieValue, now)).not.toThrow();
  });
});
