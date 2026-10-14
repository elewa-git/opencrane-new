import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { SandboxClient } from '../src/kubernetes.ts';
import { fakeKubectl } from './fake-kubectl.ts';

async function patchesChangedModes() {
  const fixture = await fakeKubectl();
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    await kube.mode('computer', 'Suspended');
    await kube.mode('computer', 'Suspended');
    const suspendedCalls = await fixture.commands();
    expect(suspendedCalls).toHaveLength(1);
    await kube.mode('computer', 'Running');
    await kube.mode('computer', 'Running');
    const allCalls = await fixture.commands();
    expect(allCalls).toHaveLength(2);
    const restarted = new SandboxClient('/unused-test-kubeconfig', 'test');
    await restarted.mode('computer', 'Running');
    const restartCalls = await fixture.commands();
    expect(restartCalls).toHaveLength(3);
  } finally {
    await fixture.close();
  }
}

it('patches a computer only when its requested mode changes', patchesChangedModes);

async function retriesAfterUnknownPatch() {
  const script = 'case "$*" in *Suspended*) exit 1 ;; esac';
  const fixture = await fakeKubectl(script);
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    await kube.mode('computer', 'Running');
    await expect(kube.mode('computer', 'Suspended')).rejects.toThrow('kubectl failed');
    await kube.mode('computer', 'Running');
    const allCalls = await fixture.commands();
    expect(allCalls).toHaveLength(3);
  } finally {
    await fixture.close();
  }
}

it('reapplies the old mode after a changed patch has an unknown result', retriesAfterUnknownPatch);

async function checkedPodTemplate(): Promise<object> {
  const templatePath = new URL('../../computer/sandbox-template.json', import.meta.url);
  const template: unknown = JSON.parse(await readFile(templatePath, 'utf8'));
  if (typeof template !== 'object' || template === null) throw new Error('Invalid template');
  const spec: unknown = Reflect.get(template, 'spec');
  if (typeof spec !== 'object' || spec === null) throw new Error('Invalid template spec');
  const podTemplate: unknown = Reflect.get(spec, 'podTemplate');
  if (typeof podTemplate !== 'object' || podTemplate === null) throw new Error('Invalid Pod template');
  return podTemplate;
}

async function detectsClusterDrift(refused: boolean) {
  const podTemplate = await checkedPodTemplate();
  const sandbox = { kind: 'Sandbox', metadata: { uid: 'sandbox' }, spec: { podTemplate } };
  const bindings = JSON.stringify({ items: [sandbox, { kind: 'SandboxClaim' }] });
  const script = `case "$*" in
    *'get pods'*) printf '%s' '{"items":[]}' ;;
    *'--dry-run=server'*) ${refused ? "echo 'ValidatingAdmissionPolicy test-computer-sandbox denied' >&2; exit 1" : 'exit 0'} ;;
    *) printf '%s' '${bindings}' ;;
  esac`;
  const fixture = await fakeKubectl(script);
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    const state = await kube.state('computer');
    expect(state?.outdated).toBe(refused);
    const calls = await fixture.commands();
    expect(calls.at(-1)).toContain('--dry-run=server');
  } finally {
    await fixture.close();
  }
}

it.each([true, false])('uses cluster admission to decide drift (%s)', detectsClusterDrift);

type UpgradeGuard = 'matching' | 'assistant' | 'computer' | 'volume' | 'volume-label'
  | 'missing-volume' | 'running' | 'stale-status' | 'pod';
async function upgradesOnlySuspendedComputer(guard: UpgradeGuard) {
  const podTemplate = await checkedPodTemplate();
  const metadata = { labels: { app: 'computer', 'sandbox.users.io/assistant': 'assistant',
    'sandbox.users.io/computer': 'computer' } };
  Reflect.set(podTemplate, 'metadata', metadata);
  const sandbox = { kind: 'Sandbox', metadata: { name: 'computer', uid: 'sandbox',
    resourceVersion: '7', generation: 3 }, spec: { operatingMode: 'Suspended', podTemplate },
    status: { conditions: [{ type: 'Suspended', status: 'True', reason: 'PodTerminated',
      observedGeneration: 3 }] } };
  const pvc = { metadata: { labels: { 'sandbox.users.io/computer': 'computer' },
    ownerReferences: [{ kind: 'Sandbox', name: 'computer', uid: 'sandbox', controller: true }] } };
  if (guard === 'assistant') metadata.labels['sandbox.users.io/assistant'] = 'other';
  if (guard === 'computer') metadata.labels['sandbox.users.io/computer'] = 'other';
  if (guard === 'volume') pvc.metadata.ownerReferences[0]!.uid = 'other';
  if (guard === 'volume-label') pvc.metadata.labels['sandbox.users.io/computer'] = 'other';
  if (guard === 'running') sandbox.spec.operatingMode = 'Running';
  if (guard === 'stale-status') sandbox.status.conditions[0]!.observedGeneration = 2;
  const template = { spec: { podTemplate: await checkedPodTemplate() } };
  const script = `case "$*" in
    *'get sandbox/computer '*) printf '%s' '${JSON.stringify(sandbox)}' ;;
    *'get pvc/home-computer '*) printf '%s' '${guard === 'missing-volume' ? '' : JSON.stringify(pvc)}' ;;
    *'get pod/computer '*) printf '%s' '${guard === 'pod' ? '{"kind":"Pod"}' : ''}' ;;
    *'get sandboxtemplate/computer '*) printf '%s' '${JSON.stringify(template)}' ;;
  esac`;
  const fixture = await fakeKubectl(script);
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    if (guard !== 'matching') {
      await expect(kube.upgrade('computer', 'assistant')).rejects.toThrow();
    } else {
      await kube.upgrade('computer', 'assistant');
    }
    const calls = await fixture.commands();
    const changes = calls.filter(isUpdate);
    expect(changes).toHaveLength(guard === 'matching' ? 1 : 0);
    if (guard === 'matching') {
      const expectedTemplate = await checkedPodTemplate();
      Reflect.set(expectedTemplate, 'metadata', metadata);
      const spec: unknown = Reflect.get(expectedTemplate, 'spec');
      if (typeof spec !== 'object' || spec === null) throw new Error('Missing spec');
      const volumes: unknown = Reflect.get(spec, 'volumes');
      if (!Array.isArray(volumes)) throw new Error('Missing volumes');
      volumes[0] = { name: 'home', persistentVolumeClaim: { claimName: 'home-computer' } };
      const expected = structuredClone(sandbox);
      expected.spec.podTemplate = expectedTemplate;
      expect(await fixture.input()).toEqual(expected);
    }
    expect(calls.join('\n')).not.toMatch(/patch pvc|delete sandbox/u);
  } finally {
    await fixture.close();
  }
}
function isUpdate(command: string): boolean {
  return command.includes('replace -f -');
}
const guards: UpgradeGuard[] = ['matching', 'assistant', 'computer', 'volume', 'volume-label',
  'missing-volume', 'running', 'stale-status', 'pod'];
it.each(guards)('updates only a suspended computer with its own home (%s)',
  upgradesOnlySuspendedComputer);

async function bindsOnlySameNameClaim(otherName: boolean) {
  const claim = { metadata: { uid: 'claim', labels: { 'sandbox.users.io/assistant': 'assistant' } }, status: { sandbox: {
    name: otherName ? 'other' : 'computer' } } };
  const sandbox = { metadata: { uid: 'sandbox', ownerReferences: [{ controller: true,
    uid: 'claim' }] } };
  const script = `case "$*" in
    *'get sandboxclaim/computer '*) printf '%s' '${JSON.stringify(claim)}' ;;
    *'get sandbox/computer '*|*'get sandbox/other '*) printf '%s' '${JSON.stringify(sandbox)}' ;;
    *'get pvc/home-other '*) printf '%s' '{"metadata":{"uid":"home"}}' ;;
    *'get pvc/home-computer '*)
      counter="$(dirname "$0")/pvc-read"
      if [ -f "$counter" ]; then printf '%s' '{"metadata":{"uid":"home"}}';
      else touch "$counter"; fi ;;
  esac`;
  const fixture = await fakeKubectl(script);
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    const started = performance.now();
    if (otherName) {
      await expect(kube.claim('computer', 'assistant')).rejects.toThrow(/different Sandbox name/u);
    } else {
      await expect(kube.claim('computer', 'assistant')).resolves.toBe('sandbox');
      expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    }
    const commands = await fixture.commands();
    expect(commands.join('\n')).not.toMatch(/delete|replace|sandbox\/other/u);
  } finally {
    await fixture.close();
  }
}
it.each([true, false])('keeps the claim name and waits between reads (different: %s)',
  bindsOnlySameNameClaim);

async function deliversThroughAuthenticatedExec() {
  const fixture = await fakeKubectl();
  const token = { id: 'fixture-id', value: 'fixture-value', expiresAt: Date.now() + 60_000 };
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const verifier = keys.publicKey.export({ format: 'jwk' });
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    await kube.credentials('computer', token, verifier);
    await kube.credentials('computer', token, verifier, true);
    expect(await fixture.input()).toEqual({ ...token, verifier });
    const commands = await fixture.commands();
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain('exec -i computer -c computer -- /usr/bin/env -u NODE_OPTIONS');
      expect(command).toContain('/usr/local/bin/node --disable-sigusr1');
      expect(command).toContain('/app/src/install-credential.ts');
      expect(command).not.toContain(token.value);
      expect(command).not.toContain('/proxy/credentials');
    }
  } finally {
    await fixture.close();
  }
}
it('delivers and rotates credentials through authenticated Pod exec',
  deliversThroughAuthenticatedExec);
