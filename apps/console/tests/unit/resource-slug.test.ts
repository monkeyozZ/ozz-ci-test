import { describe, expect, it } from 'vitest';
import { resourceSlug } from '../../src/lib/utils';

describe('resource identifiers generated from display names', () => {
  it.each(['我的博客', '123', '  ', 'Équipe API', 'api-'.repeat(30)])(
    'makes %j usable as a service identifier',
    (name) => {
      const slug = resourceSlug(name, 'a1b2c3');
      expect(slug).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
      expect(slug.length).toBeLessThanOrEqual(63);
      expect(slug).toContain('a1b2c3');
    },
  );

  it('keeps retries stable and gives separate drafts different identifiers', () => {
    const first = resourceSlug('我的博客', 'a1b2c3', 'project');
    expect(resourceSlug('我的博客', 'a1b2c3', 'project')).toBe(first);
    expect(resourceSlug('我的博客', 'd4e5f6', 'project')).not.toBe(first);
    expect(first).toMatch(/^project-/);
  });
});
