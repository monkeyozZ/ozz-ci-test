export type GitHubErrorCode =
  | 'GITHUB_CREDENTIAL_INVALID'
  | 'GITHUB_UNAUTHENTICATED'
  | 'GITHUB_FORBIDDEN'
  | 'GITHUB_NOT_FOUND'
  | 'GITHUB_RATE_LIMITED'
  | 'GITHUB_TIMEOUT'
  | 'GITHUB_CANCELLED'
  | 'GITHUB_UNAVAILABLE'
  | 'GITHUB_TLS_INVALID'
  | 'GITHUB_INVALID_RESPONSE'
  | 'GITHUB_RESPONSE_TOO_LARGE'
  | 'GITHUB_PAGINATION_INVALID'
  | 'GITHUB_IDENTITY_CHANGED'
  | 'GITHUB_COMMIT_INVALID'
  | 'GITHUB_PATH_INVALID'
  | 'GITHUB_HOOK_INVALID';

/** Deliberately carries neither raw headers/bodies nor the original transport error. */
export class GitHubError extends Error {
  constructor(
    readonly code: GitHubErrorCode,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'GitHubError';
  }
}
export interface GitHubRepository {
  id: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
}
export interface GitHubCommit {
  sha: string;
  treeSha: string;
  title: string;
  committedAt: string | null;
}
export interface GitHubPage<T> {
  data: T[];
  nextPage: number | null;
}
export interface GitHubHook {
  id: string;
  active: boolean;
  url: string;
  events: string[];
}
export interface GitHubHttpRequest {
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
  signal?: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
}
export interface GitHubHttpResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}
export interface GitHubHttpTransport {
  request(input: GitHubHttpRequest): Promise<GitHubHttpResponse>;
}
export interface GitHubClient {
  account(token: string, signal?: AbortSignal): Promise<{ id: string; login: string }>;
  repositories(
    token: string,
    page?: number,
    signal?: AbortSignal,
  ): Promise<GitHubPage<GitHubRepository>>;
  repository(
    token: string,
    githubRepositoryId: string,
    signal?: AbortSignal,
  ): Promise<GitHubRepository>;
  branches(
    token: string,
    githubRepositoryId: string,
    page?: number,
    signal?: AbortSignal,
  ): Promise<GitHubPage<{ name: string; ref: string; commitSha: string }>>;
  commit(
    token: string,
    githubRepositoryId: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<GitHubCommit>;
  path(
    token: string,
    githubRepositoryId: string,
    commitSha: string,
    path: string,
    kind: 'file' | 'dir',
    signal?: AbortSignal,
  ): Promise<void>;
  checkout(
    token: string,
    githubRepositoryId: string,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<{
    githubRepositoryId: string;
    fullName: string;
    cloneUrl: string;
    commitSha: string;
    caCertificate?: string;
  }>;
  registerHook(
    token: string,
    githubRepositoryId: string,
    input: { url: string; secret: string; hookId?: string; registrationId?: string },
    signal?: AbortSignal,
  ): Promise<GitHubHook>;
  hook(
    token: string,
    githubRepositoryId: string,
    hookId: string,
    signal?: AbortSignal,
  ): Promise<GitHubHook>;
}
