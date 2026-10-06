import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openfga } from '../libs/authz/test/services.ts';

const exec = promisify(execFile);

async function danglingVolumeCount() {
  const result = await exec('docker', ['volume', 'ls', '-q', '--filter', 'dangling=true']);
  const volumes = result.stdout.trim();
  if (volumes === '') {
    return 0;
  }
  return volumes.split('\n').length;
}

async function checkFixtureCleanup() {
  const before = await danglingVolumeCount();
  const fixture = await openfga();
  await fixture.close();
  const after = await danglingVolumeCount();

  if (after > before) {
    throw new Error(`Fixture left ${after - before} dangling Docker volume(s)`);
  }
}

await checkFixtureCleanup();
