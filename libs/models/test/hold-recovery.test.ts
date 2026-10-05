import { expect, it, vi } from 'vitest';
import type { AppendCommand, AppendResult } from '@opencrane/event-store';
import { parseEventByType } from '@opencrane/events';
import { BudgetActor, history, priceTableId, providerCommand, providerHistory,
  providerSecretRef, ProviderRefused, totals } from '../src/index.ts';
import { admitProviderVerification, runProviderVerification } from '../src/provider-verification.ts';
import { fixture } from './fixture.ts';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Failure = 'read_after_allow' | 'audit_and_result' | 'audit_and_budget';
const failures: Failure[] = ['read_after_allow', 'audit_and_result', 'audit_and_budget'];

function storeOutage(): AppendResult {
  return { status: 'unavailable', cause: new Error('Scripted store outage') };
}

function interruptStore(current: Fixture, failure: Failure, provider: boolean) {
  const append = current.nats.store.append.bind(current.nats.store);
  const read = current.nats.store.readStream.bind(current.nats.store);
  const head = current.nats.store.head.bind(current.nats.store);
  let decisionAttempted = false;

  async function interruptedAppend(command: AppendCommand): Promise<AppendResult> {
    const parsed = parseEventByType(command.event);
    if (!parsed.success) {
      return append(command);
    }
    const type = parsed.event.type;
    if (type === 'decision.recorded') {
      decisionAttempted = true;
      if (failure !== 'read_after_allow') {
        return storeOutage();
      }
    }
    if (decisionAttempted && type === 'provider.verification_recorded' &&
        failure === 'audit_and_result') {
      return storeOutage();
    }
    if (decisionAttempted && type === 'budget.settled') {
      if (failure === 'audit_and_budget' || failure === 'read_after_allow') {
        return storeOutage();
      }
      if (!provider && failure === 'audit_and_result') {
        // Use the release reply here: ordinary calls have no provider result.
        // Lose that reply after saving the settlement.
        await append(command);
        return storeOutage();
      }
    }
    return append(command);
  }

  function interruptedRead(...args: Parameters<typeof read>) {
    if (decisionAttempted && failure === 'read_after_allow' &&
        args[0] === 'provider-recovery') {
      throw new Error('Scripted read outage before dispatch and during cleanup');
    }
    return read(...args);
  }

  function interruptedHead(...args: Parameters<typeof head>) {
    if (!provider && decisionAttempted && failure === 'read_after_allow' &&
        args[0] === 'member-alice') {
      return Promise.reject(new Error('Scripted final authority read outage'));
    }
    return head(...args);
  }

  const appendSpy = vi.spyOn(current.nats.store, 'append');
  appendSpy.mockImplementation(interruptedAppend);
  const readSpy = vi.spyOn(current.nats.store, 'readStream');
  readSpy.mockImplementation(interruptedRead);
  const headSpy = vi.spyOn(current.nats.store, 'head');
  headSpy.mockImplementation(interruptedHead);
  function restore() {
    appendSpy.mockRestore();
    readSpy.mockRestore();
    headSpy.mockRestore();
  }
  return restore;
}

async function createProvider(current: Fixture) {
  const create = {
    action: 'create', commandId: 'create-recovery', providerId: 'recovery',
    provider: 'openai', name: 'Recovery', expectedRevision: 0,
  };
  await providerCommand(current.nats.store, current.binding, 'alice', create);
  const rows = await history(current.nats.store, 'provider-recovery', 'test');
  await current.auth.handler.handle(rows[0]!.event, current.db);
  const key = {
    action: 'key', commandId: 'key-recovery', providerId: 'recovery', expectedRevision: 1,
    secretRef: providerSecretRef('test', 'recovery', 'key-recovery'),
  };
  await providerCommand(current.nats.store, current.binding, 'alice', key);
}

async function recoverActor(current: Fixture) {
  current.advance();
  const recovered = new BudgetActor(current.nats.store, 'test', current.actor.now);
  await recovered.start();
  await recovered.expire();
  await recovered.expire();
  return recovered;
}

async function recoversOrdinaryCall(failure: Failure) {
  const current = await fixture();
  await current.stopDispatch();
  const restore = interruptStore(current, failure, false);
  try {
    try {
      expect((await current.call()).status).toBe(503);
    } finally {
      restore();
    }
    expect(current.received()).toBe(0);
    const recovered = await recoverActor(current);
    const reservation = recovered.state.reservations[0]!;
    expect(await history(current.nats.store, `security-${reservation.id}`, 'test')).toEqual([]);
    if (failure === 'read_after_allow') {
      expect(totals(recovered.state, recovered.now())).toMatchObject({ reservedCents: 1 });
      const effects = await history(current.nats.store, `effect-${reservation.id}`, 'test');
      expect(effects[0]?.event.type).toBe('effect.uncertain');
    } else {
      expect(reservation.settledCents).toBe(0);
      expect(totals(recovered.state, recovered.now())).toMatchObject({ reservedCents: 0 });
      expect(await history(current.nats.store, `effect-${reservation.id}`, 'test')).toEqual([]);
    }
  } finally {
    restore();
    await current.close();
  }
}

it.each(failures)('recovers an ordinary call after %s', recoversOrdinaryCall, 60_000);

async function recoversProviderCheck(failure: Failure) {
  const current = await fixture();
  await current.stopDispatch();
  await createProvider(current);
  const input = {
    providerId: 'recovery', commandId: 'check-recovery', expectedRevision: 2,
    action: 'test', model: 'gpt-6-luna', priceTableId, reservedCents: 1, consent: true,
  };
  function unusedSecret(): never {
    throw new Error('No key should be released');
  }
  const secrets = { save: unusedSecret, read: unusedSecret, remove: unusedSecret };
  const options = { secrets, gatewayUrl: `http://127.0.0.1:${current.options.port}` };
  const restore = interruptStore(current, failure, true);
  try {
    try {
      const attempt = runProviderVerification(current.actor, current.binding, 'alice',
        input, 'fixture-token', options);
      await expect(attempt).rejects.toThrow();
    } finally {
      restore();
    }
    let recovered = current.actor;
    if (failure === 'audit_and_budget') {
      recovered = await recoverActor(current);
    }
    await runProviderVerification(recovered, current.binding, 'alice', input,
      'fixture-token', options);
    await runProviderVerification(recovered, current.binding, 'alice', input,
      'fixture-token', options);
    current.advance();
    await recovered.expire();
    const reservation = recovered.state.reservations[0]!;
    const body = JSON.stringify({ model: input.model, input: 'Reply with OK.',
      max_output_tokens: 16, stream: false, store: false, service_tier: 'default' });
    const admission = admitProviderVerification(recovered, current.binding, 'alice',
      input, options, '/authorize/providers/openai/test', body, reservation.id);
    await expect(admission).rejects.toBeInstanceOf(ProviderRefused);
    const provider = await providerHistory(current.nats.store, 'test', 'recovery');
    expect(provider.state?.modelAnswer?.outcome).toBe('unknown');
    function isResult(row: (typeof provider.rows)[number]) {
      return row.event.type === 'provider.verification_recorded';
    }
    function isDispatch(row: (typeof provider.rows)[number]) {
      return row.event.type === 'provider.verification_dispatched';
    }
    expect(provider.rows.filter(isResult)).toHaveLength(1);
    expect(provider.rows.filter(isDispatch)).toEqual([]);
    expect(current.received()).toBe(0);
    if (failure === 'read_after_allow') {
      expect(provider.state?.modelAnswer?.settledCents).toBeUndefined();
      expect(reservation.settledCents).toBeUndefined();
      expect(totals(recovered.state, recovered.now())).toMatchObject({ reservedCents: 1 });
      const effects = await history(current.nats.store, `effect-${reservation.id}`, 'test');
      expect(effects[0]?.event.type).toBe('effect.uncertain');
    } else {
      expect(provider.state?.modelAnswer?.settledCents).toBe(0);
      expect(reservation.settledCents).toBe(0);
      expect(totals(recovered.state, recovered.now())).toMatchObject({ reservedCents: 0 });
    }
    expect(await history(current.nats.store, `security-${reservation.id}`, 'test')).toEqual([]);
  } finally {
    restore();
    await current.close();
  }
}

it.each(failures)('finishes an undispatched provider check after %s', recoversProviderCheck, 60_000);
