import { expect, it, vi } from 'vitest';
import { root } from '../dev-stack/config.ts';
import { ownsPackageForwarder, packageForwardArgs } from './package-forwarder.ts';

const fixture = vi.hoisted(function forwardingProcessFixture() {
  return { sockets: '', files: new Map<string, string>(), directory: '' };
});

vi.mock('node:child_process', function socketsBoundary() {
  function execFile(_program: string, _args: string[], _options: unknown,
    callback: (error: null, output: { stdout: string }) => void) {
    callback(null, { stdout: fixture.sockets });
  }
  return { execFile };
});

vi.mock('node:fs/promises', function processesBoundary() {
  async function readFile(path: string) {
    const content = fixture.files.get(path);
    if (content === undefined) throw new Error('Unexpected process path');
    return content;
  }
  async function readlink() {
    return fixture.directory;
  }
  return { readFile, readlink };
});

const origin = 'http://127.0.0.1:25106';
const args = packageForwardArgs(['--context=package-test'], 'package-test', origin);
const checked = { clusterUid: 'cluster-checked', namespaceUid: 'namespace-checked' };
const socket = 'LISTEN 0 10 127.0.0.1:25106 0.0.0.0:* users:(("kubectl",pid=123,fd=3))';

function runningForwarder(clusterUid = checked.clusterUid, namespaceUid = checked.namespaceUid) {
  fixture.sockets = socket;
  fixture.directory = root;
  const identity = `OPENCRANE_FORWARD_TARGET=${clusterUid}/${namespaceUid}\0`;
  fixture.files = new Map([
    ['/proc/123/cmdline', ['kubectl', ...args, ''].join('\0')],
    ['/proc/123/status', 'PPid:\t321\n'],
    ['/proc/123/environ', identity],
    ['/proc/321/cmdline', 'node\0--experimental-strip-types\0infra/package/forward.ts\0'],
  ]);
}

it('accepts the supervised process for the checked cluster and namespace', async function accepts() {
  runningForwarder();
  expect(await ownsPackageForwarder(origin, args, checked)).toBe(true);
});

it('refuses a supervised process for another cluster with identical arguments', async function staleCluster() {
  runningForwarder('cluster-retired');
  expect(await ownsPackageForwarder(origin, args, checked)).toBe(false);
});

it('refuses a supervised process for the previous namespace with identical arguments', async function staleNamespace() {
  runningForwarder(checked.clusterUid, 'namespace-retired');
  expect(await ownsPackageForwarder(origin, args, checked)).toBe(false);
});

for (const [check, changedSocket] of [
  ['two sockets', `${socket}\n${socket}`],
  ['wrong address', socket.replace('127.0.0.1:25106', '0.0.0.0:25106')],
  ['other process name', socket.replace('"kubectl"', '"node"')],
] as const) {
  async function refusesSocket() {
    runningForwarder();
    fixture.sockets = changedSocket;
    expect(await ownsPackageForwarder(origin, args, checked)).toBe(false);
  }
  it(`refuses a listener with ${check}`, refusesSocket);
}

for (const [check, file, content] of [
  ['different kubectl arguments', '/proc/123/cmdline', 'kubectl\0port-forward\0wrong-service\0'],
  ['missing parent process', '/proc/123/status', 'State:\trunning\n'],
  ['different launcher', '/proc/321/cmdline', 'node\0other-launcher.ts\0'],
  ['missing target identity', '/proc/123/environ', 'UNRELATED_SETTING=fixture\0'],
] as const) {
  async function refusesProcess() {
    runningForwarder();
    fixture.files.set(file, content);
    expect(await ownsPackageForwarder(origin, args, checked)).toBe(false);
  }
  it(`refuses a socket when its process has ${check}`, refusesProcess);
}

async function refusesOtherCheckout() {
  runningForwarder();
  fixture.directory = '/disposable/other-checkout';
  expect(await ownsPackageForwarder(origin, args, checked)).toBe(false);
}

it('refuses a launcher in another checkout', refusesOtherCheckout);
