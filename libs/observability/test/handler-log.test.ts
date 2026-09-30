import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Logger } from 'pino';
import { runHandler } from '../src/handler-log.ts';

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

  it('runs the handler inside exactly one span, named after the handler, and marks it OK', async () => {
    await runHandler(fakeLogger().logger, run, () => Promise.resolve('ok'));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('settle-budget');
    expect(spans[0]?.status.code).toBe(1); // SpanStatusCode.OK
    expect(spans[0]?.attributes['event_id']).toBe('evt_1');
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
});
