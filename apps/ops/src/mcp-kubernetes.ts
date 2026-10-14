import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import type { McpInstanceState } from '@opencrane/projections';

const execFile = promisify(execFileCallback);
export async function kubectl(args: string[], input?: string): Promise<string> {
  try {
    const pending = execFile('kubectl', args, { timeout: 10_000, maxBuffer: 2_000_000 });
    pending.child.stdin?.end(input);
    const result = await pending;
    return result.stdout.trim();
  } catch {
    throw new Error('MCP Kubernetes operation failed');
  }
}
function value(object: unknown, ...path: string[]): unknown {
  let current = object;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}
function metadata(object: unknown, key: string) {
  const result = value(object, 'metadata', key);
  if (typeof result !== 'string' || !result) throw new Error('MCP workload identity mismatch');
  return result;
}
const instanceKey = 'opencrane.ai/mcp-instance';
const runKey = 'opencrane.ai/mcp-run';
const specKey = 'opencrane.ai/mcp-spec';
const stopKey = 'opencrane.ai/mcp-stop';

export class McpKubernetes {
  readonly namespace: string;
  readonly runner: typeof kubectl;
  constructor(namespace: string, runner = kubectl) {
    this.namespace = namespace;
    this.runner = runner;
    if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(namespace)) {
      throw new Error('Invalid MCP Kubernetes namespace');
    }
  }
  private async run(args: string[], input?: string) {
    try {
      return await this.runner(['--namespace', this.namespace, '--request-timeout=10s', ...args], input);
    } catch {
      throw new Error('MCP Kubernetes operation failed');
    }
  }
  private async objects(state: McpInstanceState, name: string) {
    const output = await this.run(['get', 'statefulsets,pods', '-o', 'json']);
    let items: unknown;
    try {
      const parsed: unknown = JSON.parse(output);
      items = value(parsed, 'items');
    } catch {
      throw new Error('Invalid MCP Kubernetes response');
    }
    if (!Array.isArray(items)) throw new Error('Invalid MCP Kubernetes response');
    function relevant(object: unknown) {
      const objectName = metadata(object, 'name');
      metadata(object, 'uid');
      metadata(object, 'resourceVersion');
      return objectName === name || objectName === `${name}-0` ||
        value(object, 'metadata', 'uid') === state.podUid ||
        (value(object, 'metadata', 'labels', instanceKey) === state.start.instanceId.slice(0, 32) &&
          value(object, 'metadata', 'labels', runKey) === String(state.start.runGeneration));
    }
    const objects: unknown[] = items;
    return objects.filter(relevant);
  }
  private checkWorkload(object: unknown, state: McpInstanceState, name: string) {
    const start = state.start;
    const replicas = value(object, 'spec', 'replicas');
    if (value(object, 'apiVersion') !== 'apps/v1' || metadata(object, 'name') !== name ||
        value(object, 'metadata', 'labels', instanceKey) !== start.instanceId.slice(0, 32) ||
        value(object, 'metadata', 'labels', runKey) !== String(start.runGeneration) ||
        value(object, 'metadata', 'annotations', instanceKey) !== start.instanceId ||
        value(object, 'metadata', 'annotations', specKey) !== start.workloadSpecDigest ||
        (replicas !== 0 && replicas !== 1)) {
      throw new Error('MCP workload identity mismatch');
    }
  }
  private controller(pod: unknown, name: string): unknown {
    const owners = value(pod, 'metadata', 'ownerReferences');
    if (!Array.isArray(owners)) return undefined;
    for (const owner of owners) {
      if (value(owner, 'controller') === true && value(owner, 'kind') === 'StatefulSet' &&
          value(owner, 'apiVersion') === 'apps/v1' && value(owner, 'name') === name) {
        return value(owner, 'uid');
      }
    }
    return undefined;
  }
  async stop(state: McpInstanceState, stopId: string): Promise<void> {
    const name = `mcp-${state.start.instanceId.slice(0, 32)}-${state.start.runGeneration}`;
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const objects = await this.objects(state, name);
      if (objects.length === 0) return;
      let workload: unknown;
      let pod: unknown;
      for (const object of objects) {
        if (value(object, 'kind') === 'StatefulSet' && workload === undefined) {
          this.checkWorkload(object, state, name);
          workload = object;
        } else if (value(object, 'kind') === 'Pod' && pod === undefined &&
            metadata(object, 'uid') === state.podUid) {
          pod = object;
        } else {
          throw new Error('MCP workload identity mismatch');
        }
      }
      if (workload) await this.retire(workload, pod, name, stopId);
      await delay(100);
    }
    throw new Error('MCP Pod absence timed out');
  }
  private async retire(workload: unknown, pod: unknown, name: string, stopId: string) {
    const uid = metadata(workload, 'uid');
    const resourceVersion = metadata(workload, 'resourceVersion');
    const marker = JSON.stringify([stopId, uid]);
    const marked = value(workload, 'metadata', 'annotations', stopKey) === marker;
    // Require the saved Pod's controller, or our earlier atomic stop patch after a lost reply.
    if ((pod && this.controller(pod, name) !== uid) || (!pod && !marked)) {
      throw new Error('MCP workload identity mismatch');
    }
    if (!marked || value(workload, 'spec', 'replicas') !== 0) {
      const patch = { metadata: { uid, resourceVersion, annotations: { [stopKey]: marker } },
        spec: { replicas: 0 } };
      await this.run(['patch', `statefulset/${name}`, '--type=merge', '-p', JSON.stringify(patch)]);
    } else if (!pod) {
      const path = `/apis/apps/v1/namespaces/${this.namespace}/statefulsets/${name}`;
      const options = { apiVersion: 'v1', kind: 'DeleteOptions',
        preconditions: { uid, resourceVersion }, propagationPolicy: 'Background' };
      await this.run(['delete', '--raw', path, '-f', '-'], JSON.stringify(options));
    }
  }
}
