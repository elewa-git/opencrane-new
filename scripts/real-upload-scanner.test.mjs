import { expect, test } from 'vitest';
import { startRealUploadFixture } from './support/real-upload-scanner.mjs';

const inputs = {
  manifestPath: process.env.P5_SCANNER_MANIFEST,
  approvedSha: process.env.P5_SCANNER_APPROVED_SHA,
  image: process.env.P5_SCANNER_IMAGE,
  releasePath: process.env.P5_SCANNER_RELEASE,
};
const replacement = {
  manifestPath: process.env.P5_SCANNER_NEXT_MANIFEST,
  approvedSha: process.env.P5_SCANNER_NEXT_APPROVED_SHA,
  image: process.env.P5_SCANNER_NEXT_IMAGE,
  releasePath: process.env.P5_SCANNER_NEXT_RELEASE,
};
const hasReviewedInputs = Object.values(inputs).every(Boolean);
const hasReplacement = Object.values(replacement).every(Boolean);
const realTest = hasReviewedInputs ? test : test.skip;
const recoveryTest = hasReviewedInputs && hasReplacement ? test : test.skip;

async function scannerRefused(action) {
  await expect(action).rejects.toMatchObject({ kind: 'scanner', statusCode: 503,
    message: 'Dependency unavailable' });
  await expect(action).rejects.not.toHaveProperty('cause');
}

function scheduleDelay(resolve) {
  setTimeout(resolve, 1100);
}

async function waitForClockToAdvance() {
  await new Promise(scheduleDelay);
}

async function testCleanUploadAfterScannerStartup() {
  const fixture = await startRealUploadFixture(inputs);
  try {
    await waitForClockToAdvance();
    const uploaded = await fixture.upload('silo-one', 'after-startup', Buffer.from('Meeting at ten.'));
    expect(uploaded.status).toBe('appended');
    expect(fixture.savedFiles('silo-one')).toHaveLength(1);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(1);
  } finally {
    await fixture.stop();
  }
}

async function testCleanAndInfectedUploads() {
  const fixture = await startRealUploadFixture(inputs);
  try {
    const clean = await fixture.upload('silo-one', 'clean', Buffer.from('Meeting at ten.'));
    expect(clean.status).toBe('appended');
    expect(fixture.savedFiles('silo-one')).toHaveLength(1);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(1);
    const cleanProof = fixture.lastCleanProof();
    expect(cleanProof.manifestDigest).toBe(`sha256:${inputs.approvedSha}`);
    expect(cleanProof.databases).toHaveLength(3);
    expect(cleanProof.silo).toBe('silo-one');
    expect(cleanProof.purpose).toBe('upload');
    expect(cleanProof.requestId).toBe(fixture.transportIds.at(-1));
    const changedFields = ['silo', 'request', 'bytes', 'file', 'purpose',
      'generation', 'expiry'];
    for (const field of changedFields) {
      const silo = field === 'silo' ? 'silo-two' : 'silo-one';
      const content = field === 'bytes' ? Buffer.from('Changed meeting')
        : Buffer.from('Meeting at ten.');
      await scannerRefused(fixture.replayProof(cleanProof, silo, field, content, field));
    }
    expect(fixture.savedFiles('silo-one')).toHaveLength(1);
    expect(fixture.savedFiles('silo-two')).toHaveLength(0);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(1);
    const second = await fixture.upload('silo-two', 'clean', Buffer.from('Other notes.'));
    expect(second.status).toBe('appended');
    expect(fixture.savedFiles('silo-two')).toHaveLength(1);

    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infected = await fixture.upload('silo-two', 'infected', eicar);
    expect(infected.status).toBe('infected');
    expect(fixture.savedFiles('silo-two')).toHaveLength(1);
    expect(await fixture.savedEvents('silo-two', 'file.uploaded')).toHaveLength(1);
    expect(await fixture.savedEvents('silo-two', 'file.rejected')).toHaveLength(1);

    const transportCount = fixture.transportIds.length;
    const duplicate = await fixture.upload('silo-one', 'clean', Buffer.from('Meeting at ten.'));
    expect(duplicate.status).toBe('appended');
    expect(fixture.transportIds).toHaveLength(transportCount);
    expect(fixture.savedFiles('silo-one')).toHaveLength(1);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(1);

    fixture.loseNextAcknowledgement();
    const uncertainBytes = Buffer.from('A second clean note.');
    await expect(fixture.upload('silo-one', 'uncertain', uncertainBytes)).rejects
      .toMatchObject({ kind: 'event_store', statusCode: 503 });
    const reconciled = await fixture.upload('silo-one', 'uncertain', uncertainBytes);
    expect(reconciled.status).toBe('appended');
    expect(fixture.savedFiles('silo-one')).toHaveLength(2);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(2);
    expect(new Set(fixture.transportIds).size).toBe(fixture.transportIds.length);
  } finally {
    await fixture.stop();
  }
}

const longTestOptions = { timeout: 900_000 };
realTest('accepts a caller pass after scanner startup time advances', longTestOptions,
  testCleanUploadAfterScannerStartup);
realTest('admits clean bytes once and refuses real EICAR bytes', longTestOptions,
  testCleanAndInfectedUploads);

async function testScannerFaultsAndRecovery() {
  expect(replacement.approvedSha).not.toBe(inputs.approvedSha);
  const fixture = await startRealUploadFixture(inputs);
  try {
    const original = await fixture.upload('silo-one', 'original', Buffer.from('Original'));
    expect(original.status).toBe('appended');
    const oldProof = fixture.lastCleanProof();
    const settings = fixture.settings.get('silo-one');
    const caFile = settings.caFile;
    const issuer = settings.issuer;

    settings.caFile = settings.privateKeyPath;
    await scannerRefused(fixture.upload('silo-one', 'wrong-tls', Buffer.from('TLS')));
    settings.caFile = caFile;

    settings.issuer = 'https://wrong-issuer.invalid';
    await scannerRefused(fixture.upload('silo-one', 'bad-token', Buffer.from('Token')));
    settings.issuer = issuer;

    fixture.expireDatabase();
    const filesBeforeExpiry = fixture.savedFiles('silo-one').length;
    const uploadedEventsBeforeExpiry = await fixture.savedEvents('silo-one', 'file.uploaded');
    await scannerRefused(fixture.upload('silo-one', 'old-db', Buffer.from('Database')));
    expect(fixture.savedFiles('silo-one')).toHaveLength(filesBeforeExpiry);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded'))
      .toHaveLength(uploadedEventsBeforeExpiry.length);
    await fixture.stopScanner();
    await scannerRefused(fixture.upload('silo-one', 'outage', Buffer.from('Outage')));
    expect(fixture.savedFiles('silo-one')).toHaveLength(1);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(1);

    await fixture.restart(replacement);
    await scannerRefused(fixture.replayProof(
      oldProof, 'silo-one', 'old-proof', Buffer.from('Original'),
    ));
    const recovered = await fixture.upload('silo-one', 'recovered', Buffer.from('Recovered'));
    expect(recovered.status).toBe('appended');
    expect(fixture.lastCleanProof().manifestDigest)
      .toBe(`sha256:${replacement.approvedSha}`);
    expect(fixture.lastCleanProof().requestId).not.toBe(oldProof.requestId);
    expect(fixture.savedFiles('silo-one')).toHaveLength(2);
    expect(await fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(2);
  } finally {
    await fixture.stop();
  }
}

recoveryTest('refuses scanner faults and recovers only with another reviewed database',
  longTestOptions, testScannerFaultsAndRecovery);
