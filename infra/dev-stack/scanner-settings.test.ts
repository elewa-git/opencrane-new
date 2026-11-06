import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { tokenIssuer, tokenVerifier } from '@opencrane/auth';
import { prepareScannerFiles, scannerReady,
  scannerSettings } from './scanner-settings.ts';

async function rejectsScanner() {
  const directory = await mkdtemp(`${tmpdir()}/scanner-settings-`);
  try {
    const caFile = `${directory}/ca.crt`;
    await writeFile(caFile, 'test certificate');
    const missing = { DEV_SCANNER_CA_FILE: caFile };
    await assert.rejects(scannerSettings(missing),
      /Authenticated scanner settings are required before startup/u);

    const insecure = { DEV_SCANNER_URL: 'http://127.0.0.1:25199/scan/upload',
      DEV_SCANNER_CA_FILE: caFile };
    await assert.rejects(scannerSettings(insecure),
      /Authenticated scanner settings are required before startup/u);

    const unreadable = { DEV_SCANNER_URL: 'https://127.0.0.1:25199/scan/upload',
      DEV_SCANNER_CA_FILE: `${directory}/missing.crt` };
    await assert.rejects(scannerSettings(unreadable),
      /Authenticated scanner settings are required before startup/u);

    const valid = { DEV_SCANNER_URL: 'https://127.0.0.1:25199/scan/upload',
      DEV_SCANNER_CA_FILE: caFile };
    assert.deepEqual(await scannerSettings(valid), {
      SCANNER_URL: valid.DEV_SCANNER_URL,
      SCANNER_CA_FILE: caFile,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('scanner settings reject an absent or insecure service before startup', rejectsScanner);

async function createsPrivateScannerFiles() {
  const directory = await mkdtemp(`${tmpdir()}/scanner-private-`);
  try {
    await prepareScannerFiles(directory);
    for (const name of ['scanner-ca.key', 'scanner-ca.crt',
      'scanner-server.key', 'scanner-server.crt']) {
      const details = await stat(`${directory}/${name}`);
      assert.equal(details.mode & 0o777, 0o600, name);
    }
    await prepareScannerFiles(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('scanner TLS files stay private and survive a repeat start', createsPrivateScannerFiles);

async function refusesMissingService() {
  const directory = await mkdtemp(`${tmpdir()}/scanner-missing-`);
  try {
    const caFile = `${directory}/ca.crt`;
    await writeFile(caFile, 'test certificate', { mode: 0o600 });
    const settings = { SCANNER_URL: 'https://127.0.0.1:1/scan/upload',
      SCANNER_CA_FILE: caFile };
    const identity = { silo: 'this-stack', issuer: 'https://this-stack.test/',
      privateKeyPath: `${directory}/missing.pem` };
    assert.equal(await scannerReady(settings, identity), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('startup refuses a scanner service that is not listening', refusesMissingService);

type ScannerCase = 'clean' | 'foreign' | 'unavailable';

async function checkScannerCase(scannerCase: ScannerCase) {
  const directory = await mkdtemp(`${tmpdir()}/scanner-probe-`);
  await prepareScannerFiles(directory);
  const signingKey = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const privateKeyPath = `${directory}/signing.pem`;
  await writeFile(privateKeyPath, signingKey.privateKey);
  const issuer = 'https://this-stack.test/';
  const scannerIdentity = { service: 'server' as const, silo: 'this-stack' };
  const tokens = await tokenIssuer({ privateKeyPath, issuer, scannerIdentity });
  const verifier = tokenVerifier(tokens.jwks, issuer, undefined,
    { server: 'this-stack' });
  const foreignKey = generateKeyPairSync('ec', { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const foreignKeyPath = `${directory}/foreign.pem`;
  await writeFile(foreignKeyPath, foreignKey.privateKey);
  const foreignIssuer = 'https://another-stack.test/';
  const foreignTokens = await tokenIssuer({ privateKeyPath: foreignKeyPath,
    issuer: foreignIssuer });
  const foreignVerifier = tokenVerifier(foreignTokens.jwks, foreignIssuer, undefined,
    { server: 'another-stack' });
  const tls = { key: await readFile(`${directory}/scanner-server.key`),
    cert: await readFile(`${directory}/scanner-server.crt`) };
  const server = createServer(tls);
  let scans = 0;
  let foreignPassRefused = false;
  function health(_request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    response.writeHead(503);
    response.end();
  }
  async function scan(request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse) {
    scans += 1;
    if (scannerCase === 'unavailable') {
      response.writeHead(503);
      response.end();
      return;
    }
    const requestId = request.headers['x-scan-request-id'];
    const bearer = request.headers.authorization?.slice('Bearer '.length);
    if (!requestId || !bearer || typeof requestId !== 'string') {
      response.writeHead(503);
      response.end();
      return;
    }
    if (scannerCase === 'foreign') {
      try {
        await foreignVerifier.verifyScanner(bearer, { purpose: 'upload', requestId });
      } catch {
        foreignPassRefused = true;
      }
      response.writeHead(503);
      response.end();
      return;
    }
    await verifier.verifyScanner(bearer, { purpose: 'upload', requestId });
    response.writeContinue();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const now = new Date().toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const database = { sha256: '0'.repeat(64), version: 1, builtAt: now };
    function databaseFact(file: string) {
      return { ...database, file: `${file}.cvd` };
    }
    const databases = ['main', 'daily', 'bytecode'].map(databaseFact);
    const result = { purpose: 'upload', silo: 'this-stack', requestId,
      fileId: request.headers['x-scan-file-id'], sha256, byteCount: bytes.length,
      verdict: 'clean', imageDigest: `sha256:${'0'.repeat(64)}`,
      manifestDigest: `sha256:${'0'.repeat(64)}`,
      databases,
      databaseUpdatedAt: now, checkedAt: now, expiresAt: future };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  }
  server.on('request', health);
  server.on('checkContinue', scan);
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing scanner port');
    const settings = { SCANNER_URL: `https://127.0.0.1:${address.port}/scan/upload`,
      SCANNER_CA_FILE: `${directory}/scanner-ca.crt` };
    const identity = { silo: 'this-stack', issuer, privateKeyPath };
    const ready = await scannerReady(settings, identity);
    assert.equal(ready, scannerCase === 'clean');
    assert.equal(scans, 1);
    if (scannerCase === 'foreign') assert.equal(foreignPassRefused, true);
  } finally {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function acceptsAuthenticatedCleanScan() {
  await checkScannerCase('clean');
}

async function refusesForeignScanner() {
  await checkScannerCase('foreign');
}

async function refusesScannerWithoutScan() {
  await checkScannerCase('unavailable');
}

test('startup accepts one authenticated clean scan from this stack', acceptsAuthenticatedCleanScan);
test('startup refuses a scanner for another stack', refusesForeignScanner);
test('startup refuses a scanner that cannot scan', refusesScannerWithoutScan);
