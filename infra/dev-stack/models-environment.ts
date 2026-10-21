export function modelsEnvironment(settings: Record<string, string>, directory: string,
  managed: boolean, real = false): Record<string, string> {
  const environment: Record<string, string> = { ...settings, PROVIDER_SECRETS_DIR: `${directory}/provider-secrets` };
  delete environment['MODEL_KEY_FILE'];
  delete environment['DEV_REAL_PROVIDER'];
  if (real) {
    delete environment['MODEL_UPSTREAM'];
    environment['DEV_REAL_PROVIDER'] = '1';
  }
  if (!managed) {
    environment['MODEL_KEY_FILE'] = `${directory}/model-stub-key`;
  }
  return environment;
}

export function checkProviderMode(settings: Record<string, string>, real: boolean) {
  if ((settings['DEV_REAL_PROVIDER'] === '1') !== real) {
    throw new Error('Provider mode change requires a fresh stack');
  }
}

export function startupCeilings(real: boolean, allowance: string | undefined) {
  if (!real) return { ceilingCents: 20000, dailyCeilingCents: 4000 };
  const cents = Number(allowance ?? '2000');
  if (!Number.isInteger(cents) || cents < 1 || cents > 2000) {
    throw new Error('Invalid demo allowance');
  }
  return { ceilingCents: cents, dailyCeilingCents: cents };
}
