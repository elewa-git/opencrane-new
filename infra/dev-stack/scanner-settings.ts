import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { scanFile } from '../../apps/server/src/files/scanner.ts';

const refusal = 'Authenticated scanner settings are required before startup';
const exec = promisify(execFile);

async function openssl(directory: string, arguments_: string[]) {
  await exec('openssl', arguments_, { cwd: directory, timeout: 30_000 });
}

export async function prepareScannerFiles(directory: string) {
  const names = ['scanner-ca.key', 'scanner-ca.crt',
    'scanner-server.key', 'scanner-server.crt'];
  try {
    for (const name of names) await readFile(`${directory}/${name}`);
    await openssl(directory, ['x509', '-in', 'scanner-server.crt', '-checkend', '86400',
      '-noout']);
    for (const name of names) await chmod(`${directory}/${name}`, 0o600);
    return;
  } catch {
    // Replace an incomplete or expiring pair together so the server never has mixed trust.
  }
  try {
    await openssl(directory, ['req', '-x509', '-newkey', 'ec', '-pkeyopt',
      'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'scanner-ca.key',
      '-out', 'scanner-ca.crt', '-days', '30', '-subj', '/CN=dev-scanner-ca']);
    await openssl(directory, ['req', '-new', '-newkey', 'ec', '-pkeyopt',
      'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'scanner-server.key',
      '-out', 'scanner-server.csr', '-subj', '/CN=127.0.0.1']);
    const extension = 'subjectAltName=IP:127.0.0.1,DNS:scanner\n'
      + 'extendedKeyUsage=serverAuth\n';
    await writeFile(`${directory}/scanner-server.ext`, extension, { mode: 0o600 });
    await openssl(directory, ['x509', '-req', '-in', 'scanner-server.csr',
      '-CA', 'scanner-ca.crt', '-CAkey', 'scanner-ca.key', '-CAcreateserial',
      '-out', 'scanner-server.crt', '-days', '30', '-extfile', 'scanner-server.ext']);
    for (const name of names) await chmod(`${directory}/${name}`, 0o600);
  } catch {
    throw new Error('Private scanner certificates unavailable');
  } finally {
    for (const name of ['scanner-server.csr', 'scanner-server.ext', 'scanner-ca.srl']) {
      await rm(`${directory}/${name}`, { force: true });
    }
  }
}

export async function scannerSettings(environment: NodeJS.ProcessEnv,
  directory?: string, port?: string) {
  const url = environment['DEV_SCANNER_URL'];
  const caFile = environment['DEV_SCANNER_CA_FILE'];
  if (url || caFile) {
    if (!url || !caFile) throw new Error(refusal);
    return validatedSettings(url, caFile);
  }
  if (!directory || !port) throw new Error(refusal);
  await prepareScannerFiles(directory);
  return validatedSettings(`https://127.0.0.1:${port}/scan/upload`,
    `${directory}/scanner-ca.crt`);
}

async function validatedSettings(url: string, caFile: string) {
  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/scan/upload' ||
        endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error(refusal);
    }
    const certificate = await readFile(caFile);
    if (!certificate.length) throw new Error(refusal);
  } catch {
    // Keep private paths and TLS parser details out of startup output.
    throw new Error(refusal);
  }

  return { SCANNER_URL: url, SCANNER_CA_FILE: caFile };
}

interface ScannerIdentity {
  silo: string;
  issuer: string;
  privateKeyPath: string;
}

export async function scannerReady(settings: { SCANNER_URL: string; SCANNER_CA_FILE: string },
  identity: ScannerIdentity) {
  try {
    const sample = Buffer.from('OpenCrane scanner startup check');
    const binding = { silo: identity.silo, fileId: randomUUID() };
    const scanSettings = { url: settings.SCANNER_URL, caFile: settings.SCANNER_CA_FILE,
      ...identity };
    const checked = await scanFile(scanSettings, sample, binding);
    // Require the same reply checks that an upload uses before accepting this scanner.
    return checked() === 'clean';
  } catch {
    return false;
  }
}
