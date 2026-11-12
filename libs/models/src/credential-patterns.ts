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

export function containsCredentialPattern(value: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (value.includes(pattern)) return true;
  }
  return false;
}
