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
