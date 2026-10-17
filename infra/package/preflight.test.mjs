import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const digest = 'sha256:' + 'a'.repeat(64);
const reviewedImage = `registry.local/server@${digest}`;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'package-preflight-'));
  const values = {
    chartVersion: '0.1.0',
    images: { server: reviewedImage },
    secrets: { runtime: 'runtime-settings' },
    exposure: { ingress: false, loadBalancer: false, funnel: false },
  };
  const review = { chartVersion: '0.1.0', images: { server: reviewedImage } };
  return { directory, values, review };
}

function check(values, review, directory) {
  const valuesFile = join(directory, 'values.json');
  const reviewFile = join(directory, 'review.json');
  writeFileSync(valuesFile, JSON.stringify(values));
  writeFileSync(reviewFile, JSON.stringify(review));
  return spawnSync('node', ['infra/package/preflight.mjs', valuesFile, reviewFile], {
    encoding: 'utf8',
  });
}

function reviewedImagePasses() {
  const { directory, values, review } = fixture();
  try {
    assert.equal(check(values, review, directory).status, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
}
test('a reviewed digest and named secret pass', reviewedImagePasses);

function removePin(values) { delete values.images.server; }
function useMutableImage(values) { values.images.server = 'registry.local/server:latest'; }
function useUnreviewedImage(values) { values.images.server = `registry.local/other@${digest}`; }
function removeSecret(values) { delete values.secrets.runtime; }
function enableIngress(values) { values.exposure.ingress = true; }
function enableLoadBalancer(values) { values.exposure.loadBalancer = true; }
function enableFunnel(values) { values.exposure.funnel = true; }
function removeChartVersion(values) { delete values.chartVersion; }

const refusals = [
  ['missing pin', removePin, /Missing immutable image pin/u],
  ['mutable image', useMutableImage, /Missing immutable image pin/u],
  ['unreviewed image', useUnreviewedImage, /absent from the reviewed list/u],
  ['missing secret', removeSecret, /Missing Kubernetes secret/u],
  ['public ingress', enableIngress, /Public ingress/u],
  ['LoadBalancer', enableLoadBalancer, /Public ingress/u],
  ['Funnel', enableFunnel, /Public ingress/u],
  ['missing chart version', removeChartVersion, /Chart version differs/u],
];

for (const [name, change, expected] of refusals) {
  function verifyRefusal() {
    const { directory, values, review } = fixture();
    try {
      change(values);
      const result = check(values, review, directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }
  test(`${name} fails before installation`, verifyRefusal);
}
