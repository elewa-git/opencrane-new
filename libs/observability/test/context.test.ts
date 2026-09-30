import { describe, expect, it } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncHooksContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { contextMixin, getContext, runWithContext } from '../src/context.ts';

describe('context', () => {
  it('returns undefined outside any runWithContext scope', () => {
    expect(getContext()).toBeUndefined();
    expect(contextMixin()).toEqual({});
  });

  it('makes the seeded context visible to code running inside the scope, and gone again after it', () => {
    runWithContext({ requestId: 'req_1', extra: { handler: 'settle-budget' } }, () => {
      expect(getContext()).toEqual({ requestId: 'req_1', extra: { handler: 'settle-budget' } });
      expect(contextMixin()).toEqual({ handler: 'settle-budget', request_id: 'req_1' });
    });
    expect(getContext()).toBeUndefined();
  });

  it('keeps the context across an await, including inside work started after the call that set it up returns control', async () => {
    const seen: (string | undefined)[] = [];
    await runWithContext({ requestId: 'req_2' }, async () => {
      seen.push(getContext()?.requestId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      seen.push(getContext()?.requestId);
    });
    expect(seen).toEqual(['req_2', 'req_2']);
  });

  it('adds trace_id and span_id to the mixin while a span is active, and drops them once it ends', () => {
    // getActiveSpan() reads the span through the Context API, so this needs
    // a real context manager registered, not only a tracer provider.
    const contextManager = new AsyncHooksContextManager().enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    try {
      const tracer = trace.getTracer('test');
      tracer.startActiveSpan('unit-test-span', (span) => {
        const fields = contextMixin();
        expect(typeof fields['trace_id']).toBe('string');
        expect((fields['trace_id'] as string).length).toBe(32);
        expect(typeof fields['span_id']).toBe('string');
        span.end();
      });
      expect(contextMixin()['trace_id']).toBeUndefined();
    } finally {
      trace.disable();
      context.disable();
      contextManager.disable();
    }
  });
});
