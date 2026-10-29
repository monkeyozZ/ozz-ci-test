import { describe, expect, it } from 'vitest';
import { resourceDetailLocation, resourceListPath } from '../../src/lib/resource-list-navigation';

describe('resource list return paths', () => {
  it('keeps list filters while excluding unrelated and sensitive query fields', () => {
    const value = resourceListPath(
      '/volumes?projectId=p&environmentId=e&clusterId=c&serviceId=s&retained=false&search=two%20words&credentialRefId=omit&token=omit&list=%2Fdatabases#section',
      'volumes',
    );
    const url = new URL(value!, 'https://ozz.invalid');
    expect(url.pathname).toBe('/volumes');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      projectId: 'p',
      environmentId: 'e',
      clusterId: 'c',
      serviceId: 's',
      retained: 'false',
      search: 'two words',
    });
    expect(url.hash).toBe('');
    expect(
      resourceListPath('/infrastructure?tab=servers&search=台北&projectId=p', 'infrastructure'),
    ).toBe('/infrastructure?tab=servers&search=%E5%8F%B0%E5%8C%97');
    expect(resourceListPath('/databases?retained=true&search=app', 'databases')).toBe(
      '/databases?search=app',
    );
  });

  it('rejects external, ambiguous and unrelated destinations', () => {
    for (const value of [
      'https://example.test/volumes',
      '//example.test/volumes',
      '/\\example.test/volumes',
      'javascript:alert(1)',
      '/databases?search=app',
      '/volumes/record',
      '/volumes?projectId=a&projectId=b',
      '/volumes\n?search=app',
      ['/volumes', '/databases'],
      null,
    ])
      expect(resourceListPath(value, 'volumes'), JSON.stringify(value)).toBeUndefined();
  });

  it('adds return metadata only for a corresponding collection entry', () => {
    expect(
      resourceDetailLocation('/volumes/v', '/volumes?search=app&retained=false', 'volumes'),
    ).toEqual({ path: '/volumes/v', query: { list: '/volumes?retained=false&search=app' } });
    expect(
      resourceDetailLocation('/volumes/v', '/projects/p/services/s?tab=storage', 'volumes'),
    ).toEqual({ path: '/volumes/v' });
    expect(resourceDetailLocation('/databases/d', undefined, 'databases')).toEqual({
      path: '/databases/d',
    });
  });
});
