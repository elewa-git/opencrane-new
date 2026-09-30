// Copied from OpenCrane 1 (10abd0ef6) libs/backend/observability/src/telemetry.ts;
// changed: dropped auto-instrumentation (http/pg/fetch patching) for this
// first slice - only the SDK bootstrap and the OTLP trace exporter are kept.
// Spans are opened by hand (see handler-log.ts) rather than patched in.
// The enabled/disabled decision is pulled out into resolveTelemetryEnabled()
// so it can be unit tested without starting a real SDK or touching the network.
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
  return opts.enabled ?? env['OTEL_EXPORTER_OTLP_ENDPOINT'] !== undefined;
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
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk === null) {
    return;
  }
  try {
    await sdk.shutdown();
  } finally {
    sdk = null;
  }
}
