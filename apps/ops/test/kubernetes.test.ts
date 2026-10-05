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
