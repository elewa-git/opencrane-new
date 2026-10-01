import { afterEach, describe, expect, it, vi } from 'vitest';

// The telemetry SDK is replaced by one whose flush fails, as it does when the
// collector cannot be reached (the real one took about 9 seconds to reject
// with ECONNREFUSED). Kept in its own file because vi.mock applies to the file.
vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    start(): void {}
    shutdown(): Promise<void> {
      return Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:9'));
    }
  },
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));

const { startTelemetry } = await import('@opencrane/observability');
const { buildServer } = await import('../src/server.ts');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('closing the server when the telemetry flush fails', () => {
  it('still closes cleanly and logs the failure, instead of app.close() rejecting', async () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    const chunks: string[] = [];
    const app = buildServer({ logDestination: { write: (msg: string) => void chunks.push(msg) } });
    startTelemetry({ serviceName: 'opencrane-server-test', enabled: true });

    await expect(app.close()).resolves.toBeUndefined();

    const lines = chunks.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    const failure = lines.find((line) => line['msg'] === 'telemetry shutdown failed');
    expect(failure?.['level']).toBe(50);
    expect((failure?.['err'] as { message?: string } | undefined)?.message).toContain('ECONNREFUSED');
  });
});
