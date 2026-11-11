import type { K3dComputer } from './computer-runtime.ts';

function hex(digit: string): string {
  return digit.repeat(64);
}

export function k3dComputerFixture(): K3dComputer {
  return {
    kind: 'k3d',
    namespace: 'opencrane-dev-1',
    namespaceUid: 'namespace-uid',
    podName: 'computer-test',
    podUid: 'pod-uid',
    nodeName: 'k3d-ocn-server-0',
    nodeUid: 'node-uid',
    nodeContainerId: hex('a'),
    containerName: 'computer',
    containerId: hex('b'),
    image: `registry/computer@sha256:${hex('c')}`,
    runtime: 'io.containerd.runsc.v1',
    startedAt: '2026-11-11T00:00:00Z',
    criStartedAt: '2026-11-11T00:00:00.000000000Z',
  };
}
