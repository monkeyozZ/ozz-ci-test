import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretCipher } from '../../packages/control-plane/src/secrets.js';

describe('secret-bearing request fingerprints', () => {
  it('requires the same key, purpose and payload for a deterministic match', () => {
    const key = randomBytes(32);
    const first = new SecretCipher({ activeVersion: 1, keys: new Map([[1, key]]) });
    const sameKey = new SecretCipher({ activeVersion: 1, keys: new Map([[1, key]]) });
    const otherKey = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
    const purpose = 'service-create.v1';
    const payload = JSON.stringify({ secret: 'fixture-pin-1234' });
    const fingerprint = first.requestFingerprint(purpose, payload);

    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(sameKey.requestFingerprint(purpose, payload)).toBe(fingerprint);
    expect(sameKey.matchesRequestFingerprint(purpose, payload, fingerprint)).toBe(true);
    expect(otherKey.requestFingerprint(purpose, payload)).not.toBe(fingerprint);
    expect(otherKey.matchesRequestFingerprint(purpose, payload, fingerprint)).toBe(false);
    expect(first.matchesRequestFingerprint('another-command.v1', payload, fingerprint)).toBe(false);
    expect(first.matchesRequestFingerprint(purpose, payload + ' ', fingerprint)).toBe(false);
    expect(first.requestFingerprint('a:b', 'c')).not.toBe(first.requestFingerprint('a', 'b:c'));
  });

  it('writes with the active key and verifies receipts with retained keys after rotation', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = new SecretCipher({ activeVersion: 1, keys: new Map([[1, oldKey]]) });
    const rotated = new SecretCipher({
      activeVersion: 2,
      keys: new Map([
        [1, oldKey],
        [2, newKey],
      ]),
    });
    const currentOnly = new SecretCipher({ activeVersion: 2, keys: new Map([[2, newKey]]) });
    const purpose = 'service-create.v1';
    const payload = JSON.stringify({ secret: 'fixture-pin-1234' });
    const oldFingerprint = before.requestFingerprint(purpose, payload);
    const newFingerprint = rotated.requestFingerprint(purpose, payload);

    expect(rotated.matchesRequestFingerprint(purpose, payload, oldFingerprint)).toBe(true);
    expect(newFingerprint).not.toBe(oldFingerprint);
    expect(currentOnly.requestFingerprint(purpose, payload)).toBe(newFingerprint);
    expect(currentOnly.matchesRequestFingerprint(purpose, payload, newFingerprint)).toBe(true);
    expect(currentOnly.matchesRequestFingerprint(purpose, payload, oldFingerprint)).toBe(false);
    expect(before.matchesRequestFingerprint(purpose, payload, newFingerprint)).toBe(false);
    expect(rotated.matchesRequestFingerprint(purpose, 'changed', oldFingerprint)).toBe(false);
  });

  it('rejects malformed fingerprints without attempting an unsafe length comparison', () => {
    const cipher = new SecretCipher({ activeVersion: 1, keys: new Map([[1, randomBytes(32)]]) });
    for (const invalid of ['', '0'.repeat(63), '0'.repeat(65), 'g'.repeat(64)])
      expect(cipher.matchesRequestFingerprint('service-create.v1', 'fixture', invalid)).toBe(false);
  });
});
