import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { computerTokenAudience, tokenIssuer } from '@opencrane/auth';
import { natsFixture } from '@opencrane/event-store/testing';
import { until } from '@opencrane/authz/testing';
import { SandboxClient } from '../src/kubernetes.ts';
import { envelope } from '@opencrane/models';
import { getEventDefinition } from '@opencrane/events';
import { history, resumeComputer, watchComputers } from '../src/lifecycle.ts';

it.each(['state', 'mode'] as const)('keeps watching other computers when Kubernetes %s fails', async (operation) => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/wake-errors-`), stop = new AbortController();
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://wake.test/' });
  for (const computerId of ['broken', 'healthy']) {
    for (const [type, extra] of [
      ['computer.claimed', { generation: 1, tokenId: `token:${computerId}` }],
      ['computer.ready', { generation: 1, podUid: `pod-${computerId}`, sandboxUid: `sandbox-${computerId}` }],
    ] as const) {
      const subject = `computer-${computerId}`, rows = await history(nats.store, subject);
      expect((await nats.store.append({ expectedSequence: rows.at(-1)?.sequence ?? 0, event: {
        id: randomUUID(), commandId: randomUUID(), type, subject, silo: 'test', source: 'test', time: new Date().toISOString(),
        principal: { kind: 'system', id: 'test' }, data: { assistantId: computerId, computerId, ...extra },
      } })).status).toBe('appended');
    }
  }
  const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  let attempts = 0, deliveries = 0;
  const failBroken = (id: string) => {
    if (id === 'broken') throw new Error(++attempts === 1 ? 'NotFound' : 'Kubernetes temporarily unavailable');
  };
  vi.spyOn(kube, 'claim').mockRejectedValue(new Error('Existing bindings must skip claim repair'));
  vi.spyOn(kube, 'state').mockImplementation(id => {
    if (operation === 'state') failBroken(id);
    return Promise.resolve({ uid: `sandbox-${id}`, podUid: `pod-${id}`, ready: true, suspended: false });
  });
  vi.spyOn(kube, 'mode').mockImplementation(id => { if (operation === 'mode') failBroken(id); return Promise.resolve(); });
  const outcome = watchComputers(nats.store, kube, tokens, id => {
    expect(id).toBe('healthy');
    if (++deliveries === 2) stop.abort();
    return Promise.resolve();
  }, 'test', 600_000, stop.signal).then(() => undefined, (error: unknown) => error);
  try {
    await Promise.race([until(() => deliveries === 2, 3000), outcome.then(error => { if (error instanceof Error) throw error; })]);
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(await outcome).toBeUndefined();
  } finally {
    stop.abort(); await outcome; vi.restoreAllMocks(); await nats.close(); await rm(directory, { recursive: true, force: true });
  }
});

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


it('continues reconciliation across all view audits and replays them safely after restart', async () => {
  const nats = await natsFixture(), directory = await mkdtemp(`${tmpdir()}/view-replay-`);
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  await writeFile(`${directory}/key.pem`, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath: `${directory}/key.pem`, issuer: 'https://wake.test/' });
  const subject = 'computer-asst_1', kube = new SandboxClient('/unused-test-kubeconfig', 'test');
  vi.spyOn(kube, 'state').mockResolvedValue({ uid: 'sandbox', podUid: 'pod', ready: true, suspended: false });
  vi.spyOn(kube, 'mode').mockResolvedValue();
  const append = async (subject: string, type: string, data: unknown) => {
    expect((await nats.store.append({ event: envelope('test', subject, type, data),
      expectedSequence: (await history(nats.store, subject)).at(-1)?.sequence ?? 0 })).status).toBe('appended');
  };
  let stop = new AbortController(), deliveries = 0;
  const sink = async (_id: string, token: Awaited<ReturnType<typeof tokens.computer>>) => {
    await expect(tokens.verify(token.value, computerTokenAudience, 'token:test')).resolves.toBeDefined();
    deliveries++;
  };
  let outcome: Promise<unknown> = Promise.resolve();
  try {
    await append(subject, 'computer.claimed', { assistantId: 'asst_1', computerId: 'computer_1', generation: 1, tokenId: 'token:test' });
    await append(subject, 'computer.ready', { assistantId: 'asst_1', computerId: 'computer_1', generation: 1, podUid: 'pod' });
    outcome = watchComputers(nats.store, kube, tokens, sink, 'test', 600_000, stop.signal).catch((error: unknown) => error);
    await until(() => deliveries > 0, 3000);
    for (const type of ['computer.view_started', 'computer.view_stopped', 'computer.view_refused']) {
      await append(type === 'computer.view_refused' ? 'view-refusal' : 'view-view_1', type, getEventDefinition(type)!.example);
      const before = deliveries;
      await until(() => deliveries > before, 3000);
    }
    stop.abort(); expect(await outcome).toBeUndefined();
    // A new worker scans the same durable history, then performs the next lifecycle transition.
    stop = new AbortController();
    outcome = watchComputers(nats.store, kube, tokens, sink, 'test', 0, stop.signal).catch((error: unknown) => error);
    await until(async () => (await history(nats.store, subject)).at(-1)?.event.type === 'computer.suspended', 3000);
    stop.abort(); expect(await outcome).toBeUndefined();
    expect((await history(nats.store, subject)).map(row => row.event.type)).toEqual(['computer.claimed', 'computer.ready', 'computer.suspended']);
  } finally {
    stop.abort(); await outcome; vi.restoreAllMocks(); await nats.close(); await rm(directory, { recursive: true, force: true });
  }
});
