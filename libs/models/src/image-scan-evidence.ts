const issuedScans = new WeakSet<object>();

type AuthenticatedImageEvidence = {
  silo: string;
  serverId: string;
  attemptId: number;
  imageDigest: string;
  platform: string;
  malware: object;
};

export function retainAuthenticatedImageEvidence<T extends AuthenticatedImageEvidence>(scan: T): T {
  // Keep this issuer private to the image walk after its authenticated, complete scan.
  Object.freeze(scan.malware);
  Object.freeze(scan);
  issuedScans.add(scan);
  return scan;
}

export function hasAuthenticatedImageEvidence(value: unknown):
  value is AuthenticatedImageEvidence {
  return typeof value === 'object' && value !== null && issuedScans.has(value);
}
