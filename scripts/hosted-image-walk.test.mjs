import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { test, vi } from 'vitest';
import { scanHostedImage } from '../infra/clamav/image-walk.mjs';

function createCleanupState() {
  return { active: false };
}
const cleanupFailure = vi.hoisted(createCleanupState);
async function mockFileSystem(importOriginal) {
  const actual = await importOriginal();
  async function removeScratch(path, options) {
    if (cleanupFailure.active && String(path).includes('hosted-image-scan-')) {
      await actual.rm(path, options);
      throw new Error(`EACCES: ${path}`);
    }
    return actual.rm(path, options);
  }
  return { ...actual, rm: removeScratch };
}
vi.mock('node:fs/promises', mockFileSystem);

const execute = promisify(execFile);
const walker = fileURLToPath(new URL('../infra/clamav/image-walk.py', import.meta.url));

const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const scanner = { imageDigest: `sha256:${'a'.repeat(64)}`,
  manifestDigest: `sha256:${'b'.repeat(64)}` };
const binding = { silo: 'test', serverId: 'demo', attemptId: 1,
  platform: 'linux/amd64' };
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function tar(files) {
  const blocks = [];
  for (const file of files) {
    const bytes = file.bytes ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'ascii');
    header.write('0000000\0', 108, 'ascii');
    header.write('0000000\0', 116, 'ascii');
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.write('00000000000\0', 136, 'ascii');
    header.fill(32, 148, 156);
    header.write(file.type ?? '0', 156, 'ascii');
    header.write(file.link ?? '', 157, 100, 'utf8');
    header.write('ustar\0', 257, 'ascii');
    let checksum = 0;
    for (const value of header) checksum += value;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (`${length}`.length + body.length !== length) {
    length = `${length}`.length + body.length;
  }
  return `${length}${body}`;
}
function sparseTar() {
  const files = [];
  for (let index = 0; index < 27; index++) {
    const name = `sparse-${index}`;
    const records = [
      paxRecord('GNU.sparse.map', '0,1,20971520,0'),
      paxRecord('GNU.sparse.realsize', '20971520'),
      paxRecord('GNU.sparse.name', name),
    ];
    files.push({ name: `pax-${index}`, type: 'x', bytes: Buffer.from(records.join('')) });
    files.push({ name, bytes: Buffer.from('x') });
  }
  return tar(files);
}
function fixture(layerFiles, compressed = false) {
  const layers = layerFiles.map(files => {
    const expanded = tar(files);
    const bytes = compressed ? gzipSync(expanded) : expanded;
    return { bytes, digest: `sha256:${hash(bytes)}`,
      diffId: `sha256:${hash(expanded)}`,
      mediaType: compressed ? 'application/vnd.oci.image.layer.v1.tar+gzip' :
        'application/vnd.oci.image.layer.v1.tar' };
  });
  const config = Buffer.from(JSON.stringify({ os: 'linux', architecture: 'amd64',
    rootfs: { diff_ids: layers.map(layer => layer.diffId) } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { digest: `sha256:${hash(config)}`, size: config.length },
    layers: layers.map(layer => ({ digest: layer.digest, size: layer.bytes.length,
      mediaType: layer.mediaType })) }));
  return { ...binding, imageDigest: hash(manifest), manifest, config, layers };
}
function replaceFirstLayer(image, bytes) {
  const changed = structuredClone(image);
  changed.layers[0].bytes = bytes;
  changed.layers[0].digest = `sha256:${hash(bytes)}`;
  changed.layers[0].diffId = `sha256:${hash(bytes)}`;
  const config = JSON.parse(Buffer.from(changed.config).toString());
  config.rootfs.diff_ids[0] = changed.layers[0].diffId;
  changed.config = Buffer.from(JSON.stringify(config));
  const manifest = JSON.parse(Buffer.from(changed.manifest).toString());
  manifest.config.digest = `sha256:${hash(changed.config)}`;
  manifest.config.size = changed.config.length;
  manifest.layers[0].digest = changed.layers[0].digest;
  manifest.layers[0].size = bytes.length;
  changed.manifest = Buffer.from(JSON.stringify(manifest));
  changed.imageDigest = hash(changed.manifest);
  return changed;
}
function recordingScanner(seen, outcome = 'clean') {
  return async function scan(_settings, bytes, partBinding) {
    seen.push({ bytes: Buffer.from(bytes), binding: { ...partBinding } });
    const original = hash(bytes);
    const expected = JSON.stringify(partBinding);
    const approved = JSON.stringify(scanner);
    return function validate(currentBytes, currentBinding, currentSettings) {
      if (hash(currentBytes) !== original || JSON.stringify(currentBinding) !== expected ||
          JSON.stringify(currentSettings) !== approved) throw new Error('stale part');
      return bytes.includes(eicar) ? 'infected' : outcome;
    };
  };
}

test('scans every regular file, including later and whiteouted layers', async () => {
  const image = fixture([[{ name: 'removed', bytes: eicar }],
    [{ name: '.wh.removed' }, { name: 'later', bytes: eicar }]]);
  const seen = [];
  const result = await scanHostedImage(image, scanner, recordingScanner(seen));
  assert.equal(result.verdict, 'infected');
  assert.equal(result.fileCount, 3);
  assert.equal(result.imageDigest, image.imageDigest);
  assert.equal(seen.filter(part => part.bytes.includes(eicar)).length, 2);
  assert.ok(seen.every(part => part.binding.targetImageDigest === image.imageDigest));
});

test('clean complete coverage is bound to the exact image and scanner', async () => {
  const image = fixture([[{ name: 'one', bytes: Buffer.from('one') }],
    [{ name: 'two', bytes: Buffer.from('two') }]], true);
  const seen = [];
  const result = await scanHostedImage(image, scanner, recordingScanner(seen));
  assert.equal(result.verdict, 'clean');
  assert.equal(result.fileCount, 2);
  assert.deepEqual(result.layerDigests, image.layers.map(layer => layer.digest));
  assert.equal(await result.validate(image, scanner), 'clean');
  const altered = structuredClone(image);
  altered.layers[1].bytes[512] ^= 1;
  await assert.rejects(result.validate(altered, scanner));
  await assert.rejects(result.validate({ ...image, imageDigest: 'c'.repeat(64) }, scanner));
  await assert.rejects(result.validate({ ...image, platform: 'linux/arm64' }, scanner));
  await assert.rejects(result.validate(image, { ...scanner, imageDigest: `sha256:${'c'.repeat(64)}` }));
});

const badFiles = [
  ['path escape', { name: '../outside', bytes: Buffer.from('x') }],
  ['absolute path', { name: '/outside', bytes: Buffer.from('x') }],
  ['symlink', { name: 'link', type: '2', link: 'outside' }],
  ['hardlink', { name: 'link', type: '1', link: 'outside' }],
  ['device', { name: 'device', type: '3' }],
  ['nested archive', { name: 'nested.zip', bytes: Buffer.from('PK\x03\x04encrypted') }],
  ['EICAR inside tar', { name: 'nested.tar', bytes: tar([{ name: 'eicar', bytes: eicar }]) }],
  ['unsupported archive', { name: 'nested.rar', bytes: Buffer.from('Rar!\x1a\x07') }],
  ['self-extracting RAR', { name: 'installer.exe',
    bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096),
      Buffer.from('Rar!\x1a\x07\x01\x00'), Buffer.from('payload')]) }],
  ['large file', { name: 'huge', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }],
];
for (const [label, file] of badFiles) {
  test(`${label} refuses without a clean receipt`, async () => {
    const image = fixture([[file]]);
    const result = await scanHostedImage(image, scanner, recordingScanner([]));
    assert.notEqual(result.verdict, 'clean');
    assert.equal('validate' in result, false);
  });
}

test('PAX sparse files cannot exceed the extracted-byte budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sparse-image-walk-test-'));
  try {
    const layer = sparseTar();
    assert.ok(layer.length < 100_000);
    const layers = [{ mediaType: 'application/vnd.oci.image.layer.v1.tar',
      diffId: `sha256:${hash(layer)}` }];
    await writeFile(join(directory, 'layers.json'), JSON.stringify(layers));
    await writeFile(join(directory, 'layer-0'), layer);
    await assert.rejects(execute('python3', [walker, directory]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test('scratch cleanup errors return a fixed result without a private path', async () => {
  const image = fixture([[{ name: 'safe', bytes: Buffer.from('safe') }]]);
  cleanupFailure.active = true;
  try {
    const result = await scanHostedImage(image, scanner, recordingScanner([]));
    assert.deepEqual(result, { verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });
  } finally {
    cleanupFailure.active = false;
  }
});

test('truncated layer, changed digest, scanner outage and stale definitions refuse', async () => {
  const image = fixture([[{ name: 'safe', bytes: Buffer.from('safe') }]]);
  const changed = structuredClone(image);
  changed.layers[0].bytes[512] ^= 1;
  const outage = async () => { throw new Error('/private/scanner/path'); };
  const stale = async () => () => { throw new Error('stale definitions'); };
  for (const [candidate, scan] of [[changed, recordingScanner([])], [image, outage],
    [image, stale], [{ ...image, layers: [{ ...image.layers[0],
      bytes: image.layers[0].bytes.subarray(0, 512) }] }, recordingScanner([])]]) {
    const result = await scanHostedImage(candidate, scanner, scan);
    assert.equal(result.verdict, 'unavailable');
    assert.equal('validate' in result, false);
    assert.equal(JSON.stringify(result).includes('/private'), false);
  }
});

test('skipped tar content and entry count limit refuse', async () => {
  const image = fixture([[{ name: 'safe', bytes: Buffer.from('safe') }]]);
  const trailing = Buffer.concat([image.layers[0].bytes,
    tar([{ name: 'hidden', bytes: eicar }])]);
  const skipped = replaceFirstLayer(image, trailing);
  const seen = [];
  const skippedResult = await scanHostedImage(skipped, scanner, recordingScanner(seen));
  assert.equal(skippedResult.verdict, 'unavailable');
  assert.equal(seen.length, 0);
  const many = [];
  for (let index = 0; index < 50_001; index++) {
    many.push({ name: `file-${index}` });
  }
  const crowded = fixture([many]);
  const crowdedResult = await scanHostedImage(crowded, scanner, recordingScanner([]));
  assert.equal(crowdedResult.verdict, 'unavailable');
}, 120_000);

test('cancelled scan refuses without a result or a private error', async () => {
  const image = fixture([[{ name: 'safe', bytes: Buffer.from('safe') }]]);
  const controller = new AbortController();
  async function cancelDuringScan() {
    controller.abort();
    throw new Error('/private/scanner/path');
  }
  const result = await scanHostedImage(image, scanner, cancelDuringScan, controller.signal);
  assert.deepEqual(result, { verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });
});

test('whole walk deadline refuses without a clean result', async () => {
  const image = fixture([[{ name: 'safe', bytes: Buffer.from('safe') }]]);
  const nativeTimeout = globalThis.setTimeout;
  function shortenedDeadline(callback, delay, ...args) {
    if (delay === 600_000) return nativeTimeout(callback, 1, ...args);
    return nativeTimeout(callback, delay, ...args);
  }
  const timer = vi.spyOn(globalThis, 'setTimeout');
  timer.mockImplementation(shortenedDeadline);
  try {
    const result = await scanHostedImage(image, scanner, recordingScanner([]));
    assert.deepEqual(result, { verdict: 'unavailable', reasonCode: 'image_scan_unavailable' });
  } finally {
    timer.mockRestore();
  }
});
