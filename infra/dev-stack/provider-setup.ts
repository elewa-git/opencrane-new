import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { encodeSession, loadAuthConfig } from '@opencrane/auth';
import { modelForTask } from '@opencrane/models';
import { authEnv, directory, root } from './config.ts';

type SetupOptions = {
  server: string; origin: string; cookie: string; silo: string; value: string; real?: boolean;
};
const operations: Record<string, string> = {
  create: 'provider.created', save: 'provider.key_saved',
  reachability: 'provider.verification_requested', test: 'provider.verification_requested',
  models: 'provider.models_selected', default: 'provider.model_binding_set',
  drain: 'provider.managed_calls_drain_set', 'switch-on': 'provider.managed_calls_enabled',
};
type Reply = {
  operation?: string;
  revision: number; sequence: number; expectedProviderSequence: number;
  priceTableId: string; reservedCents: number;
  rows?: Array<{ kind: string; position: number }>;
  projection?: { content: string; iam: string }; outcome?: string;
};

export async function setupProvider(options: SetupOptions) {
  const providerId = options.real ? 'dev-openai' : 'dev-stub';
  const name = options.real ? 'OpenAI demo' : 'Local model stub';
  const route = `/api/org/providers/${providerId}`;
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
    let receipt: Reply | undefined;
    try {
      receipt = await request(step, path, command);
    } catch (error) {
      if (!(error instanceof Error) || !/unavailable|invalid|50[0234]$/u.test(error.message)) {
        throw error;
      }
      // Read the original command after a lost reply. Never submit an unknown write again.
    }
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const current = await request(step, `${route}/changes/${commandId}`);
      if (verify && current.outcome && current.outcome !== 'pass') {
        throw new Error(`Provider setup ${step}: refused`);
      }
      if (current.projection?.content === 'current' && current.projection.iam === 'current' &&
          (!verify || current.outcome === 'pass')) {
        if (!receipt && current.operation !== operations[step]) {
          throw new Error(`Provider setup ${step}: unknown`);
        }
        return receipt ?? current;
      }
      await delay(100);
    }
    throw new Error(`Provider setup ${step}: timeout`);
  }
  const created = await save('create', '/api/org/providers', {
    action: 'create', providerId, expectedRevision: 0,
    provider: 'openai', name,
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
    action: 'models', providerId, expectedRevision: saved.revision, models: enabledModels,
  });
  function isDefault(row: { kind: string }) {
    return row.kind === 'silo_default';
  }
  async function seededDefault() {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      let bindings: Reply;
      try {
        bindings = await request('bindings', `${route}/bindings`);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Provider setup bindings: 503') {
          throw error;
        }
        await delay(100);
        continue;
      }
      const previous = bindings.rows?.find(isDefault);
      if (previous) return { bindings, previous };
      await delay(100);
    }
    throw new Error('Provider setup default: timeout');
  }
  // Wait for the default scheduled by model selection before making the owner's choice.
  const { bindings, previous } = await seededDefault();
  await save('default', `${route}/bindings`, { action: 'select', kind: 'silo_default',
    dependantId: options.silo, task: 'chat_turn', model, expectedRevision: selected.revision,
    expectedProviderSequence: bindings.expectedProviderSequence,
    expectedBindingSequence: previous.position });
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

export async function setupDevProvider(settings: Record<string, string>, credentialFile?: string) {
  try {
    let value: string;
    if (credentialFile !== undefined) {
      value = (await readFile(credentialFile, 'utf8')).trim();
      if (!/^[\x21-\x7e]{1,4096}$/u.test(value)) {
        throw new Error('Provider setup preparation: unavailable');
      }
    } else {
      value = randomBytes(32).toString('hex');
      await writeFile(`${directory}/model-managed-stub`, value, { mode: 0o600, flag: 'wx' });
    }
    const config = loadAuthConfig(await authEnv());
    const contents = await readFile(`${root}/infra/dev-stack/zitadel.json`, 'utf8');
    const oidc = JSON.parse(contents) as { extraIdentities: Array<{ subject: string }> };
    const now = Math.floor(Date.now() / 1000);
    // Use the same short-lived dev session format as the journey, for the bootstrapped Owner.
    const session = { sub: oidc.extraIdentities[0]!.subject, orgId: config.expectedOrgId!,
      roles: [], authTime: now, exp: now + 300 };
    const cookie = `${config.cookieName}=${encodeSession(config, session)}`;
    const options = { server: `http://127.0.0.1:${settings['SERVER_PORT']}`,
      origin: settings['ORIGIN']!, silo: settings['SILO_ID']!, cookie, value,
      real: credentialFile !== undefined };
    await setupProvider(options);
  } catch (error) {
    // Keep file locations, credentials and remote replies out of startup diagnostics.
    if (error instanceof Error && /^Provider setup [a-z-]+: [a-z0-9]+$/u.test(error.message)) {
      throw error;
    }
    throw new Error('Provider setup preparation: unavailable');
  }
}
