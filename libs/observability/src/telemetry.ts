// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/telemetry.ts;
// changed: dropped auto-instrumentation (http/pg/fetch patching) for this
// first slice - only the SDK bootstrap and the OTLP trace exporter are kept.
// Spans are opened by hand (see handler-log.ts) rather than patched in.
// The enabled/disabled decision is pulled out into resolveTelemetryEnabled()
// so it can be unit tested without starting a real SDK or touching the network.
// Also: an empty OTEL_EXPORTER_OTLP_ENDPOINT counts as unset (a blank Helm
// value renders as ""), and shutdownTelemetry() reports a failed flush through
// a callback instead of rejecting, so an unreachable collector cannot make a
// server's shutdown fail.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface TelemetryOptions {
  /** Logical service name reported to the collector, e.g. "opencrane-server". */
  serviceName: string;
  /** Service version stamped on every span. */
  serviceVersion?: string;
  /**
   * Whether to start the SDK at all. Defaults to `true` only when
   * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so a laptop or CI run with no
   * collector configured - which is every test run - stays silent.
   */
  enabled?: boolean;
}

/** Decide whether telemetry should start, without touching the network or any global state. Exported so tests can check the decision directly. */
export function resolveTelemetryEnabled(opts: TelemetryOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.enabled ?? Boolean(env['OTEL_EXPORTER_OTLP_ENDPOINT']);
}

/** The running SDK, so shutdownTelemetry() can flush it. Null when telemetry was never started. */
let sdk: NodeSDK | null = null;

/**
 * Start the OpenTelemetry SDK: an OTLP/HTTP trace exporter pointed at
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. A no-op when telemetry resolves to disabled
 * (see {@link resolveTelemetryEnabled}) or is already running.
 */
export function startTelemetry(opts: TelemetryOptions): void {
  if (!resolveTelemetryEnabled(opts) || sdk !== null) {
    return;
  }

  process.env['OTEL_SERVICE_NAME'] ??= opts.serviceName;
  if (opts.serviceVersion !== undefined) {
    const existing = process.env['OTEL_RESOURCE_ATTRIBUTES'];
    const versionAttribute = `service.version=${opts.serviceVersion}`;
    process.env['OTEL_RESOURCE_ATTRIBUTES'] = existing !== undefined ? `${existing},${versionAttribute}` : versionAttribute;
  }

  sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter() });
  sdk.start();
}

/**
 * Flush and stop the OpenTelemetry SDK. Call this during graceful shutdown.
 * A no-op when telemetry was never started.
 *
 * Never rejects: if the flush fails (for example the collector cannot be
 * reached) the error goes to `onError` and shutdown carries on. Without an
 * `onError` the failure is dropped, so pass one that logs.
 */
export async function shutdownTelemetry(onError?: (err: unknown) => void): Promise<void> {
  if (sdk === null) {
    return;
  }
  const running = sdk;
  sdk = null;
  try {
    await running.shutdown();
  } catch (err) {
    onError?.(err);
  }
}
