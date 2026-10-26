import { spawn, execFile as execFileCallback } from 'node:child_process';
import type { IssuedToken } from '@opencrane/auth';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

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
  outdated?: boolean;
  podUid?: string;
}

/** Read computer identity and deliver short-lived grants through authenticated Pod exec. */
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
    const commandArgs = this.args(args);
    function sendInput(resolve: () => void, reject: (error: Error) => void) {
      const stdio: ['pipe', 'ignore', 'pipe'] = ['pipe', 'ignore', 'pipe'];
      const options = { stdio,
        timeout: 30_000, killSignal: 'SIGKILL' as const };
      const child = spawn('kubectl', commandArgs, options);
      let error = '';
      function recordError(chunk: Buffer) {
        error += chunk.toString();
      }
      function finished(code: number | null) {
        if (code === 0) resolve();
        else reject(new Error(`kubectl failed: ${error.trim()}`));
      }
      child.stderr.on('data', recordError);
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('exit', finished);
      child.stdin.end(JSON.stringify(object));
    }
    return new Promise(sendInput);
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
      if (sandboxName !== name) {
        throw new Error('Computer claim has a different Sandbox name');
      }
      if (typeof sandboxName === 'string') {
        const sandbox = await this.get('sandbox', sandboxName);
        const uid = value(sandbox, 'metadata', 'uid');
        if (typeof uid === 'string' && await this.get('pvc', `home-${sandboxName}`)) {
          await this.bindClaim(name, assistantId, claim, sandbox);
          return uid;
        }
      }
      await delay(100);
    }
    throw new Error('Timed out waiting for Sandbox and PVC');
  }

  private async isOutdated(name: string): Promise<boolean> {
    const patch = { spec: { operatingMode: 'Running' } };
    try {
      await this.run('patch', `sandbox/${name}`, '--type=merge', '--dry-run=server',
        '-p', JSON.stringify(patch));
      return false;
    } catch (error) {
      // Treat only admission refusal as drift. Network and RBAC errors need a retry.
      const policyName = `${this.namespace}-computer-sandbox`;
      if (error instanceof Error && error.message.includes(policyName)
        && error.message.includes('denied')) {
        return true;
      }
      throw error;
    }
  }

  async upgrade(name: string, assistantId: string): Promise<void> {
    const sandbox = await this.get('sandbox', name);
    if (!sandbox) throw new Error('Computer Sandbox is missing');
    assertComputerLabels(sandbox, name, assistantId);
    if (!isFullySuspended(sandbox) || await this.get('pod', name)) {
      throw new Error('Computer must be suspended with no Pod before upgrading');
    }
    const pvc = await this.get('pvc', `home-${name}`);
    assertHomeOwnership(pvc, sandbox, name);
    const template = await this.get('sandboxtemplate', this.pool);
    const podTemplate = checkedComputerTemplate(template, sandbox, name);
    const spec = value(sandbox, 'spec');
    if (typeof spec !== 'object' || spec === null) throw new Error('Invalid Sandbox spec');
    // Keep the resource version and all other fields from this read. Refuse a competing update.
    Reflect.set(spec, 'podTemplate', podTemplate);
    await this.input(['replace', '-f', '-'], sandbox);
    this.forgetMode(name);
    this.delivered.delete(name);
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
      return Array.isArray(owners) && owners.some((owner: unknown) => value(owner, 'uid') === uid);
    });
    const podUid = value(pod, 'metadata', 'uid');
    const podConditions = value(pod, 'status', 'conditions');
    const podReady = Array.isArray(podConditions) && podConditions.some((c: unknown) => value(c, 'type') === 'Ready' && value(c, 'status') === 'True');
    return {
      uid, outdated: await this.isOutdated(name),
      ready: value(ready, 'status') === 'True' && podReady,
      suspended: isFullySuspended(sandbox),
      ...(typeof podUid === 'string' ? { podUid } : {}) };
  }

  async credentials(name: string, token: IssuedToken, verifier?: object, force = false): Promise<void> {
    const previous = this.delivered.get(name);
    if (!force && previous?.id === token.id && previous.expiresAt > Date.now() + 60_000) return;
    const command = ['exec', '-i', name, '-c', 'computer', '--',
      '/usr/bin/env', '-u', 'NODE_OPTIONS', '/usr/local/bin/node', '--disable-sigusr1',
      '--experimental-strip-types', '/app/src/install-credential.ts'];
    const delivery = { ...token, verifier };
    await this.input(command, delivery);
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

export function assertComputerLabels(sandbox: unknown, name: string, assistantId: string): void {
  const labels = value(sandbox, 'spec', 'podTemplate', 'metadata', 'labels');
  if (value(labels, 'sandbox.users.io/assistant') !== assistantId
    || value(labels, 'sandbox.users.io/computer') !== name) {
    throw new Error('Retained Sandbox belongs to another computer or assistant');
  }
}

export function isFullySuspended(sandbox: unknown): boolean {
  if (value(sandbox, 'spec', 'operatingMode') !== 'Suspended') return false;
  const conditions = value(sandbox, 'status', 'conditions');
  if (!Array.isArray(conditions)) return false;
  function confirmsNoPod(condition: unknown): boolean {
    return value(condition, 'type') === 'Suspended' && value(condition, 'status') === 'True'
      && value(condition, 'reason') === 'PodTerminated'
      && value(condition, 'observedGeneration') === value(sandbox, 'metadata', 'generation');
  }
  return conditions.some(confirmsNoPod);
}

export function assertHomeOwnership(pvc: unknown, sandbox: unknown, name: string): void {
  if (!pvc || value(pvc, 'metadata', 'labels', 'sandbox.users.io/computer') !== name) {
    throw new Error('Retained computer has no matching home volume');
  }
  const owners = value(pvc, 'metadata', 'ownerReferences');
  function ownsHome(owner: unknown): boolean {
    return value(owner, 'kind') === 'Sandbox' && value(owner, 'name') === name
      && value(owner, 'uid') === value(sandbox, 'metadata', 'uid')
      && value(owner, 'controller') === true;
  }
  if (!Array.isArray(owners) || owners.length !== 1 || !owners.every(ownsHome)) {
    throw new Error('Retained home volume belongs to another resource');
  }
}

function checkedComputerTemplate(template: unknown, sandbox: unknown, name: string): object {
  const podTemplate = structuredClone(value(template, 'spec', 'podTemplate'));
  const spec = value(podTemplate, 'spec');
  const volumes = value(spec, 'volumes');
  const labels = value(podTemplate, 'metadata', 'labels');
  if (typeof podTemplate !== 'object' || podTemplate === null || !Array.isArray(volumes)
    || typeof labels !== 'object' || labels === null) {
    throw new Error('Checked computer template is missing');
  }
  // Preserve the controller's identity labels as well as the computer and assistant labels.
  const metadata = structuredClone(value(sandbox, 'spec', 'podTemplate', 'metadata'));
  Reflect.set(podTemplate, 'metadata', metadata);
  for (let index = 0; index < volumes.length; index++) {
    if (value(volumes[index], 'name') === 'home') {
      volumes[index] = { name: 'home', persistentVolumeClaim: { claimName: `home-${name}` } };
    }
  }
  return podTemplate;
}
