import { expect, it } from 'vitest';
import { getEventDefinition, toolCredentialReleaseSchema } from '../src/index.ts';
import { toolCredentialReleaseExample } from '../src/credential-release.ts';

function normalRelease() {
  const schema = getEventDefinition('credential.released')!.dataSchema;
  expect(schema.parse(toolCredentialReleaseExample)).toEqual(toolCredentialReleaseExample);
  for (const field of Object.keys(toolCredentialReleaseExample)) {
    const missing = { ...toolCredentialReleaseExample };
    Reflect.deleteProperty(missing, field);
    expect(schema.safeParse(missing).success, field).toBe(false);
  }
}
it('requires every normal-call binding in the registry example', normalRelease);

function legacyRelease() {
  const legacy = { requestId: 'request', permitId: 'permit', connectionId: 'connection',
    profileId: 'profile', leaseId: 'lease', generation: 1 };
  expect(getEventDefinition('credential.released')!.dataSchema.parse(legacy)).toEqual(legacy);
  expect(toolCredentialReleaseSchema.safeParse(legacy).success).toBe(false);
}
it('keeps legacy audit readable without accepting it as a bound release', legacyRelease);

function strictRelease(patch: Record<string, unknown>) {
  const input = { ...toolCredentialReleaseExample, ...patch };
  expect(getEventDefinition('credential.released')!.dataSchema.safeParse(input).success).toBe(false);
}
it.each([{ purpose: 'discovery' }, { purpose: 'identity_check' }, { ownerKind: 'company' },
  { generation: 0 }, { expiresAt: 1.5 }, { credential: 'private-secret-canary' },
  { arguments: 'private-secret-canary' }, { workerId: 'worker' }])(
  'refuses incomplete or out-of-scope release data %j', strictRelease);
