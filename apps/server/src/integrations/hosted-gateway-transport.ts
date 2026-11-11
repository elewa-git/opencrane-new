import { randomUUID } from 'node:crypto';
import type { EventStore } from '@opencrane/event-store';
import { mcpHostedRunSchema } from '@opencrane/events';
import { z } from 'zod';
import { captureHostedStart, type HostedCaptureTransport } from './hosted-capture.ts';

type HostedRun = z.infer<typeof mcpHostedRunSchema>;
type Method = 'server/discover' | 'tools/list';

interface HostedWorkload {
  silo: string;
  serverId: string;
  ownerUid: string;
  namespace: string;
  podName: string;
  ready: boolean;
  imageDigest: string;
  platform: string;
  podUid: string;
  workloadSpecDigest: string;
  runGeneration: number;
}

export interface HostedStartBinding {
  silo: string;
  serverId: string;
  ownerUid: string;
  namespace: string;
  podName: string;
  run: HostedRun;
}

interface GatewayDiscoveryRequest extends HostedRun {
  silo: string;
  serverId: string;
  ownerUid: string;
  namespace: string;
  podName: string;
  requestId: string;
  method: Method;
  cursor?: string;
  signal: AbortSignal;
}

interface GatewayDiscoveryReply {
  body: string;
  requestId: string;
  responder: {
    namespace: string;
    podName: string;
    podUid: string;
    ownerUid: string;
  };
}

export interface HostedGatewayAccess {
  // Read the Pod and its owning workload from Kubernetes, including the controller UID.
  readWorkload(signal: AbortSignal): Promise<HostedWorkload>;
  // Send only discovery methods through the checked route. Get the request ID from the
  // responder's reply and the responder identity from the gateway connection, not the request.
  gatewayRequest(request: GatewayDiscoveryRequest): Promise<GatewayDiscoveryReply>;
}

function requireWorkload(observed: HostedWorkload, expected: HostedStartBinding): HostedRun {
  const run = mcpHostedRunSchema.parse({
    imageDigest: observed.imageDigest,
    platform: observed.platform,
    podUid: observed.podUid,
    workloadSpecDigest: observed.workloadSpecDigest,
    runGeneration: observed.runGeneration,
  });
  if (!observed.ready || observed.silo !== expected.silo ||
      observed.serverId !== expected.serverId || observed.ownerUid !== expected.ownerUid ||
      !observed.namespace || observed.namespace !== expected.namespace ||
      !observed.podName || observed.podName !== expected.podName ||
      run.imageDigest !== expected.run.imageDigest || run.platform !== expected.run.platform ||
      run.podUid !== expected.run.podUid ||
      run.workloadSpecDigest !== expected.run.workloadSpecDigest ||
      run.runGeneration !== expected.run.runGeneration) {
    throw new Error('Hosted workload changed');
  }
  return run;
}

function requireReply(reply: GatewayDiscoveryReply, request: GatewayDiscoveryRequest,
  observed: HostedWorkload): string {
  if (!reply || typeof reply !== 'object' ||
      reply.requestId !== request.requestId || !reply.responder ||
      reply.responder.namespace !== observed.namespace ||
      reply.responder.podName !== observed.podName ||
      reply.responder.podUid !== observed.podUid ||
      reply.responder.ownerUid !== observed.ownerUid ||
      typeof reply.body !== 'string' || Buffer.byteLength(reply.body) > 4 * 1024 * 1024) {
    throw new Error('Hosted discovery reply unavailable');
  }
  return reply.body;
}

function beforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Hosted discovery timed out'));
  }
  return new Promise<T>((resolve, reject) => {
    function finish() {
      signal.removeEventListener('abort', abort);
    }
    function abort() {
      finish();
      reject(new Error('Hosted discovery timed out'));
    }
    function succeed(value: T) {
      finish();
      resolve(value);
    }
    function fail(_error: unknown) {
      finish();
      reject(new Error('Hosted discovery unavailable'));
    }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(succeed, fail);
  });
}

export function checkedHostedGatewayTransport(expected: HostedStartBinding,
  access: HostedGatewayAccess): HostedCaptureTransport {
  async function readCurrentWorkload(signal: AbortSignal): Promise<{
    run: HostedRun;
    observed: HostedWorkload;
  }> {
    signal.throwIfAborted();
    const observed = await beforeAbort(access.readWorkload(signal), signal);
    const run = requireWorkload(observed, expected);
    return { run, observed };
  }

  async function observe(signal: AbortSignal) {
    const current = await readCurrentWorkload(signal);
    return current.run;
  }

  async function request(method: Method, cursor: string | undefined, signal: AbortSignal) {
    const current = await readCurrentWorkload(signal);
    const observed = current.observed;
    signal.throwIfAborted();
    const gatewayRequest: GatewayDiscoveryRequest = {
      silo: expected.silo,
      serverId: expected.serverId,
      ownerUid: observed.ownerUid,
      namespace: observed.namespace,
      podName: observed.podName,
      ...expected.run,
      requestId: randomUUID(),
      method,
      signal,
    };
    if (cursor !== undefined) {
      gatewayRequest.cursor = cursor;
    }
    const reply = await beforeAbort(access.gatewayRequest(gatewayRequest), signal);
    return requireReply(reply, gatewayRequest, observed);
  }

  return { observe, request };
}

export async function captureHostedThroughGateway(store: EventStore,
  expected: HostedStartBinding, access: HostedGatewayAccess) {
  const transport = checkedHostedGatewayTransport(expected, access);
  return captureHostedStart(store, expected.silo, expected.serverId, expected.run, transport);
}
