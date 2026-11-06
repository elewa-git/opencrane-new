import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { baseImage } from './base-image.mjs';

const digestPath = 'apps/computer/test/base-image-digest.txt';
const imageName = 'ghcr.io/elewa-git/opencrane-ci-computer-base';

test('the checked-in digest is empty or a complete sha256 digest', () => {
  const digest = readFileSync(digestPath, 'utf8');
  const image = baseImage(digest);
  assert.ok(image === '' || image.startsWith(`${imageName}@sha256:`));
});

test('the image name uses the complete digest', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  assert.equal(baseImage(digest), `${imageName}@${digest}`);
  assert.throws(() => baseImage('sha256:abc'));
  assert.throws(() => baseImage('sha256:' + 'A'.repeat(64)));
});

test('CI gives the digest to both base arguments and builds from source while empty', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /node scripts\/ci\/base-image\.mjs/u);
  assert.match(workflow, /--build-arg COMPUTER_BASE="\$image"/u);
  assert.match(workflow, /--build-arg COMPUTER_APT_BASE="\$image"/u);
  assert.match(workflow, /docker buildx bake -f apps\/computer\/test\/upload-bake\.hcl --load/u);
});

test('the saved base skips both snapshot stages', () => {
  const dockerfile = readFileSync('apps/computer/Dockerfile', 'utf8');
  const runtimeStart = dockerfile.indexOf('FROM ${COMPUTER_APT_BASE} AS runtime');
  assert.ok(runtimeStart > 0);
  const fallback = dockerfile.slice(0, runtimeStart);
  const runtime = dockerfile.slice(runtimeStart);
  assert.match(fallback, /COPY --from=launcher-build \/tool-user/u);
  assert.doesNotMatch(runtime, /snapshot\.debian\.org|apt-get|launcher-build/u);

  const savedBase = readFileSync('apps/computer/test/upload-base.Dockerfile', 'utf8');
  assert.match(savedBase, /COPY apps\/computer\/apt\.lock/u);
  assert.match(savedBase, /COPY --from=launcher-build \/tool-user/u);
});
