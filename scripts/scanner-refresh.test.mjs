import { afterEach, expect, test, vi } from 'vitest';
import { fetchLatestScannerApproval } from '../infra/clamav/approval.mjs';
import { publishPackageImage } from '../infra/package/publish-package-image.mjs';
import { refreshScanner } from '../infra/package/scanner-refresh.mjs';

vi.mock('../infra/clamav/approval.mjs', mockApproval);
vi.mock('../infra/package/publish-package-image.mjs', mockPublisher);

function mockApproval() {
  return { fetchLatestScannerApproval: vi.fn() };
}

function mockPublisher() {
  return { publishPackageImage: vi.fn() };
}

function clearTestState() {
  vi.resetAllMocks();
}
afterEach(clearTestState);

const prefix = 'k3d-ocn-registry:5000/opencrane/scanner@sha256:';
const newRelease = { image: `${prefix}${'a'.repeat(64)}`, approvedSha: 'b'.repeat(64), runId: 42 };

async function wrongImageRefusesBeforeChangingScanner() {
  vi.mocked(fetchLatestScannerApproval).mockResolvedValue(newRelease);
  const kubectl = vi.fn();
  const wrongImage = `${prefix}${'c'.repeat(64)}`;
  await expect(refreshScanner(kubectl, wrongImage)).rejects.toThrow(/image.*does not match/iu);
  expect(publishPackageImage).not.toHaveBeenCalled();
  expect(kubectl).not.toHaveBeenCalled();
}
test('refuses a supplied image that differs from CI before publishing or editing the install',
  wrongImageRefusesBeforeChangingScanner);
