import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { modelForTask } from '@opencrane/models';
import { authEnv, directory, root } from './config.ts';

type SetupOptions = { server: string; origin: string; cookie: string; silo: string; value: string };
type Reply = {
  revision: number; sequence: number; expectedProviderSequence: number;
  priceTableId: string; reservedCents: number;
  rows?: Array<{ kind: string; position: number }>;
  projection?: { content: string; iam: string }; outcome?: string;
};

export async function setupProvider(options: SetupOptions) {
  const route = '/api/org/providers/dev-stub';
  const headers = { origin: options.origin, cookie: options.cookie,
    'content-type': 'application/json' };
  async function request(step: string, path: string, input?: Record<string, unknown>) {
    const init = { headers, method: input ? 'POST' : 'GET',
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: AbortSignal.timeout(30_000), redirect: 'error' as const };
    let response: Response;
    try {
      response = await fetch(`${options.server}${path}`, init);
    } catch {
      throw new Error(`Provider setup ${step}: unavailable`);
    }
    if (!response.ok) {
      throw new Error(`Provider setup ${step}: ${response.status}`);
    }
    try {
      return await response.json() as Reply;
    } catch {
      throw new Error(`Provider setup ${step}: invalid`);
    }
  }
  async function save(step: string, path: string, input: Record<string, unknown>, verify = false) {
    const commandId = randomUUID();
    const command = { ...input, commandId };
    const receipt = await request(step, path, command);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = await request(step, `${route}/changes/${commandId}`);
      if (verify && current.outcome && current.outcome !== 'pass') {
        throw new Error(`Provider setup ${step}: refused`);
      }
      if (current.projection?.content === 'current' && current.projection.iam === 'current' &&
          (!verify || current.outcome === 'pass')) {
        return receipt;
      }
      await delay(100);
    }
    throw new Error(`Provider setup ${step}: timeout`);
  }
  const created = await save('create', '/api/org/providers', {
    action: 'create', providerId: 'dev-stub', expectedRevision: 0,
    provider: 'openai', name: 'Local model stub',
  });
  const saved = await save('save', `${route}/key`, {
    expectedRevision: created.revision, key: options.value,
  });
  await save('reachability', `${route}/verify`, {
    expectedRevision: saved.revision, action: 'reachability',
  }, true);
  const model = modelForTask('chat_turn');
  const quote = await request('quote', `${route}/verify?model=${encodeURIComponent(model)}`);
  await save('test', `${route}/verify`, { expectedRevision: saved.revision, action: 'test',
    model, priceTableId: quote.priceTableId, reservedCents: quote.reservedCents, consent: true }, true);
  const enabledModels = [...new Set([model, 'gpt-6-luna'])];
  const selected = await save('models', '/api/org/providers', {
    action: 'models', providerId: 'dev-stub', expectedRevision: saved.revision, models: enabledModels,
  });
  const bindings = await request('bindings', `${route}/bindings`);
  function isDefault(row: { kind: string }) {
    return row.kind === 'silo_default';
  }
  const previous = bindings.rows?.find(isDefault);
  await save('default', `${route}/bindings`, { action: 'select', kind: 'silo_default',
    dependantId: options.silo, task: 'chat_turn', model, expectedRevision: selected.revision,
    expectedProviderSequence: bindings.expectedProviderSequence,
    expectedBindingSequence: previous?.position ?? 0 });
  function positions(status: Reply) {
    return { expectedRevision: status.revision,
      expectedProviderSequence: status.expectedProviderSequence,
      expectedDrainSequence: status.sequence };
  }
  const before = await request('drain', `${route}/drain`);
  await save('drain', `${route}/drain`, { ...positions(before), action: 'start' });
  const drained = await request('drain', `${route}/drain`);
  await save('switch-on', `${route}/switch-on`, positions(drained));
}

export async function setupDevProvider(settings: Record<string, string>) {
  try {
    const config = loadAuthConfig(await authEnv());
    const contents = await readFile(`${root}/infra/dev-stack/zitadel.json`, 'utf8');
    const oidc = JSON.parse(contents) as { extraIdentities: Array<{ subject: string }> };
    const now = Math.floor(Date.now() / 1000);
    // Use the same short-lived dev session format as the journey, for the bootstrapped Owner.
    const session = { sub: oidc.extraIdentities[0]!.subject, orgId: config.expectedOrgId!,
      roles: [], authTime: now, exp: now + 300 };
    const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
    const value = randomBytes(32).toString('hex');
    await writeFile(`${directory}/model-managed-stub`, value, { mode: 0o600, flag: 'wx' });
    const options = { server: `http://127.0.0.1:${settings['SERVER_PORT']}`,
      origin: settings['ORIGIN']!, silo: settings['SILO_ID']!, cookie, value };
    await setupProvider(options);
  } catch (error) {
    // Keep file locations, credentials and remote replies out of startup diagnostics.
    if (error instanceof Error && /^Provider setup [a-z-]+: [a-z0-9]+$/u.test(error.message)) {
      throw error;
    }
    throw new Error('Provider setup preparation: unavailable');
  }
}
