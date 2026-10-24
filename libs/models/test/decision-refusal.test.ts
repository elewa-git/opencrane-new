import { expect, it, vi } from 'vitest';
import { createEventStore } from '@opencrane/event-store';
import { createLogger } from '@opencrane/observability';
import { BudgetActor, history } from '../src/actor.ts';
import { startDecision } from '../src/decision.ts';
import { fixture } from './fixture.ts';

async function resumesWithPrivateDiagnostics() {
  const setup = await fixture();
  const lines: string[] = [];
  function write(line: string) {
    lines.push(line);
  }
  const destination = { write };
  const logger = createLogger('gateway-decision-test', { level: 'warn', destination });
  let restarted: Awaited<ReturnType<typeof startDecision>> | undefined;
  try {
    await setup.append('computer-assistant', 'computer.suspended', {
      assistantId: 'assistant', computerId: 'computer',
    });
    await setup.append('computer-assistant', 'computer.resumed', {
      assistantId: 'assistant', computerId: 'computer', generation: 1, tokenId: 'token:resumed',
    });
    await setup.append('computer-assistant', 'computer.ready', {
      assistantId: 'assistant', computerId: 'computer', generation: 1, podUid: 'resumed',
    });
    const current = await setup.issue(1, 'token:resumed');
    await setup.decisionDown();
    const recoveredStore = await createEventStore(setup.nats.connection);
    const recovered = new BudgetActor(recoveredStore, 'test');
    await recovered.start();
    const port = Number(new URL(setup.options.decisionUrl).port);
    restarted = await startDecision(recovered, setup.identity, setup.binding, port,
      undefined, undefined, undefined, undefined, logger);

    const allowed = await setup.call(current);
    expect(allowed.status, allowed.text).toBe(200);
    expect(setup.received()).toBe(1);
    expect(lines).toHaveLength(0);
    const before = await history(setup.nats.store, 'budget-test', 'test');
    const stale = await setup.call();
    expect(stale.status).toBe(403);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      msg: 'Gateway request refused', stage: 'credentials', reason: 'credential_binding_mismatch',
      route: 'model',
    });
    expect(JSON.parse(lines[0]!)).toHaveProperty('requestId');
    expect(stale.text).not.toContain('credential_binding_mismatch');
    expect(await history(setup.nats.store, 'budget-test', 'test')).toEqual(before);

    const canary = 'private-credential-canary';
    const headers = { ...current, authorization: `Bearer ${canary}` };
    const request = { method: 'POST', headers, body: JSON.stringify({ input: canary }) };
    const malformed = await fetch(`${restarted.url}/authorize`, request);
    expect(malformed.status).toBe(403);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      stage: 'credentials', reason: 'credential_invalid',
    });
    function unavailableHistory(): Promise<number> {
      const failure = new Error(`Private backend error: ${canary}`);
      return Promise.reject(failure);
    }
    const unavailable = vi.spyOn(recoveredStore, 'head');
    unavailable.mockImplementationOnce(unavailableHistory);
    try {
      const validRequest = { ...request, headers: current };
      const failedRead = await fetch(`${restarted.url}/authorize`, validRequest);
      expect(failedRead.status).toBe(403);
      expect(JSON.parse(lines[2]!)).toMatchObject({
        stage: 'turn_history', reason: 'decision_unavailable',
      });
    } finally {
      unavailable.mockRestore();
    }
    const output = lines.join('\n');
    expect(output).not.toContain(canary);
    expect(output).not.toContain(current.authorization);
    expect(output).not.toContain(current['x-turn-token']);
    expect(output).not.toContain('token:resumed');
    expect(output).not.toContain('stack');
    expect(setup.received()).toBe(1);
  } finally {
    await restarted?.close();
    await setup.close();
  }
}
it('admits a resumed turn after restart and logs only fixed private refusal reasons',
  resumesWithPrivateDiagnostics, 60_000);
