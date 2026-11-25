export type PackageModels = { mode: 'stub' | 'provider'; qualification?: boolean };

export function backupProviderMode(environment: NodeJS.ProcessEnv) {
  return environment['BACKUP_PROVIDER_MODE'] === 'true';
}

export const qualificationUpstream = 'model-qualification:43003';

type SecretData = { data?: Record<string, string> };

export function modelRuntimeSettings(models: PackageModels | undefined) {
  const settings: Record<string, string> = {
    MODEL_DECISION_URL: 'http://server:43001',
    MODEL_STATE_DIR: '/var/lib/opencrane/models',
    MODEL_JWKS_FILE: '/run/opencrane/files/model-jwks.json',
    AGENTGATEWAY_BINARY: '/usr/local/bin/agentgateway',
    MODEL_GATEWAY_PORT: '43000',
    MODEL_DECISION_PORT: '43001',
    MODEL_READINESS_PORT: '43002',
    MODEL_GATEWAY_CONTROL_PORT: '43004',
  };
  if (models?.qualification) {
    settings['MODEL_UPSTREAM'] = qualificationUpstream;
  }
  if (models?.mode !== 'provider') {
    settings['MODEL_KEY_FILE'] = '/run/opencrane/files/model-stub-key';
    settings['MODEL_UPSTREAM'] = '127.0.0.1:43003';
    settings['MODEL_STUB_PORT'] = '43003';
    settings['MODEL_STUB_MCP_GENERATION'] = 'local-package';
    settings['MODEL_STUB_MCP_REVISION'] = 'local-package';
  }
  return settings;
}

export function checkModelSecrets(name: string, stored: SecretData,
  models: PackageModels | undefined) {
  if (name !== 'runtime' && name !== 'runtimeFiles') {
    return;
  }
  const data = stored.data ?? {};
  if (models?.mode === 'provider') {
    for (const key of Object.keys(data)) {
      if (key === 'MODEL_UPSTREAM' && models.qualification) {
        const upstreamBytes = Buffer.from(data[key]!, 'base64');
        const upstream = upstreamBytes.toString('utf8');
        if (upstream === qualificationUpstream) continue;
      }
      if (key === 'MODEL_UPSTREAM' || key === 'MODEL_KEY_FILE' ||
          key.startsWith('MODEL_STUB_') || key === 'model-stub-key' ||
          key === 'model-qualification-key') {
        throw new Error('Provider mode refuses stand-in settings');
      }
    }
    if (name === 'runtime' && models.qualification) {
      requirePackageProviderDestination({
        PACKAGE_PROVIDER_MODE: '1', PACKAGE_PROVIDER_QUALIFICATION: '1',
        MODEL_UPSTREAM: Buffer.from(data['MODEL_UPSTREAM'] ?? '', 'base64').toString('utf8'),
        DEV_REAL_PROVIDER: data['DEV_REAL_PROVIDER'],
      });
    }
    return;
  }
  const requiredKeys = name === 'runtime' ? ['MODEL_UPSTREAM', 'MODEL_KEY_FILE'] : ['model-stub-key'];
  for (const key of requiredKeys) {
    if (!data[key]) {
      throw new Error(`Required secret field is absent: ${name}.${key}`);
    }
  }
  if (name === 'runtime') {
    const upstream = Buffer.from(data['MODEL_UPSTREAM']!, 'base64').toString('utf8');
    if (upstream !== '127.0.0.1:43003') {
      throw new Error('The package model must use its local stub');
    }
  }
}

export function requirePackageProviderDestination(environment: NodeJS.ProcessEnv) {
  if (environment['PACKAGE_PROVIDER_QUALIFICATION'] !== '1') return;
  if (environment['PACKAGE_PROVIDER_MODE'] !== '1' ||
      environment['MODEL_UPSTREAM'] !== qualificationUpstream ||
      environment['MODEL_KEY_FILE'] !== undefined || environment['DEV_REAL_PROVIDER'] !== undefined) {
    throw new Error('Package qualification requires its separate stand-in');
  }
}
