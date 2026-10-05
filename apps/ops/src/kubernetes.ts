import { spawn, execFile as execFileCallback } from 'node:child_process';
import type { IssuedToken } from '@opencrane/auth';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
type Resource = object;

function value(object: unknown, ...path: string[]): unknown {
  let current = object;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}

export interface SandboxState {
  uid: string;
  ready: boolean;
  suspended: boolean;
  podUid?: string;
}

/** Minimal kubectl adapter; Pod reads observe identity; the proxy subresource delivers ephemeral grants. */
export class SandboxClient {
  private readonly modes = new Map<string, 'Running' | 'Suspended'>();
  private readonly delivered = new Map<string, IssuedToken>();
  readonly kubeconfig: string;
  readonly namespace: string;
  readonly pool: string;
  readonly storage: string;
  constructor(kubeconfig: string, namespace: string, pool = 'computer', storage = '10Gi') {
    this.kubeconfig = kubeconfig;
    this.namespace = namespace;
    this.pool = pool;
    this.storage = storage;
    if (!kubeconfig || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(namespace)) {
      throw new Error('Invalid Kubernetes lifecycle configuration');
    }
  }

  private args(args: string[]) {
    return ['--kubeconfig', this.kubeconfig, '--namespace', this.namespace, ...args];
  }

  private async run(...args: string[]): Promise<string> {
    return (await execFile('kubectl', this.args(args), { timeout: 30_000, maxBuffer: 2_000_000 })).stdout.trim();
  }

  private input(args: string[], object: Resource): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('kubectl', this.args(args), { stdio: ['pipe', 'ignore', 'pipe'] });
      let error = '';
      child.stderr.on('data', (chunk: Buffer) => { error += chunk.toString(); });
      child.once('error', reject);
      child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`kubectl failed: ${error.trim()}`)));
      child.stdin.end(JSON.stringify(object));
    });
  }

  private async get(kind: string, name: string): Promise<Resource | undefined> {
    const output = await this.run('get', `${kind}/${name}`, '--ignore-not-found', '-o', 'json');
    if (!output) return undefined;
    const parsed: unknown = JSON.parse(output);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid Kubernetes response');
    return parsed;
  }

  async claim(name: string, assistantId: string): Promise<string> {
    const existing = await this.get('sandboxclaim', name);
    if (!existing) {
      await this.input(['create', '-f', '-'], {
        apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxClaim',
        metadata: { name, labels: { 'sandbox.users.io/computer': name, 'sandbox.users.io/assistant': assistantId } },
        spec: { warmPoolRef: { name: this.pool }, lifecycle: { shutdownPolicy: 'Retain' },
          additionalPodMetadata: { labels: { 'sandbox.users.io/computer': name, 'sandbox.users.io/assistant': assistantId } },
          volumeClaimTemplates: [{ metadata: { name: 'home', labels: { 'sandbox.users.io/computer': name } },
            spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: this.storage } } } }] },
      });
    } else if (value(existing, 'metadata', 'labels', 'sandbox.users.io/assistant') !== assistantId) {
      throw new Error('Computer claim belongs to another assistant');
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const claim = await this.get('sandboxclaim', name);
      const sandboxName = value(claim, 'status', 'sandbox', 'name') ?? name;
      if (typeof sandboxName === 'string') {
        const sandbox = await this.get('sandbox', sandboxName);
        const uid = value(sandbox, 'metadata', 'uid');
        if (typeof uid === 'string' && await this.get('pvc', `home-${sandboxName}`)) {
          await this.bindClaim(name, assistantId, claim, sandbox);
          return uid;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for Sandbox and PVC');
  }

  private async bindClaim(name: string, assistantId: string, claim: unknown, sandbox: unknown) {
    const uid = value(claim, 'metadata', 'uid');
    if (typeof uid !== 'string') throw new Error('Claim has no UID');
    const owners = value(sandbox, 'metadata', 'ownerReferences');
    const references: unknown[] = Array.isArray(owners) ? owners : [];
    if (references.some(owner => value(owner, 'controller') === true && value(owner, 'uid') === uid)) return;
    if (value(sandbox, 'spec', 'podTemplate', 'metadata', 'labels', 'sandbox.users.io/assistant') !== assistantId
      || value(sandbox, 'spec', 'podTemplate', 'metadata', 'labels', 'sandbox.users.io/computer') !== name) {
      throw new Error('Retained Sandbox belongs to another computer or assistant');
    }
    // A recreated claim must own its retained Sandbox before the controller can bind it.
    await this.input(['patch', `sandbox/${name}`, '--type=merge', '-p', JSON.stringify({ metadata: {
      resourceVersion: value(sandbox, 'metadata', 'resourceVersion'),
      ownerReferences: [...references.filter(owner => value(owner, 'controller') !== true), {
        apiVersion: 'extensions.agents.x-k8s.io/v1beta1', kind: 'SandboxClaim', name, uid,
        controller: true, blockOwnerDeletion: true,
      }],
    } })], {});
  }

  async state(name: string): Promise<SandboxState | undefined> {
    // Check both bindings in one kubectl process; either missing needs claim repair.
    const output = await this.run('get', `sandbox/${name}`, `sandboxclaim/${name}`, '--ignore-not-found', '-o', 'json');
    if (!output) return undefined;
    const resources: unknown = JSON.parse(output);
    const bindings = value(resources, 'items');
    if (!Array.isArray(bindings)) throw new Error('Invalid Kubernetes bindings response');
    const sandbox: unknown = bindings.find((item: unknown) => value(item, 'kind') === 'Sandbox');
    if (!sandbox || !bindings.some((item: unknown) => value(item, 'kind') === 'SandboxClaim')) return undefined;
    const conditions = value(sandbox, 'status', 'conditions');
    const list: unknown[] = Array.isArray(conditions) ? conditions : [];
    const condition = (type: string) => list.find((item) => value(item, 'type') === type);
    const ready = condition('Ready');
    const uid = value(sandbox, 'metadata', 'uid');
    if (typeof uid !== 'string') throw new Error('Sandbox has no UID');
    const pods: unknown = JSON.parse(await this.run('get', 'pods', '-o', 'json'));
    const items = value(pods, 'items');
    const pod: unknown = (Array.isArray(items) ? items : []).find((item: unknown) => {
      const owners = value(item, 'metadata', 'ownerReferences');
      return Array.isArray(owners) && owners.some((owner: unknown) => value(owner, 'uid') === uid)
        && !value(item, 'metadata', 'deletionTimestamp');
    });
    const podUid = value(pod, 'metadata', 'uid');
    const podConditions = value(pod, 'status', 'conditions');
    const podReady = Array.isArray(podConditions) && podConditions.some((c: unknown) => value(c, 'type') === 'Ready' && value(c, 'status') === 'True');
    return { uid, ready: value(ready, 'status') === 'True' && podReady,
      suspended: value(condition('Suspended'), 'status') === 'True',
      ...(typeof podUid === 'string' ? { podUid } : {}) };
  }

  async credentials(name: string, token: IssuedToken, force = false): Promise<void> {
    const previous = this.delivered.get(name);
    if (!force && previous?.id === token.id && previous.expiresAt > Date.now() + 60_000) return;
    await this.input(['create', '--raw', `/api/v1/namespaces/${this.namespace}/pods/${name}:8081/proxy/credentials`, '-f', '-'], token);
    this.delivered.set(name, token);
  }

  forgetMode(name: string): void {
    this.modes.delete(name);
  }

  async mode(name: string, operatingMode: 'Running' | 'Suspended'): Promise<void> {
    if (this.modes.get(name) === operatingMode) return;
    // Forget the old mode because a failed reply may still mean the patch was applied.
    this.modes.delete(name);
    await this.input(['patch', `sandbox/${name}`, '--type=merge', '-p', JSON.stringify({ spec: { operatingMode } })], {});
    // Remember only successful patches so a failed request is retried.
    this.modes.set(name, operatingMode);
  }
}
