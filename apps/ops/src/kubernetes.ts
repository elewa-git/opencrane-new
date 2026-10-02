import { spawn, execFile as execFileCallback } from 'node:child_process';
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
  readyChangedAt?: string;
}

/** Minimal kubectl adapter; the configured identity never needs Pod access. */
export class SandboxClient {
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
      const sandboxName = value(claim, 'status', 'sandbox', 'name');
      if (typeof sandboxName === 'string') {
        const sandbox = await this.get('sandbox', sandboxName);
        const uid = value(sandbox, 'metadata', 'uid');
        if (typeof uid === 'string' && await this.get('pvc', `home-${sandboxName}`)) return uid;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting for Sandbox and PVC');
  }

  async state(name: string): Promise<SandboxState | undefined> {
    const sandbox = await this.get('sandbox', name);
    if (!sandbox) return undefined;
    const conditions = value(sandbox, 'status', 'conditions');
    const list: unknown[] = Array.isArray(conditions) ? conditions : [];
    const condition = (type: string) => list.find((item) => value(item, 'type') === type);
    const ready = condition('Ready');
    const uid = value(sandbox, 'metadata', 'uid');
    if (typeof uid !== 'string') throw new Error('Sandbox has no UID');
    const readyChangedAt = value(ready, 'lastTransitionTime');
    return { uid, ready: value(ready, 'status') === 'True',
      suspended: value(condition('Suspended'), 'status') === 'True',
      ...(typeof readyChangedAt === 'string' ? { readyChangedAt } : {}) };
  }

  async mode(name: string, operatingMode: 'Running' | 'Suspended'): Promise<void> {
    await this.input(['patch', `sandbox/${name}`, '--type=merge', '-p', JSON.stringify({ spec: { operatingMode } })], {});
  }
}
