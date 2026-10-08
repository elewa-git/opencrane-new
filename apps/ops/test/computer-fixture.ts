import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { envelope } from '@opencrane/models';
import { expect } from 'vitest';
import { history } from '../src/lifecycle.ts';

export async function computerFixture({ suspended = true } = {}) {
  const nats = await natsFixture();
  const directory = await mkdtemp(`${tmpdir()}/computer-idle-`);
  const stop = new AbortController();
  const keyOptions = {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${directory}/key.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://idle.test/' });
  const subject = 'computer-assistant';
  async function record(type: string, extra: Record<string, unknown>) {
    const rows = await history(nats.store, subject);
    const data = { assistantId: 'assistant', computerId: 'computer', ...extra };
    const event = envelope('test', subject, type, data);
    const result = await nats.store.append({ event, expectedSequence: rows.at(-1)?.sequence ?? 0 });
    expect(result.status).toBe('appended');
  }
  await record('computer.claimed', { generation: 1, tokenId: 'token:initial' });
  await record('computer.ready', { generation: 1, podUid: 'old-pod' });
  if (suspended) await record('computer.suspended', {});
  return { nats, directory, stop, tokens, subject, record };
}

