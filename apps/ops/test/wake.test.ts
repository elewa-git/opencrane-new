import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { computerTokenAudience, tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { SandboxClient } from '../src/kubernetes.ts';
import { history, resumeComputer, watchComputers } from '../src/lifecycle.ts';

it('resumes a bound computer when the claim endpoint is unavailable, after the old Pod is gone', async () => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/wake-test-`), stop = new AbortController();
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://wake.test/' });
  const subject = 'computer-assistant';
  for (const [type, extra] of [
    ['computer.claimed', { generation: 1, tokenId: 'token:initial' }],
    ['computer.ready', { generation: 1, podUid: 'old-pod', sandboxUid: 'sandbox' }],
    ['computer.suspended', {}],
  ] as const) {
    const rows = await history(nats.store, subject);
    const result = await nats.store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: {
      id: randomUUID(), commandId: randomUUID(), type, subject, silo: 'test', source: 'test', time: new Date().toISOString(),
      principal: { kind: 'system', id: 'test' }, data: { assistantId: 'assistant', computerId: 'computer', ...extra },
    } });
    expect(result.status).toBe('appended');
  }
  const rotated = await resumeComputer(nats.store, tokens, 'test', 'assistant');
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  // The external claim API may be unavailable; an existing binding needs only state and mode APIs.
  vi.spyOn(kube, 'claim').mockRejectedValue(new Error('Claim endpoint unavailable'));
  let podUid: string | undefined = 'old-pod';
  vi.spyOn(kube, 'state').mockImplementation(() => Promise.resolve({ uid: 'sandbox', ready: true, suspended: false, ...(podUid ? { podUid } : {}) }));
  const fenced = new Promise<void>(resolve => {
    vi.spyOn(kube, 'mode').mockImplementation(async (_name, mode) => {
      const current = (await history(nats.store, subject)).at(-1)!.event;
      expect(current.type).toBe('computer.resumed'); // Intent was committed before either effect.
      if (mode === 'Suspended') { podUid = undefined; resolve(); }
      else podUid = 'new-pod';
    });
  });
  let delivered = false;
  const work = watchComputers(nats.store, kube, tokens, async (_name, token) => {
    expect(podUid).toBe('new-pod');
    await expect(tokens.verify(token.value, computerTokenAudience, rotated.id)).resolves.toBeDefined();
    delivered = true; stop.abort();
  }, 'test', 600_000, stop.signal);
  // Surface watcher failures without leaving a rejected background promise.
  const outcome = work.then(() => undefined, (error: unknown) => error);
  try {
    await Promise.race([fenced, outcome.then(error => { if (error instanceof Error) throw error; })]);
    expect(delivered).toBe(false);
    await until(() => delivered, 3000);
    expect(await outcome).toBeUndefined();
    expect((await history(nats.store, subject)).at(-1)!.event).toMatchObject({ type: 'computer.ready', data: { podUid: 'new-pod', generation: 1 } });
  } finally {
    stop.abort(); await outcome; vi.restoreAllMocks(); await nats.close(); await rm(directory, { recursive: true, force: true });
  }
});
