import { hostedCredentialContractSchema, startupCredentialContractSchema }
  from '@opencrane/events';

export function startupContractRejection(locator: string, raw: unknown) {
  const declared = hostedCredentialContractSchema.safeParse(raw);
  if (!declared.success) return 'startup_contract_unverified';
  const contract = declared.data;
  if (contract.credentialMode === 'startup_lasting' || contract.delivery === 'environment' ||
      contract.materialKind === 'raw_bearer') {
    return 'lasting_startup_secret_required';
  }
  if (contract.credentialMode === 'per_call') return undefined;
  const checked = startupCredentialContractSchema.safeParse(contract);
  if (!checked.success) return 'startup_contract_unverified';
  const expectedSuffix = `@sha256:${checked.data.imageDigest}`;
  if (!locator.endsWith(expectedSuffix)) return 'startup_contract_unverified';
  return undefined;
}
