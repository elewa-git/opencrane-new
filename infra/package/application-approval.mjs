import { fetchCiApproval } from '../clamav/ci-approval.mjs';

function validateApplication(approval) {
  const digest = /^sha256:[a-f0-9]{64}$/u;
  if (!digest.test(approval.imageDigest) || !digest.test(approval.imageId) ||
      !/^[a-f0-9]{64}$/u.test(approval.scanSha256)) {
    throw new Error('Application approval lacks image and scan bindings');
  }
  const image = `k3d-ocn-registry:5000/opencrane/package@${approval.imageDigest}`;
  return { ...approval, image };
}

export async function fetchApplicationApproval(destination, includeImage = false) {
  const approvalOptions = { name: 'application', destination, includeImage,
    validate: validateApplication };
  return fetchCiApproval(approvalOptions);
}
