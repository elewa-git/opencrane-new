import assert from 'node:assert/strict';

export function isServer(container) {
  return container.name === 'server';
}

export function isEvidenceSource(volume) {
  return volume.name === 'evidence-source';
}

export function assertScannerFiles(source, secret) {
  const trust = { secret: { name: secret, items: [
    { key: 'server.key', path: 'server.key' },
    { key: 'server.crt', path: 'server.crt' },
    { key: 'trust.json', path: 'trust.json' },
  ] } };
  const release = { secret: { name: secret, items: [
    { key: 'signatures.json', path: 'signatures.json' },
    { key: 'release.json', path: 'release.json' },
  ] } };
  assert.deepEqual(source.projected.sources, [trust, release]);
}
