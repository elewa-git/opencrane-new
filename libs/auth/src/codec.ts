// Copied from OpenCrane 1 (10abd0ef6); shared by the session and login-flow cookies.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { ZodType } from 'zod';

const ENVELOPE_VERSION = '1';

// Keep the AES-GCM nonce and 128-bit tag lengths fixed. Node accepts shorter
// tags by default, but they are easier to forge and can expose the GHASH key.
// Check both lengths before decrypting.
const NONCE_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;

/** Thrown when a cookie fails to decrypt or does not match its schema. */
export class EnvelopeError extends Error {}

/**
 * Builds functions that turn a typed value into an encrypted cookie and back.
 *
 * AES-256-GCM hides the payload and adds a 16-byte authentication tag.
 * Changing the payload or shortening the tag makes decryption fail. There is
 * no separate HMAC step.
 *
 * Use `purpose` when deriving the key so session and login-flow cookies use
 * different keys, even when they start with the same secret.
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
