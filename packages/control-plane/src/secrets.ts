import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export class MasterKeyError extends Error {
  constructor() {
    super(
      'Master key file is missing, invalid, or has unsafe permissions; no replacement was generated',
    );
    this.name = 'MasterKeyError';
  }
}

export class SecretAuthenticationError extends Error {
  constructor() {
    super('Secret authentication failed; check the matching master key backup');
    this.name = 'SecretAuthenticationError';
  }
}

export interface EncryptedSecret {
  encryptedPayload: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
}

export interface MasterKeys {
  activeVersion: number;
  keys: Map<number, Buffer>;
}

export function readMasterKeys(file: string): MasterKeys {
  try {
    const path = resolve(file);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 65536) throw new Error('invalid');
    // Docker secrets are isolated mounts and may appear 0444 inside the container.
    if (!path.startsWith('/run/secrets/') && (stat.mode & 0o077) !== 0) {
      throw new Error('permissions');
    }
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object') throw new Error('invalid');
    const raw = value as { activeVersion?: unknown; keys?: unknown };
    if (!Number.isSafeInteger(raw.activeVersion) || Number(raw.activeVersion) < 1)
      throw new Error('invalid');
    if (!raw.keys || typeof raw.keys !== 'object' || Array.isArray(raw.keys))
      throw new Error('invalid');
    const keys = new Map<number, Buffer>();
    for (const [version, text] of Object.entries(raw.keys)) {
      if (!/^[1-9]\d*$/.test(version) || typeof text !== 'string') throw new Error('invalid');
      const key = Buffer.from(text, 'base64');
      if (key.length !== 32 || key.toString('base64') !== text) throw new Error('invalid');
      keys.set(Number(version), key);
    }
    if (!keys.has(Number(raw.activeVersion))) throw new Error('invalid');
    return { activeVersion: Number(raw.activeVersion), keys };
  } catch {
    throw new MasterKeyError();
  }
}

export class SecretCipher {
  constructor(private readonly masterKeys: MasterKeys) {}

  encrypt(kind: string, payload: Record<string, unknown>) {
    const keyVersion = this.masterKeys.activeVersion;
    const key = this.masterKeys.keys.get(keyVersion)!;
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`ozz.secret.v1:${kind}`));
    const encryptedPayload = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    return { encryptedPayload, nonce, tag: cipher.getAuthTag(), keyVersion };
  }

  decrypt(secret: EncryptedSecret & { kind: string }): Record<string, unknown> {
    try {
      const key = this.masterKeys.keys.get(secret.keyVersion);
      if (!key) throw new Error('missing version');
      const cipher = createDecipheriv('aes-256-gcm', key, secret.nonce);
      cipher.setAAD(Buffer.from(`ozz.secret.v1:${secret.kind}`));
      cipher.setAuthTag(Buffer.from(secret.tag));
      const decoded: unknown = JSON.parse(
        Buffer.concat([cipher.update(secret.encryptedPayload), cipher.final()]).toString('utf8'),
      );
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        throw new Error('payload');
      return decoded as Record<string, unknown>;
    } catch {
      throw new SecretAuthenticationError();
    }
  }
}
