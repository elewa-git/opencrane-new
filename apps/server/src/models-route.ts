import { resolve } from 'node:path';

export function modelGatewayRoute(managedCalls: boolean,
  providerSecretDirectory: string | undefined, keyFile: string | undefined):
  { managedCalls: true } | { keyFile: string } {
  // Prepare the managed route before setup. Admission still needs recorded switch-on.
  const providerOnly = providerSecretDirectory !== undefined && keyFile === undefined;
  if (managedCalls || providerOnly) {
    if (keyFile !== undefined) {
      throw new Error('A fallback key file is still configured after switch-on');
    }
    if (!providerSecretDirectory) {
      throw new Error('Provider custody is required after switch-on');
    }
    return { managedCalls: true };
  }
  const legacyKeyFile = keyFile ?? resolve(import.meta.dirname, '../../../.keys/.openai-key');
  return { keyFile: legacyKeyFile };
}
