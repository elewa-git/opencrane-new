import { describe, expect, it } from 'vitest';
import { loadAuthConfig } from '../src/config.ts';

const requiredEnv = {
  OIDC_ISSUER_URL: 'https://idp.example.test',
  OIDC_CLIENT_ID: 'my-client',
  OIDC_REDIRECT_URI: 'https://app.example.test/auth/callback',
  OIDC_COOKIE_SECRET: 'a'.repeat(32),
};

describe('loadAuthConfig', () => {
  it('lists every missing required variable', () => {
    expect(() => loadAuthConfig({})).toThrowError(/OIDC_ISSUER_URL.*OIDC_CLIENT_ID.*OIDC_REDIRECT_URI.*OIDC_COOKIE_SECRET/s);
  });

  it('applies defaults when only the required variables are set', () => {
    const config = loadAuthConfig(requiredEnv);
    expect(config).toMatchObject({
      issuerUrl: requiredEnv.OIDC_ISSUER_URL,
      clientId: requiredEnv.OIDC_CLIENT_ID,
      scopes: 'openid profile email',
      cookieName: 'oc_session',
      cookieSecure: true,
      sessionMaxAgeSeconds: 12 * 60 * 60,
      flowCookieName: 'oc_auth_flow',
      orgClaim: 'org_id',
      rolesClaim: 'roles',
      extraIdentities: [],
      stepUpMaxAgeSeconds: 5 * 60,
      allowInsecureRequests: false,
    });
    expect(config.clientSecret).toBeUndefined();
    expect(config.expectedOrgId).toBeUndefined();
  });

  it('reads the step-up window and the expected organisation', () => {
    const config = loadAuthConfig({ ...requiredEnv, OIDC_STEP_UP_MAX_AGE_SECONDS: '90', OIDC_EXPECTED_ORG_ID: 'org-9' });
    expect(config.stepUpMaxAgeSeconds).toBe(90);
    expect(config.expectedOrgId).toBe('org-9');
  });

  it('reads exact issuer and subject exceptions from JSON', () => {
    const extraIdentities = [{ issuer: 'https://idp.example.test', subject: 'owner-1' }];
    const config = loadAuthConfig({ ...requiredEnv, OIDC_EXTRA_IDENTITIES: JSON.stringify(extraIdentities) });
    expect(config.extraIdentities).toEqual(extraIdentities);
  });

  it.each(['not-json', '{}', '[{"issuer":"https://idp.example.test","subject":""}]'])('rejects malformed extra identities: %s', (value) => {
    expect(() => loadAuthConfig({ ...requiredEnv, OIDC_EXTRA_IDENTITIES: value })).toThrow();
  });

  describe('pinning sign-in to the silo organisation', () => {
    it('refuses to start in production without OIDC_EXPECTED_ORG_ID, and names the variable', () => {
      expect(() => loadAuthConfig({ ...requiredEnv, NODE_ENV: 'production' })).toThrowError(
        /missing required OIDC configuration: OIDC_EXPECTED_ORG_ID; OIDC_EXPECTED_ORG_ID is required when NODE_ENV=production/,
      );
    });

    it.each([['an empty value', ''], ['only spaces', '   ']])('treats %s as not set in production', (_label, value) => {
      expect(() => loadAuthConfig({ ...requiredEnv, NODE_ENV: 'production', OIDC_EXPECTED_ORG_ID: value })).toThrow(/OIDC_EXPECTED_ORG_ID/);
    });

    it.each(['Production', ' PRODUCTION '])('still counts NODE_ENV=%j as production', (nodeEnv) => {
      expect(() => loadAuthConfig({ ...requiredEnv, NODE_ENV: nodeEnv })).toThrow(/OIDC_EXPECTED_ORG_ID/);
    });

    it('lists the pin together with any other missing variable, so one failure shows everything to fix', () => {
      expect(() => loadAuthConfig({ NODE_ENV: 'production' })).toThrowError(/OIDC_ISSUER_URL.*OIDC_COOKIE_SECRET, OIDC_EXPECTED_ORG_ID/s);
    });

    it('starts in production when OIDC_EXPECTED_ORG_ID is set, and keeps the value', () => {
      const config = loadAuthConfig({ ...requiredEnv, NODE_ENV: 'production', OIDC_EXPECTED_ORG_ID: ' org-9 ' });
      expect(config.expectedOrgId).toBe('org-9');
    });

    it.each([undefined, 'development', 'test'])('still starts without OIDC_EXPECTED_ORG_ID when NODE_ENV is %j', (nodeEnv) => {
      const config = loadAuthConfig({ ...requiredEnv, ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) });
      expect(config.expectedOrgId).toBeUndefined();
    });
  });

  it('rejects a cookie secret shorter than 32 bytes', () => {
    expect(() => loadAuthConfig({ ...requiredEnv, OIDC_COOKIE_SECRET: 'too-short' })).toThrow(/at least 32 bytes/);
  });

  it('resolves the client secret through the named env var, never a direct value', () => {
    const config = loadAuthConfig({
      ...requiredEnv,
      OIDC_CLIENT_SECRET_ENV_VAR: 'ZITADEL_CLIENT_SECRET',
      ZITADEL_CLIENT_SECRET: 'the-real-secret',
    });
    expect(config.clientSecret).toBe('the-real-secret');
  });

  it('rejects a client secret env var name that points at nothing', () => {
    expect(() => loadAuthConfig({ ...requiredEnv, OIDC_CLIENT_SECRET_ENV_VAR: 'MISSING_VAR' })).toThrow(/MISSING_VAR/);
  });

  it('reads booleans and numbers from their own variables', () => {
    const config = loadAuthConfig({
      ...requiredEnv,
      OIDC_COOKIE_SECURE: 'false',
      OIDC_SESSION_MAX_AGE_SECONDS: '900',
      OIDC_ORG_CLAIM: 'tenant',
      OIDC_ROLES_CLAIM: 'permissions',
    });
    expect(config.cookieSecure).toBe(false);
    expect(config.sessionMaxAgeSeconds).toBe(900);
    expect(config.orgClaim).toBe('tenant');
    expect(config.rolesClaim).toBe('permissions');
  });

  it('rejects an unrecognised OIDC_COOKIE_SECURE value instead of silently turning Secure off', () => {
    // A typo like "flase" must never silently disable a security default.
    expect(() => loadAuthConfig({ ...requiredEnv, OIDC_COOKIE_SECURE: 'flase' })).toThrow(/OIDC_COOKIE_SECURE/);
  });

  it('rejects an unrecognised OIDC_ALLOW_INSECURE_REQUESTS value', () => {
    expect(() => loadAuthConfig({ ...requiredEnv, OIDC_ALLOW_INSECURE_REQUESTS: 'nope' })).toThrow(/OIDC_ALLOW_INSECURE_REQUESTS/);
  });

  it('ignores a plain OIDC_CLIENT_SECRET variable: the secret is only ever read through the named indirection', () => {
    // Only OIDC_CLIENT_SECRET_ENV_VAR (the NAME of the variable holding the
    // secret) is read. A variable literally called OIDC_CLIENT_SECRET is not.
    const config = loadAuthConfig({ ...requiredEnv, OIDC_CLIENT_SECRET: 'a-direct-value-that-must-be-ignored' });
    expect(config.clientSecret).toBeUndefined();
  });
});
