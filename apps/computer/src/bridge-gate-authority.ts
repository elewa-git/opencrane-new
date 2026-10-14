export function requireBridgeGateAuthority(): void {
  // Refuse every gate until trusted delivery supplies a signing key, this computer's
  // identity and generation, and the current saved takeover. A bridge pass alone
  // proves none of these, so the request cannot authorise its own binding.
  throw new Error('Bridge gate authority unavailable');
}
