import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

function enableCluster(values) {
  values.natsCluster = { enabled: true, renderOnly: true };
}

function removePin(values) { delete values.images.server; }
function useMutableImage(values) { values.images.server = 'registry.local/server:latest'; }
function useUnreviewedImage(values) { values.images.server = `registry.local/other@${digest}`; }
function removeSecret(values) { delete values.secrets.runtime; }
function enableIngress(values) { values.exposure.ingress = true; }
function enableLoadBalancer(values) { values.exposure.loadBalancer = true; }
function enableFunnel(values) { values.exposure.funnel = true; }
function removeChartVersion(values) { delete values.chartVersion; }

const refusals = [
  ['cluster without R3 runtime support', enableCluster, /Unsupported NATS cluster setting/u],
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

function cnpgFixture() {
  const setup = fixture();
  setup.values.images.postgres = `registry.local/cnpg-postgres:17.6@${digest}`;
  setup.review.images.postgres = setup.values.images.postgres;
  setup.values.postgres = {
    mode: 'cnpg', operatorContract: '1.30',
    superuserSecret: 'cnpg-superuser', applicationSecret: 'cnpg-projection',
  };
  setup.review.cnpg = { operatorContract: '1.30', image: setup.values.images.postgres };
  return setup;
}

function reviewedCnpgPasses() {
  const { directory, values, review } = cnpgFixture();
  try {
    const result = check(values, review, directory);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true });
  }
}
test('CNPG needs its own reviewed image compatibility contract', reviewedCnpgPasses);

function removeCnpgReview(values, review) {
  delete review.cnpg;
}
function changeCnpgReview(values, review) {
  review.cnpg.image = reviewedImage;
}
function changeCnpgContract(values, review) {
  review.cnpg.operatorContract = 'unknown';
}
function useRetiredCnpgContract(values, review) {
  values.postgres.operatorContract = '1.28';
  review.cnpg.operatorContract = '1.28';
}
function removeCnpgContract(values) {
  delete values.postgres.operatorContract;
}
function removeCnpgSuperuser(values) {
  delete values.postgres.superuserSecret;
}
function removeCnpgApplication(values) {
  delete values.postgres.applicationSecret;
}
function wrongCnpgCredentialShape(values) {
  values.postgres.POSTGRES_PASSWORD = 'test-only';
}
function reuseCnpgCredentials(values) {
  values.postgres.applicationSecret = values.postgres.superuserSecret;
}
function mutableCnpgImage(values) {
  values.images.postgres = 'registry.local/postgres:latest';
}

const cnpgRefusals = [
  ['missing CNPG image review', removeCnpgReview, /CNPG image compatibility is not reviewed/u],
  ['wrong CNPG image review', changeCnpgReview, /CNPG image compatibility is not reviewed/u],
  ['wrong reviewed operator', changeCnpgContract, /CNPG image compatibility is not reviewed/u],
  ['missing operator contract', removeCnpgContract, /Unsupported CNPG operator contract/u],
  ['retired operator contract', useRetiredCnpgContract, /Unsupported CNPG operator contract/u],
  ['missing superuser reference', removeCnpgSuperuser, /Missing Kubernetes secret name/u],
  ['missing application reference', removeCnpgApplication, /Missing Kubernetes secret name/u],
  ['legacy credential shape', wrongCnpgCredentialShape, /Unsupported PostgreSQL setting/u],
  ['shared credentials', reuseCnpgCredentials, /Separate CNPG credential references/u],
  ['mutable CNPG image', mutableCnpgImage, /Missing immutable image pin/u],
  ['public CNPG exposure', enableIngress, /Public ingress/u],
];
for (const [name, change, expected] of cnpgRefusals) {
  function refusesUnreviewedCnpg() {
    const { directory, values, review } = cnpgFixture();
    try {
      change(values, review);
      const result = check(values, review, directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, expected);
      assert.doesNotMatch(result.stderr, /test-only/u);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }
  test(`${name} refuses before installation`, refusesUnreviewedCnpg);
}

function clusterSettings(values, review) {
  values.natsCluster = { enabled: true, renderOnly: false, routeCASecret: 'routes',
    peerCertificateSecrets: ['route-zero', 'route-one', 'route-two'] };
  values.images.web = values.images.server;
  review.images.web = values.images.web;
  review.natsCluster = { replicas: 3, server: values.images.server, web: values.images.web,
    sourceRevision: 'a'.repeat(40) };
}
for (const revision of [undefined, '', 'main', 'a'.repeat(39)]) {
  function missingSourceRefuses() {
    const { directory, values, review } = fixture();
    try {
      clusterSettings(values, review);
      review.natsCluster.sourceRevision = revision;
      const result = check(values, review, directory);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /NATS cluster image compatibility is not reviewed/u);
    } finally {
      rmSync(directory, { recursive: true });
    }
  }
  test(`R3 review refuses invalid source revision ${String(revision)}`, missingSourceRefuses);
}
function clusterPreflightBeforePreparation() {
  const { directory, values, review } = fixture();
  try {
    clusterSettings(values, review);
    const result = check(values, review, directory);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(directory, { recursive: true });
  }
}
test('reviewed R3 settings pass before any route objects exist', clusterPreflightBeforePreparation);

function oldImageStillRefuses() {
  const { directory, values } = fixture();
  try {
    const review = JSON.parse(readFileSync('infra/package/reviewed-images.json', 'utf8'));
    values.images = review.images;
    values.chartVersion = review.chartVersion;
    for (const name of review.requiredSecrets) values.secrets[name] = name.toLowerCase();
    values.natsCluster = { enabled: true, renderOnly: false, routeCASecret: 'routes',
      peerCertificateSecrets: ['route-zero', 'route-one', 'route-two'] };
    const result = check(values, review, directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NATS cluster image compatibility is not reviewed/u);
  } finally {
    rmSync(directory, { recursive: true });
  }
}
test('the shipped image still has no R3 compatibility approval', oldImageStillRefuses);

function packagePromotionRefusals() {
  const result = spawnSync('python3', ['infra/package/licences.test.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
test('package licence and image promotion refusals pass', packagePromotionRefusals);

for (const mode of ['cnpg', 'standalone']) {
  for (const backup of [{ enabled: true, renderOnly: true }, { enabled: false }, null]) {
    function backupInstallStaysClosed() {
      const { directory, values, review } = cnpgFixture();
      try {
        values.postgres.mode = mode;
        values.postgres.backup = backup;
        const result = check(values, review, directory);
        assert.notEqual(result.status, 0);
        assert.equal(result.stderr.trim(), 'CNPG backup installation is not enabled');
        assert.equal(result.stdout, '');
      } finally {
        rmSync(directory, { recursive: true });
      }
    }
    test(`preflight refuses ${mode} backup settings ${JSON.stringify(backup)}`,
      backupInstallStaysClosed);
  }
}
