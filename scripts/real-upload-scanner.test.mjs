import { expect, test } from 'vitest';
import { startRealUploadFixture } from './support/real-upload-scanner.mjs';

const inputs = {
  manifestPath: process.env.P5_SCANNER_MANIFEST,
  approvedSha: process.env.P5_SCANNER_APPROVED_SHA,
  image: process.env.P5_SCANNER_IMAGE,
  releasePath: process.env.P5_SCANNER_RELEASE,
};
const hasReviewedInputs = Object.values(inputs).every(Boolean);
const realTest = hasReviewedInputs ? test : test.skip;

realTest('admits clean bytes once and refuses real EICAR bytes', async () => {
  const fixture = await startRealUploadFixture(inputs);
  try {
    const clean = await fixture.upload('silo-one', 'clean', Buffer.from('Meeting at ten.'));
    expect(clean.status).toBe('appended');
    expect(fixture.savedFiles('silo-one')).toHaveLength(1);
    expect(fixture.savedEvents('silo-one', 'file.uploaded')).toHaveLength(1);

    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infected = await fixture.upload('silo-two', 'infected', eicar);
    expect(infected.status).toBe('infected');
    expect(fixture.savedFiles('silo-two')).toHaveLength(0);
    expect(fixture.savedEvents('silo-two', 'file.uploaded')).toHaveLength(0);
    expect(fixture.savedEvents('silo-two', 'file.rejected')).toHaveLength(1);
  } finally {
    await fixture.stop();
  }
}, 300_000);
