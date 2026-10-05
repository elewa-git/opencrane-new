import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { SandboxClient } from '../src/kubernetes.ts';

function outputLines(output: string) {
  const trimmed = output.trim();
  return trimmed.split('\n');
}

async function patchesChangedModes() {
  const directory = await mkdtemp(`${tmpdir()}/kubectl-mode-`);
  const previousPath = process.env['PATH'];
  const calls = `${directory}/calls`;
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
cat >/dev/null
`;
  await writeFile(`${directory}/kubectl`, script, { mode: 0o700 });
  process.env['PATH'] = `${directory}:${previousPath ?? ''}`;
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    await kube.mode('computer', 'Suspended');
    await kube.mode('computer', 'Suspended');
    const suspendedCalls = await readFile(calls, 'utf8');
    expect(outputLines(suspendedCalls)).toHaveLength(1);
    await kube.mode('computer', 'Running');
    await kube.mode('computer', 'Running');
    const allCalls = await readFile(calls, 'utf8');
    expect(outputLines(allCalls)).toHaveLength(2);
    const restarted = new SandboxClient('/unused-test-kubeconfig', 'test');
    await restarted.mode('computer', 'Running');
    const restartCalls = await readFile(calls, 'utf8');
    expect(outputLines(restartCalls)).toHaveLength(3);
  } finally {
    process.env['PATH'] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

it('patches a computer only when its requested mode changes', patchesChangedModes);


async function retriesAfterUnknownPatch() {
  const directory = await mkdtemp(`${tmpdir()}/kubectl-retry-`);
  const previousPath = process.env['PATH'];
  const calls = `${directory}/calls`;
  const script = `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
cat >/dev/null
case "$*" in *Suspended*) exit 1 ;; esac
`;
  await writeFile(`${directory}/kubectl`, script, { mode: 0o700 });
  process.env['PATH'] = `${directory}:${previousPath ?? ''}`;
  try {
    const kube = new SandboxClient('/unused-test-kubeconfig', 'test');
    await kube.mode('computer', 'Running');
    await expect(kube.mode('computer', 'Suspended')).rejects.toThrow('kubectl failed');
    await kube.mode('computer', 'Running');
    const allCalls = await readFile(calls, 'utf8');
    expect(outputLines(allCalls)).toHaveLength(3);
  } finally {
    process.env['PATH'] = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
}

it('reapplies the old mode after a changed patch has an unknown result', retriesAfterUnknownPatch);
