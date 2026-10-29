import { describe, expect, it } from 'vitest';
import {
  allocateHostname,
  clusterDomainSuffix,
  clusterNetworkingInput,
  hostname,
  platformSettingsInput,
} from '../../packages/control-plane/src/networking/validation.js';

describe('networking names and entry configuration', () => {
  it('normalizes DNS names and internationalized labels without accepting URL syntax', () => {
    expect(hostname('  WEB.Example.COM. ')).toBe('web.example.com');
    expect(hostname('应用.example.com')).toBe('xn--exto61c.example.com');
    for (const value of [
      'https://app.example.com',
      '*.example.com',
      'app..com',
      '127.0.0.1',
      'app.com/a',
      'app.com:443',
      '-app.example',
      'a'.repeat(64) + '.test',
    ])
      expect(() => hostname(value), value).toThrow();
  });

  it('accepts explicit local-lab entry addresses while rejecting URLs, zones and empty entry configuration', () => {
    const input = {
      revision: 0,
      subdomain: 'LAB-A',
      entryAddresses: ['2001:db8:0:0::1', '2001:db8::1', '127.0.0.1'],
      cnameTarget: null,
    };
    expect(clusterNetworkingInput(input)).toEqual({
      ...input,
      subdomain: 'lab-a',
      entryAddresses: ['127.0.0.1', '2001:db8::1'],
    });
    for (const address of ['https://127.0.0.1', 'fe80::1%eth0', '10.0.0.1:443', '999.2.3.4'])
      expect(() => clusterNetworkingInput({ ...input, entryAddresses: [address] })).toThrow();
    expect(() => clusterNetworkingInput({ ...input, entryAddresses: [] })).toThrow();
    expect(
      clusterNetworkingInput({ ...input, entryAddresses: [], cnameTarget: 'edge.example.com' })
        .cnameTarget,
    ).toBe('edge.example.com');
  });

  it('allocates a valid bounded hostname from a persisted UUID and keeps ID collisions distinguishable', () => {
    const suffix = clusterDomainSuffix('apps.example.com', 'a');
    const id = 'c508b1f2-fbfd-4c6e-a514-af6e3c4dcd3c';
    const result = allocateHostname('a'.repeat(63), id, suffix);
    expect(result.split('.')[0]?.length).toBe(63);
    expect(result).toContain('-c508b1f2fbfd.a.apps.example.com');
    expect(allocateHostname('a'.repeat(63), id, suffix)).toBe(result);
    expect(
      allocateHostname('a'.repeat(63), 'c508b1f2-fbfe-4c6e-a514-af6e3c4dcd3c', suffix),
    ).not.toBe(result);
    expect(() =>
      clusterDomainSuffix(
        `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.test`,
        'd'.repeat(63),
      ),
    ).toThrow();
  });

  it('validates initial revisions, email and exact write fields', () => {
    expect(
      platformSettingsInput({
        revision: 0,
        appsDomainSuffix: 'APPS.example.com',
        acmeEmail: 'admin+ozz@EXAMPLE.com',
      }),
    ).toEqual({
      revision: 0,
      appsDomainSuffix: 'apps.example.com',
      acmeEmail: 'admin+ozz@example.com',
    });
    expect(
      platformSettingsInput({ revision: 2, appsDomainSuffix: null, acmeEmail: null })
        .appsDomainSuffix,
    ).toBeNull();
    for (const revision of [-1, 1.1, '1', undefined])
      expect(() =>
        platformSettingsInput({ revision, appsDomainSuffix: null, acmeEmail: null }),
      ).toThrow();
    expect(() =>
      platformSettingsInput({ revision: 0, appsDomainSuffix: 'example.com', acmeEmail: 'invalid' }),
    ).toThrow();
    expect(() =>
      platformSettingsInput({
        revision: 0,
        appsDomainSuffix: null,
        acmeEmail: null,
        clusterId: 'other',
      }),
    ).toThrow();
  });
});
