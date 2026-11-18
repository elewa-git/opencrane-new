import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256HexOfJson } from '../src/digest.js';

function oldHex(value: string | Uint8Array) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}

describe('shared SHA-256 hex digests', () => {
  it('matches the published SHA-256 abc vector', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('preserves strings, empty input, Unicode and exact byte ranges', () => {
    const bytes = new Uint8Array([255, 0, 128, 97, 98, 99, 254]);
    const values = ['', 'plain text', 'Één 🏗️\u0000東京', bytes, bytes.subarray(1, 6)];
    for (const value of values) {
      expect(sha256Hex(value)).toBe(oldHex(value));
    }
  });

  it('hashes nested JSON in insertion order with the existing stringify rules', () => {
    const value = { second: ['é', { z: 2, a: 1 }], first: { missing: undefined, nil: null } };
    const reordered = { first: value.first, second: value.second };
    expect(sha256HexOfJson(value)).toBe(oldHex(JSON.stringify(value)));
    expect(sha256HexOfJson(reordered)).toBe(oldHex(JSON.stringify(reordered)));
    expect(sha256HexOfJson(value)).not.toBe(sha256HexOfJson(reordered));
  });

  it('preserves stringify failure behaviour', () => {
    expect(() => sha256HexOfJson(undefined)).toThrow(TypeError);
    expect(() => sha256HexOfJson(1n)).toThrow(TypeError);
  });

  it('preserves file bytes, provider references and command identity digests', () => {
    const fileBytes = Buffer.from('%PDF-1.7\nWillow-47\n', 'utf8');
    const providerIdentity = ['silo_fixed', 'provider_fixed', 'command_fixed'];
    const commandIdentity = ['silo_fixed', 'member_fixed', 'answer_fixed'].join('\0');
    expect(sha256Hex(fileBytes)).toBe(oldHex(fileBytes));
    expect(sha256HexOfJson(providerIdentity)).toBe(oldHex(JSON.stringify(providerIdentity)));
    expect(sha256Hex(commandIdentity).slice(0, 32)).toBe(oldHex(commandIdentity).slice(0, 32));
  });
});
