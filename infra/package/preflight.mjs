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

function checkPostgres(values, review) {
  const postgres = values.postgres;
  if (postgres === undefined) {
    return;
  }
  if (!postgres || typeof postgres !== 'object' || Array.isArray(postgres)) {
    throw new Error('Unsupported PostgreSQL setting');
  }
  const allowedKeys = ['mode', 'operatorContract', 'superuserSecret', 'applicationSecret'];
  for (const key of Object.keys(postgres)) {
    if (!allowedKeys.includes(key)) {
      throw new Error('Unsupported PostgreSQL setting');
    }
  }
  if (!['standalone', 'cnpg'].includes(postgres.mode)) {
    throw new Error('Unsupported PostgreSQL mode');
  }
  if (postgres.mode === 'standalone') {
    return;
  }
  if (postgres.operatorContract !== '1.30') {
    throw new Error('Unsupported CNPG operator contract');
  }
  for (const name of ['superuserSecret', 'applicationSecret']) {
    requireSecret(name, postgres[name]);
    if (postgres[name] === values.secrets.postgres) {
      throw new Error('Separate CNPG credential references are required');
    }
  }
  if (postgres.superuserSecret === postgres.applicationSecret) {
    throw new Error('Separate CNPG credential references are required');
  }
  requireImage('postgres', values.images.postgres, review.images.postgres);
  // Bind compatibility to the same digest that passed the existing image review.
  if (review.cnpg?.operatorContract !== postgres.operatorContract ||
      review.cnpg?.image !== values.images.postgres) {
    throw new Error('CNPG image compatibility is not reviewed');
  }
}

function checkNatsCluster(values, review) {
  const cluster = values.natsCluster;
  if (cluster === undefined) return;
  if (!cluster || typeof cluster !== 'object' || Array.isArray(cluster) ||
      cluster.enabled !== true || cluster.renderOnly !== false) {
    throw new Error('Unsupported NATS cluster setting');
  }
  const allowed = ['enabled', 'renderOnly', 'routeCASecret', 'peerCertificateSecrets'];
  for (const key of Object.keys(cluster)) {
    if (!allowed.includes(key)) throw new Error('Unsupported NATS cluster setting');
  }
  if (!Array.isArray(cluster.peerCertificateSecrets) || cluster.peerCertificateSecrets.length !== 3) {
    throw new Error('NATS cluster needs three peer references');
  }
  const references = [cluster.routeCASecret, ...cluster.peerCertificateSecrets];
  for (const reference of references) {
    requireSecret('NATS route', reference);
    if (reference.length > 253 || Object.values(values.secrets).includes(reference)) {
      throw new Error('NATS route references must be separate from client settings');
    }
  }
  if (new Set(references).size !== 4) throw new Error('NATS route references must be distinct');
  requireImage('server', values.images.server, review.images.server);
  requireImage('web', values.images.web, review.images.web);
  if (review.natsCluster?.replicas !== 3 ||
      review.natsCluster.server !== values.images.server ||
      review.natsCluster.web !== values.images.web) {
    throw new Error('NATS cluster image compatibility is not reviewed');
  }
}

function check(values, review) {
  const allowedKeys = ['chartVersion', 'images', 'secrets', 'exposure', 'postgres', 'natsCluster'];
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
  checkPostgres(values, review);
  checkNatsCluster(values, review);
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
