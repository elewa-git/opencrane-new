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
  run: HostedRun;
}

interface GatewayDiscoveryRequest extends HostedRun {
  silo: string;
  serverId: string;
  method: Method;
  cursor?: string;
  signal: AbortSignal;
}

export interface HostedGatewayAccess {
  // Read the Pod and its owning workload from Kubernetes, including the controller UID.
  readWorkload(signal: AbortSignal): Promise<HostedWorkload>;
  // Send only discovery methods through the checked gateway route for this Pod.
  gatewayRequest(request: GatewayDiscoveryRequest): Promise<string>;
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
      run.imageDigest !== expected.run.imageDigest || run.platform !== expected.run.platform ||
      run.podUid !== expected.run.podUid ||
      run.workloadSpecDigest !== expected.run.workloadSpecDigest ||
      run.runGeneration !== expected.run.runGeneration) {
    throw new Error('Hosted workload changed');
  }
  return run;
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
  async function observe(signal: AbortSignal) {
    const observed = await beforeAbort(access.readWorkload(signal), signal);
    return requireWorkload(observed, expected);
  }

  async function request(method: Method, cursor: string | undefined, signal: AbortSignal) {
    await observe(signal);
    const gatewayRequest: GatewayDiscoveryRequest = {
      silo: expected.silo,
      serverId: expected.serverId,
      ...expected.run,
      method,
      signal,
    };
    if (cursor !== undefined) {
      gatewayRequest.cursor = cursor;
    }
    const reply = await beforeAbort(access.gatewayRequest(gatewayRequest), signal);
    if (typeof reply !== 'string' || Buffer.byteLength(reply) > 4 * 1024 * 1024) {
      throw new Error('Hosted discovery reply unavailable');
    }
    return reply;
  }

  return { observe, request };
}

export async function captureHostedThroughGateway(store: EventStore,
  expected: HostedStartBinding, access: HostedGatewayAccess) {
  const transport = checkedHostedGatewayTransport(expected, access);
  return captureHostedStart(store, expected.silo, expected.serverId, expected.run, transport);
}
