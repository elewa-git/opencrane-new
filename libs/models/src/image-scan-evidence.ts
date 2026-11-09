import { hasAuthenticatedImageEvidence as issuedByImageWalk }
  from '../../../infra/clamav/image-walk.mjs';

export type AuthenticatedImageEvidence = {
  silo: string;
  serverId: string;
  attemptId: number;
  imageDigest: string;
  platform: string;
  malware: object;
};

export function hasAuthenticatedImageEvidence(value: unknown):
  value is AuthenticatedImageEvidence {
  return issuedByImageWalk(value);
}
