import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { prepareScannerFiles, scannerImageUrl, scannerReady,
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
    assert.equal(scannerImageUrl(valid.DEV_SCANNER_URL),
      'https://127.0.0.1:25199/scan/image-part');
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
    assert.equal(await scannerReady(settings), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('startup refuses a scanner service that is not listening', refusesMissingService);
