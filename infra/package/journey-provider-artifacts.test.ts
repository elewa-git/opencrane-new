import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProviderArtifacts } from './provider-disclosure.ts';

const marker = 'synthetic-disclosure-fixture';
const sources = ['local values', 'installed values', 'manifests', 'server log', 'stand-in log',
  'previous server log', 'previous stand-in log'] as const;
type Source = typeof sources[number];
type Fault = 'marked' | 'missing';

function fixturePod(app: string, name: string, containers: string[]) {
  function spec(container: string) {
    return { name: container };
  }
  function status(container: string) {
    const restartCount = container === 'models' ? 0 : 1;
    return { name: container, restartCount };
  }
  const podSpec = { containers: containers.map(spec) };
  const podStatus = { containerStatuses: containers.map(status) };
  return { metadata: { name, labels: { app } }, spec: podSpec, status: podStatus };
}

async function scanFixture(source?: Source, fault?: Fault): Promise<void> {
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
      const server = fixturePod('server', 'server-fixture', ['server', 'models']);
      const standIn = fixturePod('model-qualification', 'stand-in-fixture', ['stand-in']);
      return JSON.stringify({ items: [server, standIn] });
    }
    if (args[0] === 'get') {
      return content('manifests', '{"items":[],"note":"safe"}');
    }
    assert.equal(args[0], 'logs');
    if (args.includes('--all-containers=true')) {
      return content('server log', 'safe combined server log');
    }
    const container = args[args.indexOf('-c') + 1];
    const previous = args.includes('--previous');
    if (container === 'stand-in') {
      const label = previous ? 'previous stand-in log' : 'stand-in log';
      return content(label, 'safe stand-in log');
    }
    if (container === 'models') {
      assert.equal(previous, false, 'Collect previous logs only when the container restarted');
    }
    const label = previous ? 'previous server log' : 'server log';
    return content(label, 'safe server log');
  }
  const reader = { readLocalValues, readInstalledValues, kube };
  await checkProviderArtifacts(reader, [marker], true);
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
  await scanFixture();
}

test('the packaged scan accepts all credential-free evidence', acceptsCleanEvidence);
