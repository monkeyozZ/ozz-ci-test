import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigurationError, createLogger, loadConfig } from '../../packages/config/dist/index.js';
import {
  MasterKeyError,
  SecretAuthenticationError,
  SecretCipher,
  readMasterKeys,
} from '../../packages/control-plane/dist/secrets.js';

const directory = mkdtempSync(join(tmpdir(), 'ozz-key-unit-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('configuration and credential boundaries', () => {
  const environment = {
    DATABASE_URL: 'postgresql://test:synthetic-password@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    APP_ORIGIN: 'https://console.example.test',
    MASTER_KEY_FILE: '/private/ozz-key.json',
  };

  it('rejects unsafe origins, malformed proxy ranges and invalid ports without disclosing values', () => {
    for (const overrides of [
      { DATABASE_URL: 'synthetic-secret-value' },
      { REDIS_URL: 'https://synthetic-secret-value' },
      { APP_ORIGIN: 'https://user:synthetic-secret-value@console.example.test' },
      { APP_ORIGIN: 'https://console.example.test/private?synthetic-secret-value' },
      { APP_ORIGIN: 'ftp://console.example.test' },
      { NODE_ENV: 'production', APP_ORIGIN: 'http://console.example.test' },
      { PORT: '0' },
      { PORT: '65536' },
      { TRUSTED_PROXY_CIDRS: 'true' },
      { TRUSTED_PROXY_CIDRS: '127.0.0.1/24/unexpected' },
      { TRUSTED_PROXY_CIDRS: '127.0.0.1/33' },
      { TRUSTED_PROXY_CIDRS: '::1/129' },
      { NETWORK_DNS_SERVERS: 'https://synthetic-secret-value' },
      { NETWORK_DNS_SERVERS: '127.0.0.1:0' },
      { NETWORK_DNS_SERVERS: '[::1]:65536' },
      { NODE_ENV: 'production', NETWORK_LOCAL_ACME_CONFIG_FILE: '/private/test-acme.json' },
      { REGISTRY_HTTP_PROXY: 'http://user:synthetic-secret-value@localhost:7890' },
      { REGISTRY_HTTP_PROXY: 'http://localhost:7890/private?synthetic-secret-value' },
      { REGISTRY_HTTP_PROXY: 'socks5://localhost:7890' },
      { REGISTRY_PROXY_BLOB_ORIGINS: 'https://cdn.example.test' },
      {
        REGISTRY_HTTP_PROXY: 'http://localhost:7890',
        REGISTRY_PROXY_BLOB_ORIGINS: 'http://cdn.example.test',
      },
      {
        REGISTRY_HTTP_PROXY: 'http://localhost:7890',
        REGISTRY_PROXY_BLOB_ORIGINS: 'https://cdn.example.test/private',
      },
      {
        REGISTRY_HTTP_PROXY: 'http://localhost:7890',
        REGISTRY_PROXY_BLOB_ORIGINS: 'https://user:synthetic-secret-value@cdn.example.test',
      },
    ]) {
      try {
        loadConfig({ ...environment, ...overrides });
        throw new Error('Unsafe configuration was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect(String(error)).not.toContain('synthetic-secret-value');
      }
    }
    expect(loadConfig(environment).trustedProxyCidrs).toEqual([]);
    expect(loadConfig(environment).registryHttpProxy).toBeUndefined();
    expect(loadConfig(environment).registryProxyBlobOrigins).toEqual([]);
    expect(
      loadConfig({
        ...environment,
        REGISTRY_HTTP_PROXY: 'http://127.0.0.1:7890',
        REGISTRY_PROXY_BLOB_ORIGINS: 'https://production.cloudfront.docker.com',
      }),
    ).toMatchObject({
      registryHttpProxy: 'http://127.0.0.1:7890',
      registryProxyBlobOrigins: ['https://production.cloudfront.docker.com'],
    });
    expect(
      loadConfig({ ...environment, TRUSTED_PROXY_CIDRS: '127.0.0.1/32, ::1/128' })
        .trustedProxyCidrs,
    ).toEqual(['127.0.0.1/32', '::1/128']);
    expect(
      loadConfig({ ...environment, NETWORK_DNS_SERVERS: '127.0.0.1:1053, [::1]:53, 1.1.1.1' })
        .networkDnsServers,
    ).toEqual(['127.0.0.1:1053', '[::1]:53', '1.1.1.1']);
  });

  it('redacts the request, credentials and connection fields used by application logging', () => {
    const marker = 'synthetic-log-secret-not-for-output';
    const lines: string[] = [];
    const logger = createLogger(
      'security-test',
      {},
      {
        write: (line) => {
          lines.push(line);
        },
      },
    );
    logger.info(
      {
        requestId: 'safe-request-id',
        password: marker,
        passwordHash: marker,
        token: marker,
        csrfToken: marker,
        cookie: marker,
        authorization: marker,
        payload: { nested: marker },
        encryptedPayload: marker,
        nonce: marker,
        tag: marker,
        databaseUrl: marker,
        redisUrl: marker,
        privateKey: marker,
        passphrase: marker,
        connectionString: marker,
        req: {
          headers: { cookie: marker, authorization: marker, 'x-csrf-token': marker },
          body: { value: marker },
        },
        res: { headers: { 'set-cookie': marker } },
        credential: { password: marker, privateKey: marker, payload: marker },
      },
      'safe event',
    );
    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain(marker);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      requestId: 'safe-request-id',
      password: '[REDACTED]',
    });
  });

  it('authenticates ciphertext, kind and key version, with fresh nonces on repeated writes', () => {
    const keys = {
      activeVersion: 2,
      keys: new Map([
        [1, randomBytes(32)],
        [2, randomBytes(32)],
      ]),
    };
    const cipher = new SecretCipher(keys);
    const payload = { privateKey: 'synthetic-private-key', passphrase: 'synthetic-passphrase' };
    const first = cipher.encrypt('ssh', payload);
    const second = cipher.encrypt('ssh', payload);
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(false);
    expect(Buffer.from(first.encryptedPayload).toString('utf8')).not.toContain(payload.privateKey);
    expect(cipher.decrypt({ ...first, kind: 'ssh' })).toEqual(payload);
    const historical = new SecretCipher({ ...keys, activeVersion: 1 }).encrypt('ssh', payload);
    expect(cipher.decrypt({ ...historical, kind: 'ssh' })).toEqual(payload);
    const changed = Buffer.from(first.encryptedPayload);
    changed[0] = changed[0]! ^ 1;
    for (const value of [
      { ...first, kind: 'registry' },
      { ...first, kind: 'ssh', encryptedPayload: changed },
      { ...first, kind: 'ssh', tag: randomBytes(16) },
      { ...first, kind: 'ssh', nonce: randomBytes(12) },
      { ...first, kind: 'ssh', keyVersion: 3 },
    ])
      expect(() => cipher.decrypt(value)).toThrow(SecretAuthenticationError);
    expect(() =>
      new SecretCipher({ activeVersion: 2, keys: new Map([[2, randomBytes(32)]]) }).decrypt({
        ...first,
        kind: 'ssh',
      }),
    ).toThrow(SecretAuthenticationError);
  });

  it('requires a protected key file and never replaces missing or malformed material', () => {
    const file = join(directory, 'master-key.json');
    expect(() => readMasterKeys(file)).toThrow(MasterKeyError);
    const content = JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString('base64') },
    });
    writeFileSync(file, content, { mode: 0o600 });
    expect(readMasterKeys(file).activeVersion).toBe(1);
    chmodSync(file, 0o644);
    expect(() => readMasterKeys(file)).toThrow(MasterKeyError);
    chmodSync(file, 0o600);
    for (const invalid of [
      '{}',
      '{malformed',
      JSON.stringify({ activeVersion: 2, keys: { 1: randomBytes(32).toString('base64') } }),
      JSON.stringify({ activeVersion: 1, keys: { 1: randomBytes(31).toString('base64') } }),
    ]) {
      writeFileSync(file, invalid);
      expect(() => readMasterKeys(file)).toThrow(MasterKeyError);
    }
  });
});
