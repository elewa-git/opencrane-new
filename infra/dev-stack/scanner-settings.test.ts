import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { scannerSettings } from './scanner-settings.ts';

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
