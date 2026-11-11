import { describe, expect, it } from 'vitest';
import { computerExecCommand, verifyK3dComputer,
  type K3dComputer } from './computer-runtime.ts';
import { k3dComputerFixture } from './computer-runtime-fixture.ts';

const hex = (digit: string): string => digit.repeat(64);
const expected: K3dComputer = k3dComputerFixture();

const observed = {
  namespace: { metadata: { uid: expected.namespaceUid } },
  pod: { metadata: { uid: expected.podUid, namespace: expected.namespace },
    spec: { nodeName: expected.nodeName, runtimeClassName: 'gvisor',
      containers: [{ name: 'computer' }] },
    status: { phase: 'Running', containerStatuses: [{ name: 'computer', ready: true,
      restartCount: 0, containerID: `containerd://${expected.containerId}`,
      imageID: expected.image, state: { running: { startedAt: expected.startedAt } } }] } },
  node: { metadata: { uid: expected.nodeUid, name: expected.nodeName } },
  dockerNode: { Id: expected.nodeContainerId, State: { Running: true } },
  criContainer: { info: { sandboxID: hex('e'), runtimeType: expected.runtime },
    status: { id: expected.containerId, state: 'CONTAINER_RUNNING',
    imageRef: expected.image, startedAt: expected.criStartedAt,
    labels: { 'io.kubernetes.pod.uid': expected.podUid,
      'io.kubernetes.container.name': expected.containerName } } },
  criPod: { info: { runtimeType: expected.runtime },
    status: { id: hex('e'), state: 'SANDBOX_READY',
      metadata: { uid: expected.podUid, namespace: expected.namespace },
      runtimeHandler: 'runsc' } },
};

describe('checked k3d computer identity', () => {
  it('accepts the full matching generation', () => {
    expect(verifyK3dComputer(expected, observed)).toEqual(expected);
  });

  it('executes by full node and CRI ids with a remote limit', () => {
    const command = computerExecCommand(expected, ['/usr/local/bin/node', '--version']);
    expect(command).toContain(expected.nodeContainerId);
    expect(command).toContain(expected.containerId);
    expect(command).not.toContain(expected.podName);
    const timeoutIndex = command.indexOf('/usr/bin/timeout');
    expect(timeoutIndex).toBeGreaterThan(0);
    expect(command.slice(timeoutIndex, timeoutIndex + 6))
      .toEqual(['/usr/bin/timeout', '-s', 'TERM', '-k', '15', '250']);
  });

  it.each([
    ['namespace', { namespace: { metadata: { uid: 'other' } } }],
    ['Pod', { pod: { ...observed.pod,
      metadata: { ...observed.pod.metadata, uid: 'other' } } }],
    ['node', { node: { metadata: { ...observed.node.metadata, uid: 'other' } } }],
    ['node container', { dockerNode: { Id: hex('d'), State: { Running: true } } }],
    ['container', { criContainer: { ...observed.criContainer,
      status: { ...observed.criContainer.status, id: hex('d') } } }],
    ['image', { criContainer: { ...observed.criContainer,
      status: { ...observed.criContainer.status,
        imageRef: `registry/computer@sha256:${hex('d')}` } } }],
    ['runtime', { criPod: { ...observed.criPod,
      status: { ...observed.criPod.status, runtimeHandler: 'runc' } } }],
    ['RuntimeClass', { pod: { ...observed.pod,
      spec: { ...observed.pod.spec, runtimeClassName: 'runc' } } }],
    ['CRI runtime', { criContainer: { ...observed.criContainer,
      info: { ...observed.criContainer.info, runtimeType: 'io.containerd.runc.v2' } } }],
    ['restart', { pod: { ...observed.pod, status: { ...observed.pod.status,
      containerStatuses: [{ ...observed.pod.status.containerStatuses[0], restartCount: 1 }] } } }],
    ['replacement', { pod: { ...observed.pod, status: { ...observed.pod.status,
      containerStatuses: [{ ...observed.pod.status.containerStatuses[0],
        containerID: `containerd://${hex('d')}` }] } } }],
    ['restarted generation', { criContainer: { ...observed.criContainer,
      status: { ...observed.criContainer.status,
        startedAt: '2026-11-11T00:01:00.000000000Z' } } }],
  ])('refuses a changed %s', (_name, change) => {
    expect(() => verifyK3dComputer(expected, { ...observed, ...change }))
      .toThrow('private_process_identity_changed');
  });
});
