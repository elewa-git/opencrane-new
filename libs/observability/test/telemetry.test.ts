import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The SDK and exporter are replaced, so these tests start nothing real and
// never touch the network. `sdk` records what the code under test did to it.
const sdk = vi.hoisted(() => ({ created: 0, started: 0, shutdowns: 0, shutdownError: undefined as Error | undefined }));

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor() {
      sdk.created += 1;
    }
    start(): void {
      sdk.started += 1;
    }
    shutdown(): Promise<void> {
      sdk.shutdowns += 1;
      return sdk.shutdownError === undefined ? Promise.resolve() : Promise.reject(sdk.shutdownError);
    }
  },
}));
vi.mock('@opentelemetry/exporter-trace-otlp-http', () => ({ OTLPTraceExporter: class {} }));

const { resolveTelemetryEnabled, shutdownTelemetry, startTelemetry } = await import('../src/telemetry.ts');

describe('resolveTelemetryEnabled', () => {
  const service = { serviceName: 'test' };
  const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' };

  it('is off by default, on when an endpoint is set, and off again when it is set but empty (a blank Helm value renders as "")', () => {
    expect(resolveTelemetryEnabled(service, {})).toBe(false);
    expect(resolveTelemetryEnabled(service, endpoint)).toBe(true);
    expect(resolveTelemetryEnabled(service, { OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toBe(false);
  });

  it('lets an explicit `enabled` option override the environment either way', () => {
    expect(resolveTelemetryEnabled({ ...service, enabled: false }, endpoint)).toBe(false);
    expect(resolveTelemetryEnabled({ ...service, enabled: true }, {})).toBe(true);
  });
});

describe('startTelemetry / shutdownTelemetry', () => {
  beforeEach(() => {
    Object.assign(sdk, { created: 0, started: 0, shutdowns: 0, shutdownError: undefined });
    // Set explicitly, so the result never depends on what the host shell exports.
    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
    vi.stubEnv('OTEL_SERVICE_NAME', undefined);
    vi.stubEnv('OTEL_RESOURCE_ATTRIBUTES', undefined);
  });

  afterEach(async () => {
    await shutdownTelemetry();
    vi.unstubAllEnvs();
  });

  it('starts no SDK when no collector is configured, then starts one SDK once when an endpoint is set, even if called twice, and names the service', async () => {
    startTelemetry({ serviceName: 'opencrane-server-test' });
    await shutdownTelemetry();
    expect(sdk).toMatchObject({ created: 0, shutdowns: 0 });

    vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://collector:4318');
    startTelemetry({ serviceName: 'opencrane-server-test' });
    startTelemetry({ serviceName: 'opencrane-server-test' });

    expect(sdk).toMatchObject({ created: 1, started: 1 });
    expect(process.env['OTEL_SERVICE_NAME']).toBe('opencrane-server-test');
  });

  it('flushes the SDK on shutdown and can start again; a failed flush (collector unreachable) does not reject but goes to onError', async () => {
    startTelemetry({ serviceName: 'a', enabled: true });
    await shutdownTelemetry();
    expect(sdk.shutdowns).toBe(1);

    startTelemetry({ serviceName: 'a', enabled: true });
    sdk.shutdownError = new Error('connect ECONNREFUSED 127.0.0.1:9');
    const onError = vi.fn();
    await expect(shutdownTelemetry(onError)).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledExactlyOnceWith(sdk.shutdownError);
    startTelemetry({ serviceName: 'a', enabled: true });
    expect(sdk.created).toBe(3);
  });

  it('is safe to call shutdownTelemetry when it was never started, with or without onError', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    await expect(shutdownTelemetry(vi.fn())).resolves.toBeUndefined();
  });
});
