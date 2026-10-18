export function modelsEnvironment(settings: Record<string, string>, directory: string,
  managed: boolean): Record<string, string> {
  const environment: Record<string, string> = { ...settings, PROVIDER_SECRETS_DIR: `${directory}/provider-secrets` };
  delete environment['MODEL_KEY_FILE'];
  if (!managed) {
    environment['MODEL_KEY_FILE'] = `${directory}/model-stub-key`;
  }
  return environment;
}
