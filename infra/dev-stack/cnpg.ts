type Settings = {
  secrets: Record<string, string>;
  postgres?: { mode: string; operatorContract: string;
    superuserSecret: string; applicationSecret: string };
};
type Kubectl = (args: string[]) => Promise<string>;
type Secret = { type?: string; data?: Record<string, string> };
type Api = { groupVersion?: string; resources?: Array<{
  name: string; kind: string; namespaced: boolean; verbs: string[];
}> };
type Operators = { items?: Array<{ spec?: { template?: { spec?: {
  containers?: Array<{ name: string; image: string }>;
} } } }> };

function field(secret: Secret, name: string) {
  const encoded = secret.data?.[name];
  if (typeof encoded !== 'string' || !encoded) throw new Error('Missing credential field');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length === 0) {
    throw new Error('Invalid credential field');
  }
  return bytes.toString('utf8');
}

function basicAuth(secret: Secret, username: string) {
  if (secret.type !== 'kubernetes.io/basic-auth' || field(secret, 'username') !== username) {
    throw new Error('Invalid CNPG credential object');
  }
  return field(secret, 'password');
}

function database(secret: Secret, key: string, user: string, name: string, password: string) {
  const url = new URL(field(secret, key));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== 'postgres' ||
      (url.port !== '' && url.port !== '5432') || url.pathname !== `/${name}` ||
      decodeURIComponent(url.username) !== user || decodeURIComponent(url.password) !== password) {
    throw new Error('Database connection differs from bootstrap');
  }
  // Refuse query parameters that could override the checked connection fields.
  for (const key of ['user', 'password', 'host', 'port', 'dbname']) {
    if (url.searchParams.has(key)) throw new Error('Database connection override is refused');
  }
}

function clusterApi(resource: NonNullable<Api['resources']>[number]) {
  return resource.name === 'clusters' && resource.kind === 'Cluster' &&
    resource.namespaced === true && Array.isArray(resource.verbs) &&
    resource.verbs.includes('create');
}

async function checkOperator(kubectl: Kubectl) {
  const apiOutput = await kubectl(['get', '--raw', '/apis/postgresql.cnpg.io/v1']);
  const api = JSON.parse(apiOutput) as Api;
  if (api.groupVersion !== 'postgresql.cnpg.io/v1' ||
      !Array.isArray(api.resources) || !api.resources.some(clusterApi)) {
    throw new Error('CNPG Cluster API is unavailable');
  }
  const output = await kubectl(['get', 'deployments', '--all-namespaces',
    '-l', 'app.kubernetes.io/name=cloudnative-pg', '-o', 'json']);
  const operators = JSON.parse(output) as Operators;
  if (operators.items?.length !== 1) throw new Error('CNPG operator is unavailable or ambiguous');
  const containers = operators.items[0]?.spec?.template?.spec?.containers ?? [];
  let managerCount = 0;
  for (const container of containers) {
    if (container.name !== 'manager') continue;
    managerCount++;
    const supported = /^ghcr\.io\/cloudnative-pg\/cloudnative-pg:1\.30\.\d+(@sha256:[a-f0-9]{64})?$/u;
    if (!supported.test(container.image)) throw new Error('Unsupported CNPG operator version');
  }
  if (managerCount !== 1) throw new Error('CNPG operator manager is unavailable');
}

async function readSecret(kubectl: Kubectl, namespace: string, name: string) {
  const output = await kubectl(['-n', namespace, 'get', 'secret', name, '-o', 'json']);
  return JSON.parse(output) as Secret;
}

async function checkCredentials(values: Settings, namespace: string, kubectl: Kubectl) {
  const postgres = values.postgres!;
  const superuser = await readSecret(kubectl, namespace, postgres.superuserSecret);
  const application = await readSecret(kubectl, namespace, postgres.applicationSecret);
  const adminPassword = basicAuth(superuser, 'postgres');
  const projectionPassword = basicAuth(application, 'projection');
  const bootstrap = await readSecret(kubectl, namespace, values.secrets['bootstrap']!);
  const runtime = await readSecret(kubectl, namespace, values.secrets['runtime']!);
  const openfga = await readSecret(kubectl, namespace, values.secrets['openfga']!);
  database(bootstrap, 'POSTGRES_ADMIN_URL', 'postgres', 'postgres', adminPassword);
  if (field(bootstrap, 'PROJECTION_PASSWORD') !== projectionPassword) {
    throw new Error('CNPG projection password differs from bootstrap');
  }
  database(runtime, 'PROJECTION_DATABASE_URL', 'projection', 'projections', projectionPassword);
  database(runtime, 'DATABASE_URL', 'server', 'projections', field(bootstrap, 'SERVER_PASSWORD'));
  database(runtime, 'HANDLER_DATABASE_URL', 'dispatcher', 'handlers',
    field(bootstrap, 'DISPATCHER_PASSWORD'));
  database(openfga, 'OPENFGA_DATASTORE_URI', 'openfga', 'openfga', field(bootstrap, 'OPENFGA_PASSWORD'));
}

export async function checkCnpgInstallation(values: Settings, namespace: string, kubectl: Kubectl) {
  if (values.postgres?.mode !== 'cnpg') return;
  try {
    await checkOperator(kubectl);
    await checkCredentials(values, namespace, kubectl);
  } catch {
    // Discard dependency output and parser errors; either can include private values.
    throw new Error('CNPG installation inputs are incomplete or incompatible');
  }
}
