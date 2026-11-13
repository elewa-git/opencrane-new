import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { prepareRemote, type RemoteNetwork } from './remote-https.ts';
import type { Permit, Route } from './mcp-dispatch.ts';
import type { PersonalCredentialDispatch } from './personal-mcp-dispatch.ts';

export type RemoteTarget = Awaited<ReturnType<typeof prepareRemote>>;

export interface McpAccessCheck {
  (): Promise<void>;
  prepare?: (deadline: number) => Promise<void>;
}

const callerCredentialHeaders = ['authorization', 'proxy-authorization', 'cookie',
  'x-api-key', 'x-opencrane-profile-id'];

function hasCallerCredentialHeaders(req: IncomingMessage) {
  for (const name of callerCredentialHeaders) {
    if (req.headers[name] !== undefined) return true;
  }
  return false;
}

export function dispatchDigest(body: string) {
  const hash = createHash('sha256');
  hash.update(body);
  return hash.digest('hex');
}

export interface PermitConsumer {
  pending: Map<string, Permit>;
  silo: string;
}

export function consumePermit(req: IncomingMessage, body: string, state: PermitConsumer) {
  const { pending, silo } = state;
  const token = req.headers['x-opencrane-mcp-permit'];
  const permit = typeof token === 'string' ? pending.get(token) : undefined;
  if (typeof token === 'string') pending.delete(token);
  // Consume even refused attempts, so neither errors nor lost replies cause a resend.
  if (!permit || permit.silo !== silo || permit.expiresAt <= Date.now() ||
      permit.bodyDigest !== dispatchDigest(body) || req.method !== 'POST') {
    throw new Error('MCP permit refused');
  }
  if (permit.release && hasCallerCredentialHeaders(req)) {
    throw new Error('MCP credential headers refused');
  }
  return permit;
}


export interface PersonalDispatchRequest {
  permit: Permit;
  target: RemoteTarget | undefined;
  body: string;
  res: ServerResponse;
  deadline: number;
  dispatch: PersonalCredentialDispatch | undefined;
  network: RemoteNetwork;
}

export async function dispatchRemoteTarget(route: Route, deadline: number, network: RemoteNetwork) {
  if (!route.locator) return undefined;
  const duration = Math.max(0, Math.floor(Math.min(1000, deadline - performance.now())));
  const signal = AbortSignal.timeout(duration);
  return prepareRemote(route.locator, network, signal);
}
