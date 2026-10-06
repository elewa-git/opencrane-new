// Copied from OpenCrane 1 (10abd0ef6).
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface TelemetryOptions {
  /** Name this service in collector data, for example "opencrane-server". */
  serviceName: string;
  /** Add this service version to every span. */
  serviceVersion?: string;
  /**
   * Start the SDK only when
   * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so a laptop or CI run with no
   * collector configured - which is every test run - stays silent.
   */
  enabled?: boolean;
}

/** Check whether telemetry should start without using the network or changing global state. */
export function resolveTelemetryEnabled(opts: TelemetryOptions, env: NodeJS.ProcessEnv = process.env): boolean {
  return opts.enabled ?? Boolean(env['OTEL_EXPORTER_OTLP_ENDPOINT']);
}

/** Keep the running SDK so shutdownTelemetry() can flush it; stay null if it never starts. */
let sdk: NodeSDK | null = null;

/**
 * Start the OpenTelemetry SDK with an OTLP/HTTP trace exporter pointed at
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. Do nothing when disabled or already running.
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
 * Do nothing when telemetry never started.
 *
 * Keep shutdown going if flushing fails, and send the error to `onError`.
 * The error is dropped when no callback is supplied, so pass one that logs it.
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
