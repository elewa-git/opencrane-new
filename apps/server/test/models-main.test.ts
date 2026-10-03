import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { natsFixture } from '@opencrane/event-store/testing';
import { databases } from '@opencrane/authz/testing';
import { history } from '@opencrane/models';
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
