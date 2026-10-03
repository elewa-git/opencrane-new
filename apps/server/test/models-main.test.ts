import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { BudgetActor, envelope, history } from '@opencrane/models';
import { chatCommand } from '../src/chat/commands.ts';
import { conversationKeys } from '../src/chat/keys.ts';
import { turnCommand } from '../src/chat/turns.ts';
import { generateKeyPairSync } from 'node:crypto';
import { tokenIssuer } from '@opencrane/auth';

it.each([undefined, { d: 'not-a-private-key' }, { alg: 'ES384' }, { crv: 'P-384' }, { kty: 'RSA' }, { use: 'enc' }])(
  'starts with actual issuer public JWKS and rejects invalid key patch %j', async patch => {
  const nats = await natsFixture(), dbs = await databases();
  const directory = await mkdtemp(`${tmpdir()}/oc-models-startup-`);
  try {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
    const issuer = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://lifecycle.test/' });
    const jwks = issuer.jwks;
    await writeFile(`${directory}/jwks.json`, JSON.stringify({ keys: jwks.keys.map(key => ({ ...key, ...patch })) }));
    // Stop at binary verification, before the gateway can load any provider credential.
    await writeFile(`${directory}/gateway`, 'deliberately untrusted test binary');
    const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/models-main.ts')], {
      timeout: 20_000,
      env: { ...process.env, ...nats.env(), DATABASE_URL: await dbs.postgres(), SILO_ID: 'test',
        TOKEN_ISSUER: 'https://lifecycle.test/', MODEL_STATE_DIR: directory, MODEL_JWKS_FILE: `${directory}/jwks.json`, MODEL_DECISION_PORT: '0',
        MODEL_GATEWAY_PORT: '0', MODEL_READINESS_PORT: '0', AGENTGATEWAY_BINARY: `${directory}/gateway`,
        OPENFGA_API_URL: 'http://127.0.0.1:1', OPENFGA_STORE_ID: 'test', OPENFGA_MODEL_ID: 'test' },
    }).then(() => '', (error: unknown) => z.object({ stderr: z.string() }).parse(error).stderr);
    expect(result).toContain(patch ? 'ZodError' : 'Gateway digest mismatch');
    expect((await history(nats.store, 'budget-test', 'test')).map(r => r.event.type))
      .toEqual(patch ? [] : ['budget.ceiling_set', 'budget.period_started']);
    if (!patch) expect((await history(nats.store, 'budget-test', 'test'))[0]?.event.data).toMatchObject({ defaultPayingGroupId: 'installation-default' });
  } finally { await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true }); }
}, 40_000);

it.each(['startup', 'migration'] as const)('upgrades an existing budget through %s without changing ceilings and admits personal chat', async mode => {
  const nats = await natsFixture(), dbs = await databases();
  const directory = await mkdtemp(`${tmpdir()}/oc-budget-upgrade-`);
  try {
    const legacy = new BudgetActor(nats.store, 'test');
    await legacy.start(3210, 45678);
    await legacy.configure({ scope: 'paying_group', scopeId: 'sales', ceilingCents: 1234, setBy: 'owner' });
    await legacy.configure({ scope: 'assistant', scopeId: 'personal', ceilingCents: 2345, setBy: 'owner' });
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
    const issuer = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://lifecycle.test/' });
    await writeFile(`${directory}/jwks.json`, JSON.stringify(issuer.jwks));
    await writeFile(`${directory}/gateway`, 'deliberately untrusted test binary');
    const env = { ...process.env, ...nats.env(), DATABASE_URL: await dbs.postgres(), SILO_ID: 'test',
      TOKEN_ISSUER: 'https://lifecycle.test/', MODEL_STATE_DIR: directory, MODEL_JWKS_FILE: `${directory}/jwks.json`, MODEL_DECISION_PORT: '0',
      MODEL_GATEWAY_PORT: '0', MODEL_READINESS_PORT: '0', AGENTGATEWAY_BINARY: `${directory}/gateway`,
      DEFAULT_PAYING_GROUP_ID: 'installation-default',
      OPENFGA_API_URL: 'http://127.0.0.1:1', OPENFGA_STORE_ID: 'test', OPENFGA_MODEL_ID: 'test' };
    for (let restart = 0; restart < 2; restart++) {
      if (mode === 'startup') {
        const result = await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('apps/server/src/models-main.ts')], { timeout: 20_000, env })
          .then(() => '', (error: unknown) => z.object({ stderr: z.string() }).parse(error).stderr);
        expect(result).toContain('Gateway digest mismatch');
      } else await promisify(execFile)(process.execPath, ['--experimental-strip-types', resolve('apps/ops/src/migrate-budget-default.ts')], { timeout: 20_000, env });
    }
    const recovered = new BudgetActor(nats.store, 'test');
    await recovered.start(2000, 20000, 'different-installation-default');
    expect(recovered.state).toMatchObject({ dailyCeilingCents: 3210, ceilingCents: 45678,
      defaultPayingGroupId: 'installation-default', ceilings: legacy.state.ceilings });
    const defaults = (await history(nats.store, 'budget-test', 'test')).filter(row =>
      row.event.type === 'budget.ceiling_set' && z.object({ defaultPayingGroupId: z.string().optional() }).parse(row.event.data).defaultPayingGroupId);
    expect(defaults).toHaveLength(1);
    await nats.store.append({ expectedSequence: 0, event: envelope('test', 'assistant-personal', 'assistant.created', { assistantId: 'personal', ownerId: 'alice', kind: 'personal' }) });
    await nats.store.append({ expectedSequence: 0, event: envelope('test', 'computer-personal', 'computer.ready', { assistantId: 'personal', computerId: 'personal', generation: 1 }) });
    const keys = conversationKeys(directory); keys.provision('test', 'chat');
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'create-chat', conversationId: 'chat', assistantId: 'personal' });
    await chatCommand(nats.store, keys, { silo: 'test', memberId: 'alice' }, { id: 'message', conversationId: 'chat', text: 'Hello' });
    expect(await turnCommand(nats.store, { silo: 'test', assistantId: 'personal', computerId: 'personal' },
      { conversationId: 'chat', turnId: 'message', threadId: 'thread', status: 'started' })).toMatchObject({ payingGroupId: 'installation-default' });
  } finally { await nats.close(); await dbs.close(); await rm(directory, { recursive: true, force: true }); }
}, 40_000);
