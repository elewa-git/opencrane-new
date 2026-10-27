import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { rootCertificates } from 'node:tls';
import * as files from 'node:fs/promises';
import { registerHooks } from 'node:module';

assert.equal(process.getuid(), 1000);
assert.equal(process.cwd(), '/app');
assert.equal(userInfo().username, 'node');
assert.equal(homedir(), userInfo().homedir);
assert.ok(rootCertificates.length > 0);
for (const name of ['event-store', 'authz', 'handlers']) {
  assert.equal(realpathSync(`/app/node_modules/@opencrane/${name}`), `/app/libs/${name}`);
}

// Load the real service packages before replacing calls to disposable services.
// Keep their own imports and workspace links subject to Node's normal resolution.
for (const name of ['pg', '@opencrane/event-store', '@opencrane/authz',
  '@opencrane/handlers', '@opencrane/events', '@nats-io/jetstream']) {
  await import(name);
}

const owner = process.argv[1]?.endsWith('/owner-bootstrap.ts');
let ownerWrites = 0;
const defaults = {
  NATS_REPLICAS: '1', COMMAND_NATS_REPLICAS: '1', DEV_STACK_ID: 'owner',
  POSTGRES_ADMIN_URL: 'postgres://fixture', PROJECTION_DATABASE_URL: 'postgres://fixture',
  SILO_ID: 'fixture', OPENFGA_STORE_ID: 'pending', OPENFGA_MODEL_ID: 'pending',
  KUBE_NAMESPACE: 'fixture', RUNTIME_SECRET: 'fixture', DEV_OWNER_EMAIL: 'owner@example.invalid',
  PACKAGE_OWNER_SUBJECT: 'fixture-owner', NATS_URL: 'tls://fixture:4222',
  NATS_CA_FILE: '/fixture/ca', NATS_CERT_FILE: '/fixture/cert', NATS_KEY_FILE: '/fixture/key',
  NATS_NKEY_SEED_FILE: '/fixture/seed', NATS_INBOX_PREFIX: '_INBOX.fixture',
};
for (const name of ['PROJECTION_PASSWORD', 'SERVER_PASSWORD', 'DISPATCHER_PASSWORD',
  'OPENFGA_PASSWORD']) {
  defaults[name] = 'a'.repeat(64);
}
Object.assign(process.env, defaults);

class Pool {
  async query() {
    return { rows: [{ members: 'members', identities: 'identities',
      member_id: 'fixture-owner', status: 'joined', role: 'owner' }] };
  }
  async end() {}
}

const patched = [];
function request(options, callback) {
  assert.equal(options.hostname, 'kubernetes.default.svc');
  const call = new EventEmitter();
  function end(body) {
    patched.push(JSON.parse(body));
    const response = new EventEmitter();
    response.statusCode = 200;
    response.resume = function resume() {};
    callback(response);
    response.emit('end');
  }
  call.end = end;
  return call;
}
async function readFile(path, ...args) {
  if (path.startsWith('/var/run/secrets/kubernetes.io/serviceaccount/')) {
    if (args[0] === 'utf8') {
      return 'fixture';
    }
    return Buffer.from('fixture');
  }
  if (path === '/app/infra/dev-stack/zitadel.json') {
    return JSON.stringify({ extraIdentities: [
      { issuer: 'https://identity.example.invalid', subject: 'fixture-owner' },
    ] });
  }
  return files.readFile(path, ...args);
}
async function healthy() {
  return { ok: true };
}
globalThis.fetch = healthy;

const services = {
  pg: { Pool },
  'node:https': { request },
  'node:fs/promises': { ...files, readFile },
  '@opencrane/authz': {
    async createStore() {
      return { silo: 'fixture', apiUrl: 'http://openfga:8080',
        storeId: 'fixture-store', authorizationModelId: 'fixture-model' };
    },
    memberAuthorisation() {
      async function check() {
        return { allowed: true };
      }
      return { check };
    },
  },
  '@opencrane/event-store': {
    async connectNats() {
      async function request() {
        function json() {
          return { server: { name: 'fixture' }, data: {} };
        }
        return { json };
      }
      async function close() {}
      return { request, close };
    },
    async createEventStore() {
      async function ensureStream() {}
      return { ensureStream };
    },
    isEventStoreUnavailable() {
      return false;
    },
    async connectEventStore() {
      let sequence = 0;
      async function head() {
        return 0;
      }
      async function* readStream() {}
      async function append() {
        sequence += 1;
        ownerWrites += 1;
        return { status: 'appended', sequence };
      }
      async function close() {}
      return { store: { head, readStream, append }, close };
    },
  },
  '@opencrane/handlers': {
    async provisionDispatcher() {},
  },
};
globalThis.bootstrapServices = services;

function resolve(specifier, context, nextResolve) {
  // Resolve the real module first; a replacement must never hide a missing import.
  const resolved = nextResolve(specifier, context);
  if (Object.hasOwn(services, specifier)) {
    return { url: `fixture:${specifier}`, shortCircuit: true };
  }
  return resolved;
}
function load(url, context, nextLoad) {
  if (!url.startsWith('fixture:')) {
    return nextLoad(url, context);
  }
  const name = url.slice('fixture:'.length);
  const exports = [];
  for (const key of Object.keys(services[name])) {
    if (key === 'default') {
      continue;
    }
    exports.push(`export const ${key} = globalThis.bootstrapServices[${JSON.stringify(name)}]`
      + `[${JSON.stringify(key)}];`);
  }
  return { format: 'module', source: exports.join('\n'), shortCircuit: true };
}
registerHooks({ resolve, load });

async function verifyCompletion() {
  if (process.exitCode) {
    return;
  }
  if (owner) {
    assert.equal(ownerWrites, 2, 'Synthetic owner setup did not finish');
    await files.writeFile('/tmp/owner-fixture-complete', 'complete', { mode: 0o600 });
    return;
  }
  const completion = await files.readFile('/tmp/owner-fixture-complete', 'utf8');
  assert.equal(completion, 'complete', 'Owner subprocess did not finish');
  const ready = patched.at(-2)?.data?.OWNER_BOOTSTRAP_READY;
  assert.equal(ready, Buffer.from('ready').toString('base64'), 'Bootstrap did not finish');
  console.log('PASS synthetic bootstrap completed through owner setup');
}
function finish() {
  function failed() {
    console.error('FAIL synthetic bootstrap completion');
    process.exitCode = 1;
  }
  void verifyCompletion().catch(failed);
}
process.once('beforeExit', finish);
