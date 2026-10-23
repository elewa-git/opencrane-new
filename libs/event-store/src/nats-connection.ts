import { readFile } from "node:fs/promises";
import {
  connect,
  nkeyAuthenticator,
  TimeoutError,
  RequestError,
  ConnectionError,
  ClosedConnectionError,
} from "@nats-io/transport-node";
import { JetStreamApiError } from "@nats-io/jetstream";

// The SDK does not export JetStreamNotEnabled, so check its name and cause instead.
export function isEventStoreUnavailable(error: unknown): boolean {
  return (
    error instanceof TimeoutError ||
    error instanceof ConnectionError ||
    error instanceof ClosedConnectionError ||
    (error instanceof Error &&
      error.name === "JetStreamNotEnabled" &&
      isEventStoreUnavailable(error.cause)) ||
    (error instanceof RequestError &&
      (error.isNoResponders() || isEventStoreUnavailable(error.cause))) ||
    (error instanceof JetStreamApiError && error.status >= 500)
  );
}

/** Require TLS before starting the NATS connection. */
export async function connectNats(env: NodeJS.ProcessEnv = process.env) {
  function required(name: string): string {
    const value = env[name]?.trim();
    if (!value) {
      throw new Error(`${name} is required for NATS`);
    }
    return value;
  }
  const servers = required("NATS_URL");
  const address = new URL(servers.includes("://") ? servers : `tls://${servers}`);
  if (address.username || address.password || !["tls:", "nats:"].includes(address.protocol)) {
    throw new Error("NATS_URL must be a NATS address without credentials");
  }
  return connect({
    servers,
    tls: {
      caFile: required("NATS_CA_FILE"),
      certFile: required("NATS_CERT_FILE"),
      keyFile: required("NATS_KEY_FILE"),
      handshakeFirst: true,
      rejectUnauthorized: true,
    },
    authenticator: nkeyAuthenticator(await readFile(required("NATS_NKEY_SEED_FILE"))),
    inboxPrefix: required("NATS_INBOX_PREFIX"),
  });
}
