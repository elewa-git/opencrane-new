import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { scanHostedImage } from '../infra/clamav/image-walk.mjs';

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
