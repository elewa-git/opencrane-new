import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Logger } from 'pino';
import { runWithContext } from '../src/context.ts';
import { runHandler } from '../src/handler-log.ts';
import { createLogger } from '../src/logger.ts';
import { memorySink } from './memory-sink.ts';

/** Minimal stand-in for a pino Logger that records what it was called with, so a test can inspect the fields without parsing JSON. */
function fakeLogger(): { logger: Logger; calls: { level: 'info' | 'error'; fields: Record<string, unknown>; msg: string }[] } {
  const calls: { level: 'info' | 'error'; fields: Record<string, unknown>; msg: string }[] = [];
  const logger = {
    info: (fields: Record<string, unknown>, msg: string) => {
      calls.push({ level: 'info', fields, msg });
    },
    error: (fields: Record<string, unknown>, msg: string) => {
      calls.push({ level: 'error', fields, msg });
    },
  } as unknown as Logger;
  return { logger, calls };
}

describe('runHandler', () => {
  // The tracer inside handler-log.ts is created once, at module load, and
  // (like any OpenTelemetry ProxyTracer) permanently caches the first real
  // tracer it resolves. So the provider is registered once here, and each
  // test clears the same exporter instead of installing a fresh provider,
  // which a later test's spans would otherwise still be delegating past.
  const exporter = new InMemorySpanExporter();

  beforeAll(() => {
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  beforeEach(() => {
    exporter.reset();
  });

  afterAll(() => {
    trace.disable();
  });

  const run = { handler: 'settle-budget', eventId: 'evt_1', eventType: 'effect.observed', stream: 'budget-acme', attempt: 1 };

  it('logs handler, event_id, event_type, stream, attempt and trace_id on both the start and completion lines', async () => {
    const { logger, calls } = fakeLogger();

    const result = await runHandler(logger, run, () => Promise.resolve('ok'));

    expect(result).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.msg).toBe('handler.started');
    expect(calls[1]?.msg).toBe('handler.completed');
    for (const call of calls) {
      expect(call.fields['handler']).toBe('settle-budget');
      expect(call.fields['event_id']).toBe('evt_1');
      expect(call.fields['event_type']).toBe('effect.observed');
      expect(call.fields['stream']).toBe('budget-acme');
      expect(call.fields['attempt']).toBe(1);
      expect(typeof call.fields['trace_id']).toBe('string');
      expect((call.fields['trace_id'] as string).length).toBe(32);
    }
  });

  it('runs the handler inside exactly one span, named after the handler, marked OK, carrying all five fixed fields and the trace id', async () => {
    await runHandler(fakeLogger().logger, run, () => Promise.resolve('ok'));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('settle-budget');
    expect(spans[0]?.status.code).toBe(1); // SpanStatusCode.OK
    expect(spans[0]?.attributes).toMatchObject({ handler: 'settle-budget', event_id: 'evt_1', event_type: 'effect.observed', stream: 'budget-acme', attempt: 1 });
    expect(spans[0]?.attributes['trace_id']).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('logs handler.failed, marks the span as an error, and re-throws, when the handler throws', async () => {
    const { logger, calls } = fakeLogger();
    const boom = new Error('settlement failed');

    await expect(
      runHandler(logger, run, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.msg).toBe('handler.failed');
    expect(calls[1]?.fields['err']).toBe(boom);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('gives two different runs two different trace ids', async () => {
    const first = fakeLogger();
    const second = fakeLogger();
    await runHandler(first.logger, run, () => Promise.resolve(undefined));
    await runHandler(second.logger, { ...run, attempt: 2 }, () => Promise.resolve(undefined));

    expect(first.calls[0]?.fields['trace_id']).not.toBe(second.calls[0]?.fields['trace_id']);
  });

  it('gives any log line written inside the handler the handler fields, and keeps the request id and extra fields an outer scope set (checked with a real logger)', async () => {
    const { stream, lines } = memorySink();
    const logger = createLogger('test', { destination: stream, level: 'info' });

    await runWithContext({ requestId: 'req_7', extra: { silo: 'acme' } }, () =>
      runHandler(logger, run, () => {
        logger.info('inside the handler');
        return Promise.resolve();
      }),
    );

    expect(lines().find((line) => line['msg'] === 'inside the handler')).toMatchObject({
      handler: 'settle-budget',
      event_id: 'evt_1',
      event_type: 'effect.observed',
      stream: 'budget-acme',
      attempt: 1,
      request_id: 'req_7',
      silo: 'acme',
    });
  });

  it('writes no secret from a thrown error into the handler.failed line (found leaking an Error property)', async () => {
    const { stream, text } = memorySink();
    const logger = createLogger('test', { destination: stream, level: 'info' });
    const secretError = Object.assign(new Error('openfga write failed'), {
      config: { headers: { authorization: 'Bearer SECRET_RUNHANDLER' } },
      apiKey: 'SECRET_RH_APIKEY',
    });

    await expect(runHandler(logger, run, () => Promise.reject(secretError))).rejects.toBe(secretError);

    expect(text()).toContain('handler.failed');
    expect(text()).not.toMatch(/SECRET_/u);
  });
});
