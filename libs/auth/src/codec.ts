// Copied from OpenCrane 1 (10abd0ef6)
// libs/backend/server/infra/auth/src/sessions/oidc-session-codec.ts; changed:
// pulled the encrypt/decrypt core out into a small reusable codec (shared by
// the session cookie and the short-lived login-flow cookie below), and
// dropped the server-side session store entirely — the whole envelope now
// lives in the browser's cookie, nowhere else.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ZodType } from 'zod';

const ENVELOPE_VERSION = '1';

// AES-256-GCM sizes in bytes. The tag must be the full 128 bits: Node accepts
// a shorter tag unless told otherwise, and a short tag is cheap to forge (and
// leaks the GHASH key). Both lengths are pinned and checked before decrypting.
const NONCE_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;

/** Thrown when a cookie fails to decrypt or does not match its schema. */
export class EnvelopeError extends Error {}

/**
 * Builds an encode/decode pair for turning a typed value into a cookie value
 * that is both encrypted and signed, and back again.
 *
 * AES-256-GCM does both jobs with one primitive: it hides the payload AND
 * produces a 16-byte authentication tag, so changing a byte of the payload,
 * or cutting the tag short, makes decryption fail. That is what "encrypted
 * and signed" means here: there is no separate HMAC step.
 *
 * `purpose` keys the derived encryption key so a session cookie and a
 * login-flow cookie built from the same secret use different keys.
 */
export function createEnvelopeCodec<T>(secret: string, purpose: string, schema: ZodType<T>): { encode: (value: T) => string; decode: (cookieValue: string) => T } {
  const key = Buffer.from(hkdfSync('sha256', secret, purpose, 'opencrane/auth/envelope/v1', 32));

  function encode(value: T): string {
    const plaintext = Buffer.from(JSON.stringify(schema.parse(value)), 'utf8');
    const nonce = randomBytes(NONCE_LENGTH_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH_BYTES });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [ENVELOPE_VERSION, nonce.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  function decode(cookieValue: string): T {
    const parts = cookieValue.split('.');
    const [version, nonceB64, tagB64, ciphertextB64] = parts;
    if (parts.length !== 4 || version !== ENVELOPE_VERSION || nonceB64 === undefined || tagB64 === undefined || ciphertextB64 === undefined) {
      throw new EnvelopeError('malformed cookie envelope');
    }
    const nonce = Buffer.from(nonceB64, 'base64url');
    const tag = Buffer.from(tagB64, 'base64url');
    if (nonce.length !== NONCE_LENGTH_BYTES || tag.length !== TAG_LENGTH_BYTES) {
      throw new EnvelopeError('cookie envelope nonce or tag is the wrong length');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LENGTH_BYTES });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64url')), decipher.final()]);
      return schema.parse(JSON.parse(plaintext.toString('utf8')));
    } catch (err) {
      throw new EnvelopeError('cookie failed to decrypt or verify', { cause: err });
    }
  }

  return { encode, decode };
}
