export function credentialPatterns(material: string | undefined): string[] {
  if (material === undefined) return [];
  const patterns = new Set<string>();
  for (const value of [material, `Bearer ${material}`]) {
    patterns.add(value);
    patterns.add(Buffer.from(value).toString('base64'));
    patterns.add(Buffer.from(value).toString('base64url'));
  }
  // Check eight-character pieces because every longer copied part contains one.
  for (let index = 0; index <= material.length - 8; index += 1) {
    patterns.add(material.slice(index, index + 8));
  }
  return [...patterns];
}

function containsCredentialPattern(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (value.includes(pattern)) return true;
  }
  return false;
}

function decodeUrlEscape(match: string): string {
  try {
    return decodeURIComponent(match);
  } catch {
    return match;
  }
}

function decodeUrlEscapes(value: string): string {
  // Decode valid runs even when another part of the reply has a bad percent escape.
  return value.replace(/(?:%[0-9a-f]{2})+/giu, decodeUrlEscape);
}

function containsEncodedCredential(value: string, patterns: string[]): boolean {
  const encodedRuns = value.match(/[A-Za-z0-9+/_-]{8,}={0,2}/gu);
  if (encodedRuns === null) return false;
  for (const encoded of encodedRuns) {
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
    if (containsCredentialPattern(decoded, patterns)) return true;
  }
  return false;
}

export function containsCredentialText(value: string, patterns: string[]): boolean {
  let candidate = value;
  while (true) {
    if (containsCredentialPattern(candidate, patterns) ||
        containsEncodedCredential(candidate, patterns)) {
      return true;
    }
    const decoded = decodeUrlEscapes(candidate);
    if (decoded === candidate) return false;
    candidate = decoded;
  }
}

