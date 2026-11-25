import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProviderArtifacts } from './provider-disclosure.ts';

const marker = 'synthetic-disclosure-fixture';
const sources = ['local values', 'installed values', 'manifests', 'server log', 'stand-in log',
  'previous server log', 'previous stand-in log'] as const;
type Source = typeof sources[number];
type Fault = 'marked' | 'missing';
type QuietLog = 'models' | 'storage-credentials';

function fixturePod(app: string, name: string, containers: string[]) {
  function spec(container: string) {
    return { name: container };
  }
  function status(container: string) {
    const restartCount = container === 'server' || container === 'stand-in' ? 1 : 0;
    return { name: container, restartCount };
  }
  const podSpec = { containers: containers.map(spec) };
  const podStatus = { containerStatuses: containers.map(status) };
  return { metadata: { name, labels: { app } }, spec: podSpec, status: podStatus };
}

async function scanFixture(source?: Source, fault?: Fault, unavailable?: QuietLog) {
  function content(label: Source, safe: string): string {
    if (label === source && fault === 'marked') {
      return safe.replace('safe', marker);
    }
    if (label === source && fault === 'missing') {
      return '';
    }
    return safe;
  }
  async function readLocalValues(): Promise<string> {
    return content('local values', '{"note":"safe"}');
  }
  async function readInstalledValues(): Promise<string> {
    return content('installed values', '{"note":"safe"}');
  }
  async function kube(args: string[]): Promise<string> {
    if (args[0] === 'get' && args[1] === 'pods') {
      const containers = ['server', 'storage-credentials', 'models'];
      const server = fixturePod('server', 'server-fixture', containers);
      const standIn = fixturePod('model-qualification', 'stand-in-fixture', ['stand-in']);
      return JSON.stringify({ items: [server, standIn] });
    }
    if (args[0] === 'get') {
      return content('manifests', '{"items":[{"note":"safe"}]}');
    }
    assert.equal(args[0], 'logs');
    const container = args[args.indexOf('-c') + 1];
    const previous = args.includes('--previous');
    if (container === 'stand-in') {
      const label = previous ? 'previous stand-in log' : 'stand-in log';
      return content(label, 'safe stand-in log');
    }
    if (container === 'models' || container === 'storage-credentials') {
      assert.equal(previous, false, 'Collect previous logs only when the container restarted');
      if (container === unavailable) {
        throw new Error('The log request failed');
      }
      return '';
    }
    const label = previous ? 'previous server log' : 'server log';
    return content(label, 'safe server log');
  }
  const reader = { readLocalValues, readInstalledValues, kube };
  return checkProviderArtifacts(reader, [marker]);
}

for (const source of sources) {
  async function refusesMarker(): Promise<void> {
    const scan = scanFixture(source, 'marked');
    await assert.rejects(scan, /artifact disclosed a key/u);
  }
  test(`the packaged scan refuses a marker in ${source}`, refusesMarker);

  async function refusesMissingSource(): Promise<void> {
    const scan = scanFixture(source, 'missing');
    await assert.rejects(scan, /Missing .+ evidence/u);
  }
  test(`the packaged scan refuses missing ${source}`, refusesMissingSource);
}

async function acceptsCleanEvidence(): Promise<void> {
  const checked = await scanFixture();
  assert.deepEqual(checked, { checkedCurrentLogs: 4, checkedPreviousLogs: 2 });
}

test('the packaged scan accepts a successful empty log read from a quiet sidecar',
  acceptsCleanEvidence);

async function refusesUnavailableSidecarLog(): Promise<void> {
  const scan = scanFixture(undefined, undefined, 'storage-credentials');
  await assert.rejects(scan, /The log request failed/u);
}

test('a failed log read from a quiet sidecar still fails the scan', refusesUnavailableSidecarLog);
