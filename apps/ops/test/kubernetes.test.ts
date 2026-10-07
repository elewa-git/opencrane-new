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

async function detectsTemplateChanges(change: 'image' | 'resources' | 'labels' | 'unchanged') {
  const podTemplate = await checkedPodTemplate();
  const podSpec: unknown = Reflect.get(podTemplate, 'spec');
  if (typeof podSpec !== 'object' || podSpec === null) throw new Error('Invalid Pod spec');
  const containers: unknown = Reflect.get(podSpec, 'containers');
  if (!Array.isArray(containers)) throw new Error('Invalid containers');
  const container: unknown = containers[0];
  if (typeof container !== 'object' || container === null) throw new Error('Invalid container');
  if (change === 'image') Reflect.set(container, 'image', 'old-computer:retained');
  if (change === 'resources') Reflect.set(container, 'resources', { limits: { memory: '1Gi' } });
  if (change === 'labels') {
    const metadata = { labels: { app: 'old-computer' } };
    Reflect.set(podTemplate, 'metadata', metadata);
  }
  const sandbox = { kind: 'Sandbox', metadata: { uid: 'sandbox' }, spec: { podTemplate } };
  const claim = { kind: 'SandboxClaim' };
  const bindings = JSON.stringify({ items: [sandbox, claim] });
  const script = `case "$*" in
    *'get pods'*) printf '%s' '{"items":[]}' ;;
    *) printf '%s' '${bindings}' ;;
  esac`;
  const fixture = await fakeKubectl(script);
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    const state = await kube.state('computer');
    expect(state?.outdated).toBe(change !== 'unchanged');
  } finally {
    await fixture.close();
  }
}

it.each(['image', 'resources', 'labels', 'unchanged'] as const)(
  'compares the retained template with the checked template (%s)', detectsTemplateChanges);

async function retainsHomeBeforeDeletingSandbox(ownership: 'matching' | 'assistant' | 'volume') {
  const sandbox = { metadata: { uid: 'sandbox' }, spec: { podTemplate: { metadata: {
    labels: { 'sandbox.users.io/assistant': 'assistant', 'sandbox.users.io/computer': 'computer' },
  } } } };
  const pvc = { metadata: { resourceVersion: '7',
    labels: { 'sandbox.users.io/computer': 'computer' },
    ownerReferences: [{ kind: 'Sandbox', name: 'computer', uid: 'sandbox', controller: true }],
  } };
  if (ownership === 'assistant') {
    sandbox.spec.podTemplate.metadata.labels['sandbox.users.io/assistant'] = 'another-assistant';
  }
  if (ownership === 'volume') pvc.metadata.ownerReferences[0]!.uid = 'another-sandbox';
  const script = `case "$*" in
    *'get sandbox/computer '*) printf '%s' '${JSON.stringify(sandbox)}' ;;
    *'get pvc/home-computer '*) printf '%s' '${JSON.stringify(pvc)}' ;;
  esac`;
  const fixture = await fakeKubectl(script);
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    if (ownership !== 'matching') {
      await expect(kube.replace('computer', 'assistant')).rejects.toThrow(/another/u);
      const refusedCalls = await fixture.commands();
      expect(refusedCalls.join('\n')).not.toContain('patch pvc');
      expect(refusedCalls.join('\n')).not.toContain('delete sandbox');
      return;
    }
    await kube.replace('computer', 'assistant');
    const calls = await fixture.commands();
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain('patch pvc/home-computer');
    expect(calls[2]).toContain('"resourceVersion":"7","ownerReferences":[]');
    expect(calls[3]).toContain('delete sandbox/computer --cascade=background --wait=true');
    expect(calls.join('\n')).not.toContain('delete pvc');
  } finally {
    await fixture.close();
  }
}

it.each(['matching', 'assistant', 'volume'] as const)(
  'preserves home and checks ownership before replacement (%s)', retainsHomeBeforeDeletingSandbox);
