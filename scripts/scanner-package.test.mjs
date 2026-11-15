import { execFileSync } from 'node:child_process';
import { test } from 'vitest';

function checkScannerLayers() {
  execFileSync('python3', ['infra/clamav/check-package.test.py'], { encoding: 'utf8' });
}
function checkRegistryPublication() {
  execFileSync('python3', ['infra/package/publish-image.test.py'], { encoding: 'utf8' });
}
test('scanner archives retain their layer and forbidden-library checks', checkScannerLayers);
test('registry publication refuses invalid bytes and endpoints', checkRegistryPublication);
