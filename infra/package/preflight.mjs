import { readFileSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function requireImage(name, value, reviewed) {
  const digest = /@sha256:[a-f0-9]{64}$/u;
  if (typeof value !== 'string' || !digest.test(value)) {
    throw new Error(`Missing immutable image pin: ${name}`);
  }
  if (value !== reviewed) {
    throw new Error(`Image is absent from the reviewed list: ${name}`);
  }
}

function requireSecret(name, value) {
  if (typeof value !== 'string' || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(value)) {
    throw new Error(`Missing Kubernetes secret name: ${name}`);
  }
}

function check(values, review) {
  const allowedKeys = ['chartVersion', 'images', 'secrets', 'exposure'];
  for (const key of Object.keys(values)) {
    if (!allowedKeys.includes(key)) throw new Error('Unsupported package setting');
  }
  if (!values.images || !review.images) throw new Error('Image pins are missing');
  for (const [name, image] of Object.entries(review.images)) {
    requireImage(name, values.images[name], image);
  }
  for (const name of Object.keys(values.images)) {
    if (!(name in review.images)) throw new Error('Unreviewed image role');
  }
  if (!values.secrets) throw new Error('Secret references are missing');
  const requiredSecrets = review.requiredSecrets ?? ['runtime'];
  for (const name of requiredSecrets) {
    requireSecret(name, values.secrets[name]);
  }
  for (const name of Object.keys(values.secrets)) {
    if (!requiredSecrets.includes(name)) throw new Error('Unsupported secret setting');
  }
  const exposure = values.exposure;
  if (!exposure || exposure.ingress !== false || exposure.loadBalancer !== false ||
      exposure.funnel !== false) {
    throw new Error('Public ingress, LoadBalancer and Funnel are refused');
  }
  for (const name of Object.keys(exposure)) {
    if (!['ingress', 'loadBalancer', 'funnel'].includes(name)) {
      throw new Error('Unsupported exposure setting');
    }
  }
  if (review.chartVersion && values.chartVersion !== review.chartVersion) {
    throw new Error('Chart version differs from the reviewed version');
  }
}

try {
  const values = readJson(process.argv[2]);
  const review = readJson(process.argv[3]);
  check(values, review);
} catch (error) {
  if (error instanceof SyntaxError) console.error('Invalid package JSON');
  else console.error(error.message);
  process.exitCode = 1;
}
