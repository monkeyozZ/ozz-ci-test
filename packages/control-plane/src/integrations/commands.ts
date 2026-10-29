import { createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '@ozz/database';
import { GitHubAdapter, GitHubError, type GitHubClient } from '@ozz/infrastructure/github';
import {
  BuilderError,
  HttpBuilderClient,
  HttpsBuilderTransport,
  parseProfile,
  verifySigned,
  type BuilderIdentity,
} from '@ozz/infrastructure/build';
import { parseImageReference, parseRegistryAccess } from '@ozz/infrastructure/registry';
import { SecretCipher } from '../secrets.js';
import { withWritableControlPlane } from '../recovery.js';
import { OperationRequestError, pageLimit } from '../tasks/contracts.js';
import { TaskRepository, type OperationActor } from '../tasks/repository.js';
import { integer, record, resourceId, text } from '../services/validation.js';
import { json } from '../services/persistence.js';
import {
  auditCredentialUse,
  currentGitCredential,
  integrationCredential,
  parseBuilderCredential,
} from './persistence.js';
import {
  builderView,
  githubConnectionView,
  gitRepositoryView,
  registryConnectionView,
} from './views.js';
import type { BuilderInput, GitHubConnectionInput, RegistryConnectionInput } from './contracts.js';

function expect<T>(value: T | null): T {
  if (!value) throw new OperationRequestError(404, 'RESOURCE_NOT_FOUND', '集成资源不存在。');
  return value;
}
function revision(row: { revision: number }, value: number) {
  integer(value, 1, 2147483647, '版本');
  if (row.revision !== value)
    throw new OperationRequestError(409, 'REVISION_CONFLICT', '集成配置已修改，请刷新后重试。');
}
function safeEndpoint(value: unknown): string {
  try {
    const endpoint = text(value, 2048, 'Builder HTTPS 地址'),
      url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new OperationRequestError(
      422,
      'BUILDER_ENDPOINT_INVALID',
      'Builder 地址须为不含路径或凭证的 HTTPS origin。',
    );
  }
}
function page<T extends { id: string; createdAt: Date }, R>(
  rows: T[],
  limit: number,
  present: (row: T) => R,
) {
  const data = rows.slice(0, limit),
    last = data.at(-1);
  return {
    data: data.map(present),
    page: {
      hasMore: rows.length > limit,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() }),
            ).toString('base64url')
          : null,
    },
  };
}
function after(value?: string) {
  if (!value) return {};
  try {
    if (value.length > 256) throw new Error();
    const raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      id: string;
      createdAt: string;
    };
    const id = resourceId(raw.id),
      date = new Date(raw.createdAt);
    if (!Number.isFinite(date.getTime())) throw new Error();
    return { OR: [{ createdAt: { lt: date } }, { createdAt: date, id: { lt: id } }] };
  } catch {
    throw new OperationRequestError(422, 'INVALID_CURSOR', '集成分页游标无效。');
  }
}

export class IntegrationCommands {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly github: GitHubClient = new GitHubAdapter(),
    private readonly appOrigin = 'https://localhost',
  ) {}
  async githubConnections(query: { limit?: number; cursor?: string } = {}) {
    const limit = pageLimit(query.limit),
      rows = await this.repository.db.gitHubConnection.findMany({
        where: after(query.cursor),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
    return page(rows, limit, githubConnectionView);
  }
  async registries(query: { limit?: number; cursor?: string } = {}) {
    const limit = pageLimit(query.limit),
      rows = await this.repository.db.registryConnection.findMany({
        where: after(query.cursor),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
    return page(rows, limit, registryConnectionView);
  }
  async builders(query: { limit?: number; cursor?: string } = {}) {
    const limit = pageLimit(query.limit),
      rows = await this.repository.db.builder.findMany({
        where: after(query.cursor),
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
    return page(rows, limit, builderView);
  }
  async getGithub(id: string) {
    return githubConnectionView(
      expect(
        await this.repository.db.gitHubConnection.findUnique({ where: { id: resourceId(id) } }),
      ),
    );
  }
  async getRegistry(id: string) {
    return registryConnectionView(
      expect(
        await this.repository.db.registryConnection.findUnique({ where: { id: resourceId(id) } }),
      ),
    );
  }
  async getBuilder(id: string) {
    return builderView(
      expect(await this.repository.db.builder.findUnique({ where: { id: resourceId(id) } })),
    );
  }
  createGithub(input: GitHubConnectionInput) {
    record(input, ['name', 'credentialRefId'], 'GitHub 连接');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await integrationCredential(tx, this.cipher, resourceId(input.credentialRefId), 'git');
      return githubConnectionView(
        await tx.gitHubConnection.create({
          data: {
            name: text(input.name, 120, '连接名称').trim(),
            credentialRefId: input.credentialRefId,
          },
        }),
      );
    });
  }
  updateGithub(id: string, input: Partial<GitHubConnectionInput> & { revision: number }) {
    resourceId(id);
    record(input, ['revision', 'name', 'credentialRefId'], 'GitHub 连接修改');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "GitHubConnection" WHERE "id"=${id}::uuid FOR UPDATE`;
      const current = expect(await tx.gitHubConnection.findUnique({ where: { id } }));
      revision(current, input.revision);
      if (input.credentialRefId)
        await integrationCredential(tx, this.cipher, resourceId(input.credentialRefId), 'git');
      return githubConnectionView(
        await tx.gitHubConnection.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: text(input.name, 120, '连接名称').trim() } : {}),
            ...(input.credentialRefId !== undefined
              ? {
                  credentialRefId: input.credentialRefId,
                  verificationState: 'unverified',
                  verifiedCredentialRefId: null,
                  verifiedAt: null,
                  lastErrorCode: null,
                }
              : {}),
            revision: { increment: 1 },
          },
        }),
      );
    });
  }
  async verifyGithub(id: string, expectedRevision: number) {
    resourceId(id);
    const captured = await withWritableControlPlane(this.repository.db, async (tx) => {
      const credential = await currentGitCredential(tx, this.cipher, id, 'github_verify');
      revision(credential.connection, expectedRevision);
      return credential;
    });
    let account: { id: string; login: string } | null = null,
      errorCode: string | null = null;
    try {
      account = await this.github.account(captured.token);
      await this.github.repositories(captured.token, 1);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      errorCode = error.code;
    }
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const current = expect(await tx.gitHubConnection.findUnique({ where: { id } }));
      revision(current, expectedRevision);
      return githubConnectionView(
        await tx.gitHubConnection.update({
          where: { id },
          data: {
            verificationState: errorCode ? 'failed' : 'verified',
            verifiedAt: new Date(),
            verifiedCredentialRefId: errorCode ? null : captured.credentialRefId,
            accountId: account?.id,
            accountLogin: account?.login,
            lastErrorCode: errorCode,
            verificationJson: {
              accountRead: account !== null,
              repositoryListRead: errorCode === null,
            },
          },
        }),
      );
    });
  }
  async repositories(id: string, cursor?: string) {
    resourceId(id);
    const number = cursor === undefined ? 1 : Number(cursor);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 1000 ||
      (cursor !== undefined && String(number) !== cursor)
    )
      throw new OperationRequestError(422, 'INVALID_CURSOR', 'GitHub 分页游标无效。');
    const captured = await withWritableControlPlane(this.repository.db, (tx) =>
      currentGitCredential(tx, this.cipher, id, 'github_repositories'),
    );
    const response = await this.github.repositories(captured.token, number);
    const rows = await withWritableControlPlane(this.repository.db, async (tx) => {
      const current = expect(await tx.gitHubConnection.findUnique({ where: { id } }));
      if (current.credentialRefId !== captured.credentialRefId)
        throw new OperationRequestError(
          409,
          'GITHUB_CREDENTIAL_CHANGED',
          'GitHub 凭证已变化，请重新读取授权仓库。',
        );
      const result = [];
      for (const repo of response.data)
        result.push(
          await tx.gitRepository.upsert({
            where: {
              githubConnectionId_githubRepositoryId: {
                githubConnectionId: id,
                githubRepositoryId: repo.id,
              },
            },
            create: {
              githubConnectionId: id,
              githubRepositoryId: repo.id,
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              private: repo.private,
              lastVerifiedAt: new Date(),
            },
            update: {
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              private: repo.private,
              lastVerifiedAt: new Date(),
            },
          }),
        );
      return result;
    });
    return {
      data: rows.map((row) => gitRepositoryView(row, this.appOrigin)),
      page: {
        hasMore: response.nextPage !== null,
        nextCursor: response.nextPage?.toString() ?? null,
      },
    };
  }
  async branches(id: string, repositoryId: string, cursor?: string) {
    resourceId(id);
    resourceId(repositoryId);
    const number = cursor === undefined ? 1 : Number(cursor);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > 1000 ||
      (cursor !== undefined && String(number) !== cursor)
    )
      throw new OperationRequestError(422, 'INVALID_CURSOR', 'GitHub 分页游标无效。');
    const captured = await withWritableControlPlane(this.repository.db, async (tx) => {
      const repo = expect(await tx.gitRepository.findUnique({ where: { id: repositoryId } }));
      if (repo.githubConnectionId !== id)
        throw new OperationRequestError(
          422,
          'GITHUB_REPOSITORY_MISMATCH',
          '仓库不属于此 GitHub 连接。',
        );
      return {
        repository: repo,
        ...(await currentGitCredential(tx, this.cipher, id, 'github_branches')),
      };
    });
    const response = await this.github.branches(
      captured.token,
      captured.repository.githubRepositoryId,
      number,
    );
    return {
      data: response.data,
      page: {
        hasMore: response.nextPage !== null,
        nextCursor: response.nextPage?.toString() ?? null,
      },
    };
  }
  private async registryCredentials(
    tx: Prisma.TransactionClient,
    authority: string,
    pushId: string,
    pullId: string,
  ) {
    if (pushId === pullId)
      throw new OperationRequestError(
        422,
        'REGISTRY_CREDENTIALS_NOT_SEPARATE',
        '推送与运行期拉取须使用独立凭证。',
      );
    const push = await integrationCredential(tx, this.cipher, resourceId(pushId), 'registry'),
      pull = await integrationCredential(tx, this.cipher, resourceId(pullId), 'registry');
    if (
      parseRegistryAccess(push.payload).registry !== authority ||
      parseRegistryAccess(pull.payload).registry !== authority
    )
      throw new OperationRequestError(
        422,
        'REGISTRY_ACCESS_MISMATCH',
        '推送和拉取凭证都须属于登记的仓库。',
      );
    if (
      push.payload.username === pull.payload.username &&
      push.payload.password === pull.payload.password
    )
      throw new OperationRequestError(
        422,
        'REGISTRY_CREDENTIALS_NOT_SEPARATE',
        '两个引用不能包含相同的认证内容。',
      );
    if (typeof push.payload.username !== 'string' || typeof pull.payload.username !== 'string')
      throw new OperationRequestError(
        422,
        'REGISTRY_AUTH_REQUIRED',
        'S6 镜像仓库需要独立可验证的推送与拉取身份。',
      );
  }
  createRegistry(input: RegistryConnectionInput) {
    record(
      input,
      ['name', 'authority', 'namespace', 'pushCredentialRefId', 'pullCredentialRefId'],
      '镜像仓库连接',
    );
    const authority = text(input.authority, 253, '仓库地址'),
      namespace = text(input.namespace, 255, '仓库命名空间');
    const parsed = parseImageReference(`${authority}/${namespace}/ozz-probe:validation`);
    if (parsed.registry !== authority || parsed.repository !== `${namespace}/ozz-probe`)
      throw new OperationRequestError(
        422,
        'REGISTRY_DESTINATION_INVALID',
        '请输入规范的固定仓库地址与命名空间。',
      );
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await this.registryCredentials(
        tx,
        authority,
        input.pushCredentialRefId,
        input.pullCredentialRefId,
      );
      return registryConnectionView(
        await tx.registryConnection.create({
          data: {
            name: text(input.name, 120, '连接名称').trim(),
            authority,
            namespace,
            pushCredentialRefId: input.pushCredentialRefId,
            pullCredentialRefId: input.pullCredentialRefId,
          },
        }),
      );
    });
  }
  updateRegistry(
    id: string,
    input: {
      revision: number;
      name?: string;
      pushCredentialRefId?: string;
      pullCredentialRefId?: string;
    },
  ) {
    resourceId(id);
    record(
      input,
      ['revision', 'name', 'pushCredentialRefId', 'pullCredentialRefId'],
      '镜像仓库修改',
    );
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RegistryConnection" WHERE "id"=${id}::uuid FOR UPDATE`;
      const row = expect(await tx.registryConnection.findUnique({ where: { id } }));
      revision(row, input.revision);
      await this.registryCredentials(
        tx,
        row.authority,
        input.pushCredentialRefId ?? row.pushCredentialRefId,
        input.pullCredentialRefId ?? row.pullCredentialRefId,
      );
      return registryConnectionView(
        await tx.registryConnection.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: text(input.name, 120, '连接名称').trim() } : {}),
            ...(input.pushCredentialRefId !== undefined
              ? {
                  pushCredentialRefId: input.pushCredentialRefId,
                  pushVerificationState: 'unverified',
                  pushVerifiedAt: null,
                  pushErrorCode: null,
                  pushVerificationJson: Prisma.DbNull,
                }
              : {}),
            ...(input.pullCredentialRefId !== undefined
              ? {
                  pullCredentialRefId: input.pullCredentialRefId,
                  pullVerificationState: 'unverified',
                  pullVerifiedAt: null,
                  pullErrorCode: null,
                  pullVerificationJson: Prisma.DbNull,
                }
              : {}),
            revision: { increment: 1 },
          },
        }),
      );
    });
  }
  createBuilder(input: BuilderInput) {
    record(
      input,
      ['name', 'instanceId', 'identityPublicKey', 'endpoint', 'credentialRefId', 'profile'],
      'Builder',
    );
    const instanceId = resourceId(input.instanceId),
      endpoint = safeEndpoint(input.endpoint);
    try {
      if (createPublicKey(input.identityPublicKey).asymmetricKeyType !== 'ed25519')
        throw new Error();
    } catch {
      throw new OperationRequestError(
        422,
        'BUILDER_IDENTITY_INVALID',
        'Builder 签名身份须为独立 Ed25519 公钥。',
      );
    }
    const profile = parseProfile({
      ...record(input.profile, ['buildkitVersion', 'frontendDigest'], 'Builder 配置'),
      instanceId,
      profileRevision: 1,
    });
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await integrationCredential(tx, this.cipher, resourceId(input.credentialRefId), 'builder');
      return builderView(
        await tx.builder.create({
          data: {
            name: text(input.name, 120, 'Builder 名称').trim(),
            instanceId,
            identityPublicKey: text(input.identityPublicKey, 2048, 'Builder 公钥'),
            endpoint,
            credentialRefId: input.credentialRefId,
            profileJson: json(profile),
          },
        }),
      );
    });
  }
  updateBuilder(
    id: string,
    input: {
      revision: number;
      name?: string;
      endpoint?: string;
      credentialRefId?: string;
      enabled?: boolean;
      profile?: BuilderInput['profile'];
    },
  ) {
    resourceId(id);
    record(
      input,
      ['revision', 'name', 'endpoint', 'credentialRefId', 'enabled', 'profile'],
      'Builder 修改',
    );
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean')
      throw new OperationRequestError(422, 'BUILDER_INPUT_INVALID', '启用选项须为布尔值。');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Builder" WHERE "id"=${id}::uuid FOR UPDATE`;
      const row = expect(await tx.builder.findUnique({ where: { id } }));
      revision(row, input.revision);
      if (input.credentialRefId)
        await integrationCredential(tx, this.cipher, resourceId(input.credentialRefId), 'builder');
      const profile = input.profile
        ? parseProfile({
            ...record(input.profile, ['buildkitVersion', 'frontendDigest'], 'Builder 配置'),
            instanceId: row.instanceId,
            profileRevision: row.profileRevision + 1,
          })
        : null;
      return builderView(
        await tx.builder.update({
          where: { id },
          data: {
            ...(input.name !== undefined
              ? { name: text(input.name, 120, 'Builder 名称').trim() }
              : {}),
            ...(input.endpoint !== undefined ? { endpoint: safeEndpoint(input.endpoint) } : {}),
            ...(input.credentialRefId !== undefined
              ? { credentialRefId: input.credentialRefId }
              : {}),
            ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
            ...(profile
              ? { profileRevision: profile.profileRevision, profileJson: json(profile) }
              : {}),
            ...(input.endpoint || input.credentialRefId || profile
              ? {
                  verificationState: 'unverified',
                  verifiedAt: null,
                  capabilitiesJson: Prisma.DbNull,
                  lastErrorCode: null,
                }
              : {}),
            revision: { increment: 1 },
          },
        }),
      );
    });
  }
  async verifyBuilder(id: string, expectedRevision: number) {
    resourceId(id);
    const captured = await withWritableControlPlane(this.repository.db, async (tx) => {
      const builder = expect(await tx.builder.findUnique({ where: { id } }));
      revision(builder, expectedRevision);
      const credential = await integrationCredential(
        tx,
        this.cipher,
        builder.credentialRefId,
        'builder',
      );
      await auditCredentialUse(tx, 'builder_verify', id, credential.id);
      const state = await tx.controlPlaneState.findUniqueOrThrow({
        where: { id: 'control-plane' },
      });
      return {
        builder,
        credential: parseBuilderCredential(credential.payload),
        generation: state.generation,
      };
    });
    const challenge = randomBytes(32).toString('base64url');
    let capabilities: (BuilderIdentity & { controlPlaneGenerationAtCheck: number }) | null = null,
      errorCode: string | null = null;
    try {
      const client = new HttpBuilderClient(
        new HttpsBuilderTransport({ origin: captured.builder.endpoint, ...captured.credential }),
      );
      const signed = await client.identity(challenge),
        actual = verifySigned(signed, captured.builder.identityPublicKey);
      const profile = parseProfile(captured.builder.profileJson);
      if (
        actual.challenge !== challenge ||
        actual.instanceId !== captured.builder.instanceId ||
        actual.profile.instanceId !== captured.builder.instanceId ||
        actual.profile.profileRevision !== profile.profileRevision ||
        actual.profile.buildkitVersion !== profile.buildkitVersion ||
        actual.profile.frontendDigest !== profile.frontendDigest ||
        Math.abs(Date.now() - Date.parse(actual.checkedAt)) > 60_000
      )
        throw new BuilderError('BUILD_IDENTITY_MISMATCH');
      capabilities = { ...actual, controlPlaneGenerationAtCheck: captured.generation };
      if (actual.highGeneration !== captured.generation) errorCode = 'BUILDER_GENERATION_MISMATCH';
    } catch (error) {
      if (!(error instanceof BuilderError)) throw error;
      errorCode = error.code;
    }
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const current = expect(await tx.builder.findUnique({ where: { id } }));
      revision(current, expectedRevision);
      const state = await tx.controlPlaneState.findUniqueOrThrow({
        where: { id: 'control-plane' },
      });
      if (capabilities) {
        capabilities.controlPlaneGenerationAtCheck = state.generation;
        if (capabilities.highGeneration !== state.generation)
          errorCode = 'BUILDER_GENERATION_MISMATCH';
      }
      return builderView(
        await tx.builder.update({
          where: { id },
          data: {
            verificationState: errorCode ? 'failed' : 'verified',
            verifiedAt: new Date(),
            capabilitiesJson: capabilities ? json(capabilities) : Prisma.DbNull,
            lastErrorCode: errorCode,
            lastObservedAt: new Date(),
          },
        }),
      );
    });
  }
  registerWebhook(
    githubConnectionId: string,
    repositoryId: string,
    input: { revision: number; secretRefId: string },
    actor: OperationActor,
    key: unknown,
  ) {
    resourceId(githubConnectionId);
    resourceId(repositoryId);
    resourceId(input.secretRefId);
    record(input, ['revision', 'secretRefId'], 'Webhook 注册');
    return this.repository.enqueue(
      actor,
      key,
      { kind: 'github_webhook_register', request: { githubConnectionId, repositoryId, ...input } },
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "GitRepository" WHERE "id"=${repositoryId}::uuid FOR UPDATE`;
        const repo = expect(await tx.gitRepository.findUnique({ where: { id: repositoryId } }));
        revision(repo, input.revision);
        if (repo.githubConnectionId !== githubConnectionId)
          throw new OperationRequestError(422, 'GITHUB_REPOSITORY_MISMATCH', '仓库不属于此连接。');
        if (
          repo.hookOperationId &&
          (await tx.operation.count({
            where: { id: repo.hookOperationId, status: { in: ['queued', 'running'] } },
          }))
        )
          throw new OperationRequestError(
            409,
            'RESOURCE_OPERATION_ACTIVE',
            'Webhook 注册任务仍在进行。',
          );
        if (repo.candidateHookSecretRefId && repo.candidateHookSecretRefId !== input.secretRefId)
          throw new OperationRequestError(
            409,
            'WEBHOOK_ROTATION_UNRESOLVED',
            '前次注册结果尚待核对，请使用同一候选秘密完成注册。',
          );
        await integrationCredential(tx, this.cipher, input.secretRefId, 'webhook');
        const callbackId = repo.hookCallbackId ?? randomUUID(),
          callbackUrl = `${this.appOrigin}/api/webhooks/github/${repositoryId}/${callbackId}`;
        if (new URL(callbackUrl).protocol !== 'https:')
          throw new OperationRequestError(
            422,
            'WEBHOOK_HTTPS_REQUIRED',
            '注册 GitHub Webhook 需要可用的 HTTPS 控制面地址。',
          );
        return {
          input: {
            integrationId: repositoryId,
            revision: input.revision,
            action: 'register_webhook' as const,
            hookSecretRefId: input.secretRefId,
            callbackUrl,
          },
          onAccepted: async (db, ref) => {
            await db.gitRepository.update({
              where: { id: repositoryId },
              data: {
                hookCallbackId: callbackId,
                candidateHookSecretRefId: input.secretRefId,
                candidateHookSecretUntil: new Date(Date.now() + 30 * 60_000),
                hookState: 'registering',
                hookOperationId: ref.id,
                hookErrorCode: null,
              },
            });
          },
        };
      },
    );
  }
  verifyRegistry(id: string, expectedRevision: number, actor: OperationActor, key: unknown) {
    resourceId(id);
    integer(expectedRevision, 1, 2147483647, '版本');
    return this.repository.enqueue(
      actor,
      key,
      { kind: 'registry_validate', request: { id, revision: expectedRevision } },
      async (tx, context) => {
        const connection = expect(await tx.registryConnection.findUnique({ where: { id } }));
        revision(connection, expectedRevision);
        return {
          input: {
            integrationId: id,
            revision: expectedRevision,
            action: 'validate_registry' as const,
            probeRepository: `${connection.namespace}/ozz-probe-${context.id}`,
          },
        };
      },
    );
  }
}
