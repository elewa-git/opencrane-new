import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createPrivateKey, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { nkeys } from '@nats-io/transport-node';

const execute = promisify(execFile);
type Secret = { data?: Record<string, string> };
type Secrets = Record<string, Secret>;

function bytes(secret: Secret, name: string) {
  const value = secret.data?.[name];
  assert(typeof value === 'string' && value.length > 0);
  const decoded = Buffer.from(value, 'base64');
  assert.equal(decoded.toString('base64'), value);
  return decoded;
}

function validCertificate(contents: Buffer) {
  const certificate = new X509Certificate(contents);
  assert(Date.parse(certificate.validFrom) <= Date.now());
  assert(Date.parse(certificate.validTo) > Date.now());
  return certificate;
}

async function checkIdentity(secret: Secret, role: string, issuer: X509Certificate,
  temporary: string) {
  const contents = bytes(secret, `${role}.crt`);
  const certificate = validCertificate(contents);
  const key = createPrivateKey(bytes(secret, `${role}.key`));
  assert(certificate.checkPrivateKey(key));
  assert(!certificate.ca && certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey));
  let subject = `CN=${role}`;
  let names: string | undefined;
  let usage = '1.3.6.1.5.5.7.3.2';
  let purpose = 'sslclient';
  if (role === 'server') {
    subject = 'CN=nats';
    names = 'DNS:nats, DNS:localhost, IP Address:127.0.0.1';
    usage = '1.3.6.1.5.5.7.3.1';
    purpose = 'sslserver';
  }
  assert.equal(certificate.subject, subject);
  assert.equal(certificate.subjectAltName, names);
  assert.deepEqual(certificate.keyUsage, [usage]);
  // Check the mounted public certificate with OpenSSL too, including CA and key usage constraints.
  await writeFile(join(temporary, 'identity.crt'), contents, { mode: 0o600 });
  await execute('openssl', ['verify', '-CAfile', 'ca.crt', '-purpose', purpose, 'identity.crt'],
    { cwd: temporary, timeout: 30_000, maxBuffer: 2_000_000 });
}

async function checkCertificates(server: Secret, files: Secret) {
  const trust = bytes(server, 'ca.crt');
  assert.deepEqual(bytes(files, 'ca.crt'), trust);
  const issuer = validCertificate(trust);
  assert(issuer.ca && issuer.checkIssued(issuer) && issuer.verify(issuer.publicKey));
  const temporary = await mkdtemp(join(tmpdir(), 'package-nats-check-'));
  try {
    // Keep all host paths in cwd. Pass only fixed filenames to child commands.
    await writeFile(join(temporary, 'ca.crt'), trust, { mode: 0o600 });
    await checkIdentity(server, 'server', issuer, temporary);
    for (const role of ['command', 'projection', 'dispatcher']) {
      await checkIdentity(files, role, issuer, temporary);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function checkRoleKeys(server: Secret, files: Secret) {
  const publicKeys = new Set<string>();
  for (const role of ['command', 'projection', 'dispatcher', 'computer', 'gateway']) {
    const publicKey = bytes(server, `NATS_${role.toUpperCase()}_NKEY`).toString('utf8');
    assert(publicKey.startsWith('U'));
    const user = nkeys.fromPublic(publicKey);
    assert.equal(user.getPublicKey(), publicKey);
    user.clear();
    assert(!publicKeys.has(publicKey));
    publicKeys.add(publicKey);
    if (role === 'computer' || role === 'gateway') continue;
    const identity = nkeys.fromSeed(bytes(files, `${role}.seed`));
    try {
      assert.equal(identity.getPublicKey(), publicKey);
    } finally {
      identity.clear();
    }
  }
}

function checkSettings(secret: Secret, expected: Record<string, string>, optional = false) {
  for (const [name, value] of Object.entries(expected)) {
    if (optional && secret.data?.[name] === undefined) continue;
    assert.equal(bytes(secret, name).toString('utf8'), value);
  }
}

function checkConnections(server: Secret, runtime: Secret, bootstrap: Secret) {
  checkSettings(server, {
    NATS_LISTEN: '0.0.0.0:4222', NATS_STORE_DIR: '/data', NATS_CA_FILE: '/tls/ca.crt',
    NATS_CERT_FILE: '/tls/server.crt', NATS_KEY_FILE: '/tls/server.key',
  });
  const command = {
    NATS_URL: 'tls://nats:4222', NATS_CA_FILE: '/run/opencrane/files/ca.crt',
    NATS_CERT_FILE: '/run/opencrane/files/command.crt',
    NATS_KEY_FILE: '/run/opencrane/files/command.key',
    NATS_NKEY_SEED_FILE: '/run/opencrane/files/command.seed', NATS_INBOX_PREFIX: '_INBOX.command',
  };
  const expected: Record<string, string> = { ...command };
  for (const [name, value] of Object.entries(command)) expected[`COMMAND_${name}`] = value;
  checkSettings(runtime, expected);
  // Bootstrap loads its Secret after runtime settings, so any override must agree.
  checkSettings(bootstrap, expected, true);
}

export async function checkNatsInputs(secrets: Secrets) {
  try {
    const server = secrets['nats']!;
    const files = secrets['runtimeFiles']!;
    const configuration = await readFile(new URL('../nats/nats.conf', import.meta.url));
    // Accept only the shipped policy; extra includes or duplicate settings could bypass it.
    assert.deepEqual(bytes(server, 'nats.conf'), configuration);
    checkConnections(server, secrets['runtime']!, secrets['bootstrap']!);
    checkRoleKeys(server, files);
    await checkCertificates(server, files);
  } catch {
    // Withhold assertions and OpenSSL errors because they can contain private inputs or paths.
    throw new Error('Package NATS inputs are incomplete or incompatible');
  }
}
