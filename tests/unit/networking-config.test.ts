import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getServers } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../packages/config/dist/index.js';
import { readLocalAcmeConfiguration } from '../../apps/worker/src/networking-config.js';

const directory = mkdtempSync(join(tmpdir(), 'ozz-local-acme-config-'));
const file = join(directory, 'fixture.json');
let caBundle: string;
function configuration(overrides: Record<string, unknown> = {}) {
  const value = {
    version: 1,
    stagingUrl: 'https://192.168.5.15:14000/dir',
    productionUrl: 'https://192.168.5.15:14100/dir',
    caBundle,
    solverNameservers: ['192.168.5.15:1053'],
    ...overrides,
  };
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  chmodSync(file, 0o600);
  return value;
}

beforeAll(() => {
  chmodSync(directory, 0o700);
  const config = join(directory, 'ca.cnf');
  writeFileSync(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Ozz Local Test CA\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
    { mode: 0o600 },
  );
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-config',
      config,
      '-keyout',
      join(directory, 'ca.key'),
      '-out',
      join(directory, 'ca.crt'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  chmodSync(join(directory, 'ca.key'), 0o600);
  caBundle = readFileSync(join(directory, 'ca.crt'), 'utf8');
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('explicit local ACME configuration boundary', () => {
  it('keeps normal startup unchanged and rejects production before reading a fixture path', async () => {
    expect(
      await readLocalAcmeConfiguration({
        nodeEnv: 'production',
        networkLocalAcmeConfigFile: undefined,
      }),
    ).toBeUndefined();
    await expect(
      readLocalAcmeConfiguration({
        nodeEnv: 'production',
        networkLocalAcmeConfigFile: '/nonexistent/test-fixture.json',
      }),
    ).rejects.toThrow('not allowed in production');
  });

  it('loads a protected explicit CA for private endpoints without changing global DNS', async () => {
    configuration();
    const servers = getServers();
    const loaded = await readLocalAcmeConfiguration({
      nodeEnv: 'development',
      networkLocalAcmeConfigFile: file,
    });
    expect(loaded).toMatchObject({
      stagingUrl: 'https://192.168.5.15:14000/dir',
      solverNameservers: ['192.168.5.15:1053'],
      caBundle,
    });
    expect(getServers()).toEqual(servers);
  });

  it('rejects insecure/public/authenticated endpoints, unknown fields and leaked key material with controlled errors', async () => {
    for (const overrides of [
      { stagingUrl: 'http://192.168.5.15:14000/dir' },
      { stagingUrl: 'https://8.8.8.8/dir' },
      { stagingUrl: 'https://localhost/dir' },
      { stagingUrl: 'https://user:synthetic-secret@127.0.0.1/dir' },
      { stagingUrl: 'https://192.168.5.15:14100/dir' },
      { solverNameservers: ['8.8.8.8:53'] },
      { caBundle: readFileSync(join(directory, 'ca.key'), 'utf8') },
      { unexpected: 'synthetic-secret' },
    ]) {
      configuration(overrides);
      try {
        await readLocalAcmeConfiguration({ nodeEnv: 'test', networkLocalAcmeConfigFile: file });
        throw new Error('Invalid fixture was accepted');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        expect(String(error)).not.toContain('synthetic-secret');
        expect(String(error)).not.toContain('PRIVATE KEY');
      }
    }
  });

  it('rejects readable-by-others files and symbolic links', async () => {
    configuration();
    chmodSync(file, 0o644);
    await expect(
      readLocalAcmeConfiguration({ nodeEnv: 'test', networkLocalAcmeConfigFile: file }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    chmodSync(file, 0o600);
    const link = join(directory, 'linked.json');
    symlinkSync(file, link);
    await expect(
      readLocalAcmeConfiguration({ nodeEnv: 'test', networkLocalAcmeConfigFile: link }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
