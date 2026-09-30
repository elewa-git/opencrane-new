import { afterEach, describe, expect, it } from 'vitest';
import { resolveTelemetryEnabled, shutdownTelemetry, startTelemetry } from '../src/telemetry.ts';

describe('resolveTelemetryEnabled', () => {
  it('is off when nothing configures it - the default for every test run', () => {
    expect(resolveTelemetryEnabled({ serviceName: 'test' }, {})).toBe(false);
  });

  it('turns on when OTEL_EXPORTER_OTLP_ENDPOINT is set in the environment', () => {
    expect(resolveTelemetryEnabled({ serviceName: 'test' }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
  });

  it('lets an explicit `enabled` option override the environment either way', () => {
    expect(resolveTelemetryEnabled({ serviceName: 'test', enabled: false }, { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(
      false,
    );
    expect(resolveTelemetryEnabled({ serviceName: 'test', enabled: true }, {})).toBe(true);
  });
});

describe('startTelemetry / shutdownTelemetry', () => {
  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('does nothing, and starts no SDK, when telemetry resolves to disabled (no OTLP endpoint - the state of every test run)', async () => {
    expect(process.env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBeUndefined();
    expect(() => startTelemetry({ serviceName: 'opencrane-server-test' })).not.toThrow();
    // A no-op shutdown after a no-op start must resolve cleanly too.
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });

  it('is safe to call shutdownTelemetry when it was never started', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});
