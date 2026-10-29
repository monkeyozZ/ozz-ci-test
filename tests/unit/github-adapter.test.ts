import { describe, expect, it } from 'vitest';
import {
  GitHubAdapter,
  GitHubError,
  HttpsGitHubTransport,
  gitBranchRef,
  gitCommitSha,
  gitRelativePath,
  parseGitHubToken,
} from '../../packages/infrastructure/src/github.js';
import type {
  GitHubHttpRequest,
  GitHubHttpResponse,
} from '../../packages/infrastructure/src/github.js';

const token = `github_pat_${'t'.repeat(40)}`;
const commitSha = 'a'.repeat(40),
  treeSha = 'b'.repeat(40);
const repository = {
  id: 1234,
  full_name: 'owner/app',
  default_branch: 'main',
  private: true,
  archived: false,
};
const commit = {
  sha: commitSha,
  commit: {
    tree: { sha: treeSha },
    message: 'Pinned change\nbody',
    committer: { date: '2026-10-26T00:00:00Z' },
  },
};
function response(
  data: unknown,
  headers: Record<string, string> = {},
  status = 200,
): GitHubHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: Buffer.from(JSON.stringify(data)),
  };
}
function fixture(
  replies: Array<GitHubHttpResponse | ((request: GitHubHttpRequest) => GitHubHttpResponse)>,
) {
  const requests: GitHubHttpRequest[] = [];
  const adapter = new GitHubAdapter({
    apiOrigin: 'https://github-api.fixture.test',
    cloneOrigin: 'https://git.fixture.test',
    transport: {
      async request(input) {
        requests.push(input);
        const reply = replies.shift();
        if (!reply) throw new Error('Unexpected protocol request');
        return typeof reply === 'function' ? reply(input) : reply;
      },
    },
  });
  return { adapter, requests };
}

describe('GitHub production HTTP adapter', () => {
  it('returns only a configured clone origin after stable-ID and exact-commit checks', async () => {
    const repo = {
      ...repository,
      full_name: 'renamed/project',
      clone_url: 'https://attacker.invalid/steal.git',
    };
    const { adapter, requests } = fixture([response(repo), response(commit), response(repo)]);
    await expect(adapter.checkout(token, '1234', commitSha)).resolves.toEqual({
      githubRepositoryId: '1234',
      fullName: 'renamed/project',
      cloneUrl: 'https://git.fixture.test/renamed/project.git',
      commitSha,
    });
    expect(requests.every((request) => request.headers.authorization === `Bearer ${token}`)).toBe(
      true,
    );
    expect(requests[1]!.url).toContain(`/commits/${commitSha}`);
    expect(
      requests.every((request) => request.url.startsWith('https://github-api.fixture.test/')),
    ).toBe(true);
  });

  it('rejects a repository path that now identifies another numeric repository', async () => {
    const { adapter } = fixture([response({ ...repository, id: 5678 })]);
    await expect(adapter.repository(token, '1234')).rejects.toMatchObject({
      code: 'GITHUB_IDENTITY_CHANGED',
    });
  });

  it('does not substitute a newer commit for a reviewed SHA', async () => {
    const { adapter } = fixture([
      response(repository),
      response({ ...commit, sha: 'c'.repeat(40) }),
    ]);
    await expect(adapter.commit(token, '1234', commitSha)).rejects.toMatchObject({
      code: 'GITHUB_COMMIT_INVALID',
    });
  });

  it('resolves the explicitly selected branch and encodes its slash in the HTTP path', async () => {
    const { adapter, requests } = fixture([response(repository), response(commit)]);
    await expect(adapter.commit(token, '1234', 'refs/heads/release/one')).resolves.toMatchObject({
      sha: commitSha,
      treeSha,
    });
    expect(requests[1]!.url).toContain('/commits/release%2Fone');
  });

  it('parses a real Link URL containing unencoded affiliation commas', async () => {
    const path =
      '/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=2';
    const { adapter } = fixture([
      response([repository], {
        link: `<https://github-api.fixture.test${path}>; rel="next", <https://github-api.fixture.test${path}>; rel="last"`,
      }),
    ]);
    await expect(adapter.repositories(token)).resolves.toMatchObject({
      data: [{ id: '1234' }],
      nextPage: 2,
    });
  });

  it.each([
    'https://attacker.test/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=2',
    'https://github-api.fixture.test/user/keys?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=2',
    'https://github-api.fixture.test/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=1',
    'https://github-api.fixture.test/user/repos?visibility=all&affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100&page=3',
    'https://github-api.fixture.test/user/repos?visibility=all&affiliation=owner&sort=full_name&per_page=100&page=2',
    'not-a-url',
  ])('rejects a redirected or nonsequential pagination link: %s', async (link) => {
    const { adapter, requests } = fixture([
      response([repository], { link: `<${link}>; rel="next"` }),
    ]);
    await expect(adapter.repositories(token)).rejects.toMatchObject({
      code: 'GITHUB_PAGINATION_INVALID',
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [401, {}, 'GITHUB_UNAUTHENTICATED'],
    [403, {}, 'GITHUB_FORBIDDEN'],
    [403, { 'x-ratelimit-remaining': '0' }, 'GITHUB_RATE_LIMITED'],
    [429, {}, 'GITHUB_RATE_LIMITED'],
    [404, {}, 'GITHUB_NOT_FOUND'],
  ])(
    'classifies HTTP %s without exposing remote response or PAT',
    async (status, headers, code) => {
      const { adapter } = fixture([
        response({ message: token }, headers as Record<string, string>, status as number),
      ]);
      let caught: unknown;
      try {
        await adapter.account(token);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(GitHubError);
      expect(caught).toMatchObject({ code });
      expect(String(caught)).not.toContain(token);
      expect(JSON.stringify(caught)).not.toContain(token);
    },
  );

  it('enforces response bytes even when the transport is injected', async () => {
    const { adapter } = fixture([
      { status: 200, headers: {}, body: Buffer.alloc(2 * 1024 * 1024 + 1) },
    ]);
    await expect(adapter.account(token)).rejects.toMatchObject({
      code: 'GITHUB_RESPONSE_TOO_LARGE',
    });
  });

  it('rejects malformed UTF-8 before interpreting response fields', async () => {
    const { adapter } = fixture([
      {
        status: 200,
        headers: {},
        body: Buffer.concat([
          Buffer.from('{"id":1234,"login":"'),
          Buffer.from([0xff]),
          Buffer.from('"}'),
        ]),
      },
    ]);
    await expect(adapter.account(token)).rejects.toMatchObject({ code: 'GITHUB_INVALID_RESPONSE' });
  });

  it('requires a parseable CA certificate for controlled HTTPS and clone trust', () => {
    for (const caCertificate of [
      '',
      'not a certificate',
      '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----',
    ]) {
      expect(() => new HttpsGitHubTransport({ caCertificate })).toThrow(GitHubError);
      expect(() => new GitHubAdapter({ cloneCaCertificate: caCertificate })).toThrow(GitHubError);
    }
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 1048577])(
    'rejects invalid Dockerfile size %s',
    async (size) => {
      const { adapter } = fixture([response(repository), response({ type: 'file', size })]);
      await expect(
        adapter.path(token, '1234', commitSha, 'Dockerfile', 'file'),
      ).rejects.toMatchObject({ code: 'GITHUB_PATH_INVALID' });
    },
  );

  it('does not claim an unknown preexisting hook merely because its ordinary URL matches', async () => {
    const url = 'https://control.fixture.test/hooks/github';
    const hook = { id: 88, name: 'web', active: true, events: ['push'], config: { url } };
    const { adapter, requests } = fixture([response(repository), response([hook])]);
    await expect(
      adapter.registerHook(token, '1234', { url, secret: 's'.repeat(40) }),
    ).rejects.toMatchObject({ code: 'GITHUB_HOOK_INVALID' });
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET']);
  });

  it('recovers a response-lost creation only through the persisted random callback identity', async () => {
    const registrationId = '5d26c5d8-9fd0-4f18-82a4-786417de02ea';
    const url = `https://control.fixture.test/api/webhooks/github/f659d55e-7636-4eee-a518-f39baf9e8e16/${registrationId}`;
    const hook = { id: 88, name: 'web', active: true, events: ['push'], config: { url } };
    const { adapter, requests } = fixture([response(repository), response([hook]), response(hook)]);
    await expect(
      adapter.registerHook(token, '1234', { url, registrationId, secret: 's'.repeat(40) }),
    ).resolves.toMatchObject({ id: '88', url });
    expect(requests.map((request) => request.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(requests[2]!.url).toMatch(/\/hooks\/88$/);
  });

  it('validates PAT type, commit shape, source paths, and constructor budgets before I/O', () => {
    expect(() => parseGitHubToken({ token: 'ghp_legacy' })).toThrow(GitHubError);
    expect(() => parseGitHubToken({ token, cloneUrl: 'https://attacker.test' })).toThrow(
      GitHubError,
    );
    expect(() => gitCommitSha('HEAD')).toThrow(GitHubError);
    expect(() => gitCommitSha('0'.repeat(40))).toThrow(GitHubError);
    for (const path of [
      '/etc/passwd',
      '../Dockerfile',
      'src/../Dockerfile',
      'a\\b',
      '.git/config',
      'a\0b',
    ])
      expect(() => gitRelativePath(path)).toThrow(GitHubError);
    for (const ref of [
      'main',
      'refs/heads/a..b',
      'refs/heads/a@{b',
      'refs/heads/a.lock',
      'refs/heads/a/b.lock',
    ])
      expect(() => gitBranchRef(ref)).toThrow(GitHubError);
    expect(gitRelativePath('.', true)).toBe('.');
    expect(() => new GitHubAdapter({ apiOrigin: 'http://unsafe.test' })).toThrow(GitHubError);
    expect(() => new GitHubAdapter({ requestTimeoutMs: -1 })).toThrow(GitHubError);
    expect(() => new GitHubAdapter({ maxResponseBytes: 1024 * 1024 * 100 })).toThrow(GitHubError);
  });
});
