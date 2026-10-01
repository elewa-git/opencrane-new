import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createEnvelopeCodec, EnvelopeError } from '../src/codec.ts';
import { replaceInCiphertext, truncateAuthTag, truncateNonce } from './fixtures.ts';

const schema = z.object({ orgId: z.string().min(1) }).strict();
const { encode, decode } = createEnvelopeCodec('a'.repeat(32), 'test', schema);

describe('createEnvelopeCodec', () => {
  it('round-trips a value', () => {
    expect(decode(encode({ orgId: 'org-1' }))).toEqual({ orgId: 'org-1' });
  });

  it('rejects a forged cookie that still decodes to valid, schema-matching JSON', () => {
    // Without the tag check this would quietly decode to { orgId: 'org-2' }.
    const forged = replaceInCiphertext(encode({ orgId: 'org-1' }), JSON.stringify({ orgId: 'org-1' }), 'org-1', 'org-2');
    expect(() => decode(forged)).toThrow(EnvelopeError);
  });

  // A 4-byte tag would only need 32 bits guessing; the tag must be the full 16 bytes.
  it.each([4, 8, 12])('rejects an authentication tag cut down to %i bytes', (length) => {
    expect(() => decode(truncateAuthTag(encode({ orgId: 'org-1' }), length))).toThrow(EnvelopeError);
  });

  it('rejects an authentication tag that is too long', () => {
    const [version, nonce, tag, ciphertext] = encode({ orgId: 'org-1' }).split('.');
    const longTag = Buffer.concat([Buffer.from(tag!, 'base64url'), Buffer.alloc(4)]).toString('base64url');
    expect(() => decode([version, nonce, longTag, ciphertext].join('.'))).toThrow(EnvelopeError);
  });

  it('rejects a nonce cut down to 4 bytes', () => {
    expect(() => decode(truncateNonce(encode({ orgId: 'org-1' }), 4))).toThrow(EnvelopeError);
  });
});
