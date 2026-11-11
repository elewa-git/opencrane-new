import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import { computerExecCommand, readK3dComputer, spawnComputerExec,
  type K3dComputer } from './computer-runtime.ts';

const context = 'k3d-ocn';
const namespace = `opencrane-target2-test-${randomUUID().slice(0, 8)}`;
const podName = 'computer-probe';
const image = 'k3d-ocn-registry:5000/opencrane/computer@sha256:' +
  'ddbd61e7b3efd8d78a46e53611e332a11cfe110d844a6bd5a277f9bd3a8b6e21';
let target: K3dComputer;

function command(program: string, args: string[], input?: string): string {
  const options = { input, timeout: 130_000, maxBuffer: 1_048_576,
    encoding: 'utf8' as const, stdio: 'pipe' as const };
  return execFileSync(program, args, options).trim();
}

function kubectl(args: string[], input?: string): string {
  return command('/usr/local/bin/kubectl', [`--context=${context}`, ...args], input);
}

function nodeCommand(nodeId: string, args: string[]): string {
  return command('/usr/bin/docker', ['exec', nodeId, 'crictl', ...args]);
}

const metaSchema = z.object({ metadata: z.object({ uid: z.string() }) });
const statusSchema = z.object({ containerID: z.string(), imageID: z.string(),
  state: z.object({ running: z.object({ startedAt: z.string() }) }) });
const podSchema = metaSchema.extend({ spec: z.object({ nodeName: z.string() }),
  status: z.object({ containerStatuses: z.array(statusSchema) }) });
const dockerNodeSchema = z.array(z.object({ Id: z.string() }));
const criSchema = z.object({ status: z.object({ startedAt: z.string() }) });

function waitForClose(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  function closed(resolve: (code: number | null) => void): void {
    child.on('close', resolve);
  }
  return new Promise(closed);
}

function checkPath(path: string): string {
  return `if test -r ${path}; then echo ${path}=readable; ` +
    `else echo ${path}=missing; fi`;
}

function startFixture(): void {
  if (process.env['K3D_COMPUTER_FIXTURE'] !== '1') {
    return;
  }
  kubectl(['create', 'namespace', namespace]);
  const pod = {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: podName, namespace, labels: { app: 'computer' } },
    spec: { runtimeClassName: 'gvisor', automountServiceAccountToken: false,
      restartPolicy: 'Never', containers: [{ name: 'computer', image,
        command: ['/bin/sh', '-c', 'sleep 300'],
        securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] } },
        resources: { limits: { memory: '512Mi' } } }] },
  };
  kubectl(['apply', '-f', '-'], JSON.stringify(pod));
  kubectl(['-n', namespace, 'wait', `pod/${podName}`, '--for=condition=Ready',
    '--timeout=120s']);
  const namespaceObject = metaSchema.parse(JSON.parse(kubectl(['get', 'namespace', namespace,
    '-o', 'json'])));
  const podObject = podSchema.parse(JSON.parse(kubectl(['-n', namespace, 'get', 'pod',
    podName, '-o', 'json'])));
  const nodeName = podObject.spec.nodeName;
  const nodeObject = metaSchema.parse(JSON.parse(kubectl(['get', 'node', nodeName,
    '-o', 'json'])));
  const dockerNode = dockerNodeSchema.parse(JSON.parse(command('/usr/bin/docker',
    ['inspect', '--type', 'container', nodeName])));
  const status = podObject.status.containerStatuses[0];
  if (!status || !dockerNode[0]) {
    throw new Error('fixture_identity_unreadable');
  }
  const containerId = status.containerID.replace(/^containerd:\/\//u, '');
  const cri = criSchema.parse(JSON.parse(nodeCommand(dockerNode[0].Id,
    ['inspect', containerId])));
  target = { kind: 'k3d', namespace, namespaceUid: namespaceObject.metadata.uid,
    podName, podUid: podObject.metadata.uid, nodeName, nodeUid: nodeObject.metadata.uid,
    nodeContainerId: dockerNode[0].Id, containerName: 'computer',
    containerId,
    image: status.imageID, runtime: 'io.containerd.runsc.v1',
    startedAt: status.state.running.startedAt, criStartedAt: cri.status.startedAt };
}
beforeAll(startFixture, 180_000);

function stopFixture(): void {
  if (process.env['K3D_COMPUTER_FIXTURE'] === '1') {
    kubectl(['delete', 'namespace', namespace, '--wait=true', '--timeout=120s',
      '--ignore-not-found']);
  }
}
afterAll(stopFixture, 180_000);

async function checksGvisorIdentityAndExec(): Promise<void> {
    expect(readK3dComputer(target)).toEqual(target);
    const child = spawnComputerExec(target, ['/bin/sh', '-c', 'cat >/dev/null; echo EOF']);
    child.stdin.end('fixture\n');
    let output = '';
    for await (const chunk of child.stdout) {
      output += String(chunk);
    }
    const exit = await waitForClose(child);
    expect(output).toContain('EOF');
    expect(exit).toBe(0);
    expect(readK3dComputer(target)).toEqual(target);
    const paths = ['/proc/self/cgroup', '/proc/self/limits',
      '/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.swap.max',
      '/sys/fs/cgroup/memory.swap.current'];
    const checks = paths.map(checkPath);
    const measurement = command('/usr/bin/docker', computerExecCommand(target,
      ['/bin/sh', '-c', checks.join('; ')]));
    console.info(`gVisor guest controls: ${measurement.replaceAll('\n', ', ')}`);
    for (const path of paths) {
      expect(measurement).toContain(`${path}=`);
    }
    const helper = command('/usr/bin/docker', computerExecCommand(target,
      ['/bin/sh', '-c', 'if test -f /scripts/private-memory-qualification/' +
        'runner-protection.ts; then echo present; else echo absent; fi']));
    console.info(`fixture protection helper: ${helper}`);
    const bad = spawnComputerExec(target, ['/bin/sh', '-c', 'exit 23']);
    bad.stdin.end();
    const badExit = await waitForClose(bad);
    // Treat status 1 as a refusal; crictl does not preserve the remote status 23.
    expect(badExit).toBe(1);
    const timeoutCommand = computerExecCommand(target, ['/bin/sh', '-c',
      'echo $$; exec sleep 30']);
    const limitIndex = timeoutCommand.indexOf('120');
    timeoutCommand[limitIndex] = '1';
    const timed = spawn('/usr/bin/docker', timeoutCommand, { stdio: 'pipe' });
    let timedOutput = '';
    function collectPid(chunk: Buffer): void {
      timedOutput += chunk.toString('utf8');
    }
    timed.stdout.on('data', collectPid);
    timed.stdin.end();
    const timedExit = await waitForClose(timed);
    expect(timedExit).not.toBe(0);
    const remotePid = timedOutput.trim();
    expect(remotePid).toMatch(/^[1-9][0-9]*$/u);
    expect(() => command('/usr/bin/docker', computerExecCommand(target,
      ['/bin/sh', '-c', `kill -0 ${remotePid}`]))).toThrow();
}
it.skipIf(process.env['K3D_COMPUTER_FIXTURE'] !== '1')(
  'checks the real gVisor identity and bounded exec behaviour',
  checksGvisorIdentityAndExec, 60_000);
