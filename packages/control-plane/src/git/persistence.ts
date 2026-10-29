import { randomUUID } from 'node:crypto';
import type { Prisma } from '@ozz/database';
import { gitBranchRef, gitRelativePath } from '@ozz/infrastructure/github';
import { hashJson, parseProfile } from '@ozz/infrastructure/build';
import { parseImageReference } from '@ozz/infrastructure/registry';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError } from '../tasks/contracts.js';
import { json, type ServiceRecord } from '../services/persistence.js';
import { record, resourceId, text } from '../services/validation.js';
import type { GitSourceInput, GitSourceRevision } from './contracts.js';

export function readGitSourceRevision(value: unknown): GitSourceRevision {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new OperationRequestError(409, 'GIT_SOURCE_SNAPSHOT_INVALID', '固定 Git 来源版本无效。');
  const row = value as GitSourceRevision;
  if (
    row.version !== 1 ||
    row.provider !== 'github' ||
    !row.repository ||
    !row.builder ||
    !row.destination ||
    !Array.isArray(row.platforms) ||
    !Array.isArray(row.buildSecrets) ||
    !/^[0-9a-f]{64}$/.test(row.recipeHash)
  )
    throw new OperationRequestError(409, 'GIT_SOURCE_SNAPSHOT_INVALID', '固定 Git 来源版本无效。');
  resourceId(row.id);
  resourceId(row.sourceId);
  resourceId(row.repository.repositoryId);
  gitBranchRef(row.branchRef);
  gitRelativePath(row.dockerfilePath);
  gitRelativePath(row.contextPath, true);
  return row;
}

export function validateGitSourceInput(value: unknown): GitSourceInput {
  const raw = record(
    value,
    [
      'kind',
      'repositoryId',
      'branchRef',
      'dockerfilePath',
      'contextPath',
      'buildArgs',
      'buildSecrets',
      'platforms',
      'builderId',
      'registryConnectionId',
      'imageRepository',
      'autoDeploy',
    ],
    'Git 来源',
  );
  if (raw.kind !== 'github')
    throw new OperationRequestError(422, 'SERVICE_SOURCE_INVALID', 'Git 来源类型必须为 github。');
  const args = raw.buildArgs === undefined ? {} : raw.buildArgs;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length > 64)
    throw new OperationRequestError(422, 'BUILD_ARGUMENTS_INVALID', '构建参数最多 64 项。');
  const buildArgs: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) ||
      /^(?:BUILDKIT_|BUILDX_)/.test(key) ||
      ['__proto__', 'prototype', 'constructor'].includes(key)
    )
      throw new OperationRequestError(422, 'BUILD_ARGUMENTS_INVALID', '构建参数名称无效。');
    buildArgs[key] = text(value, 4096, '构建参数值', true);
  }
  if (Buffer.byteLength(JSON.stringify(buildArgs)) > 16384)
    throw new OperationRequestError(422, 'BUILD_ARGUMENTS_INVALID', '构建参数总量最多 16 KiB。');
  const secrets = raw.buildSecrets ?? [];
  if (!Array.isArray(secrets) || secrets.length > 32)
    throw new OperationRequestError(422, 'BUILD_SECRETS_INVALID', '显式构建秘密最多 32 项。');
  const ids = new Set<string>();
  const buildSecrets = secrets.map((value) => {
    const item = record(value, ['mountId', 'secretRefId', 'secretKey'], '构建秘密');
    const mountId = text(item.mountId, 64, '构建秘密挂载 ID');
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(mountId) || ids.has(mountId))
      throw new OperationRequestError(422, 'BUILD_SECRETS_INVALID', '构建秘密挂载 ID 须唯一。');
    ids.add(mountId);
    return {
      mountId,
      secretRefId: resourceId(item.secretRefId),
      secretKey: text(item.secretKey ?? 'value', 128, '秘密字段'),
    };
  });
  if (!Array.isArray(raw.platforms) || raw.platforms.length < 1 || raw.platforms.length > 2)
    throw new OperationRequestError(
      422,
      'BUILD_PLATFORM_INVALID',
      '请明确选择 Linux amd64 或 arm64 构建平台。',
    );
  const platforms = raw.platforms.map((value) => {
    const item = record(value, ['os', 'architecture', 'variant'], '构建平台');
    if (
      item.os !== 'linux' ||
      (item.architecture !== 'amd64' && item.architecture !== 'arm64') ||
      (item.variant !== undefined && item.variant !== (item.architecture === 'amd64' ? 'v1' : 'v8'))
    )
      throw new OperationRequestError(
        422,
        'BUILD_PLATFORM_INVALID',
        '仅支持明确的 Linux amd64/arm64 基线平台。',
      );
    return {
      os: 'linux' as const,
      architecture: item.architecture as 'amd64' | 'arm64',
      ...(item.variant ? { variant: item.variant as string } : {}),
    };
  });
  if (new Set(platforms.map((platform) => platform.architecture)).size !== platforms.length)
    throw new OperationRequestError(422, 'BUILD_PLATFORM_INVALID', '构建平台不能重复。');
  if (raw.autoDeploy !== undefined && typeof raw.autoDeploy !== 'boolean')
    throw new OperationRequestError(422, 'GIT_POLICY_INVALID', '自动发布选项须为布尔值。');
  const imageRepository = text(raw.imageRepository, 255, '目标镜像名称');
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(imageRepository))
    throw new OperationRequestError(
      422,
      'REGISTRY_REPOSITORY_INVALID',
      '目标镜像名称须为规范的小写仓库路径。',
    );
  return {
    kind: 'github',
    repositoryId: resourceId(raw.repositoryId),
    branchRef: gitBranchRef(raw.branchRef),
    dockerfilePath: gitRelativePath(raw.dockerfilePath),
    contextPath: gitRelativePath(raw.contextPath, true),
    buildArgs,
    buildSecrets,
    platforms,
    builderId: resourceId(raw.builderId),
    registryConnectionId: resourceId(raw.registryConnectionId),
    imageRepository,
    ...(raw.autoDeploy !== undefined ? { autoDeploy: raw.autoDeploy === true } : {}),
  };
}

/** Called under the Service lock; source, fixed secret versions and pointer commit together. */
export async function saveGitSource(
  tx: Prisma.TransactionClient,
  cipher: SecretCipher,
  serviceId: string,
  value: unknown,
): Promise<GitSourceRevision> {
  const input = validateGitSourceInput(value);
  const repository = await tx.gitRepository.findUnique({ where: { id: input.repositoryId } });
  const builder = await tx.builder.findUnique({ where: { id: input.builderId } });
  const registry = await tx.registryConnection.findUnique({
    where: { id: input.registryConnectionId },
  });
  if (!repository || !builder || !registry)
    throw new OperationRequestError(
      422,
      'GIT_INTEGRATION_REQUIRED',
      '请选择已登记的授权仓库、Builder 和镜像仓库。',
    );
  const profile = parseProfile(builder.profileJson);
  if (
    profile.instanceId !== builder.instanceId ||
    profile.profileRevision !== builder.profileRevision
  )
    throw new OperationRequestError(
      409,
      'BUILDER_PROFILE_CHANGED',
      'Builder 固定配置不一致，请重新验证连接。',
    );
  const destinationRepository = `${registry.namespace}/${input.imageRepository}`;
  const image = parseImageReference(
    `${registry.authority}/${destinationRepository}:ozz-validation`,
  );
  if (image.registry !== registry.authority || image.repository !== destinationRepository)
    throw new OperationRequestError(
      422,
      'REGISTRY_REPOSITORY_INVALID',
      '目标镜像仓库不属于登记的命名空间。',
    );
  const buildSecrets: GitSourceRevision['buildSecrets'] = [];
  for (const secret of input.buildSecrets ?? []) {
    await tx.$queryRaw`SELECT "id" FROM "SecretReference" WHERE "id"=${secret.secretRefId}::uuid FOR SHARE`;
    const row = await tx.secretReference.findUnique({ where: { id: secret.secretRefId } });
    if (!row || row.kind !== 'generic' || (row.expiresAt && row.expiresAt <= new Date()))
      throw new OperationRequestError(
        422,
        'BUILD_SECRET_INVALID',
        '构建秘密须显式引用未过期的通用秘密。',
      );
    const key = secret.secretKey ?? 'value',
      plaintext = cipher.decrypt(row)[key];
    if (
      typeof plaintext !== 'string' ||
      plaintext.includes('\0') ||
      Buffer.byteLength(plaintext) > 16384
    )
      throw new OperationRequestError(
        422,
        'BUILD_SECRET_INVALID',
        '构建秘密字段须为最多 16 KiB 的文本。',
      );
    buildSecrets.push({
      mountId: secret.mountId,
      secretRefId: row.id,
      secretKey: key,
      contentRevision: row.contentRevision,
    });
  }
  let source = await tx.gitSource.findUnique({
    where: { serviceId },
    include: { currentRevision: true },
  });
  if (!source)
    source = await tx.gitSource.create({
      data: { serviceId, originalServiceId: serviceId },
      include: { currentRevision: true },
    });
  const revision = (source.currentRevision?.revision ?? 0) + 1;
  const content = {
    provider: 'github' as const,
    githubConnectionId: repository.githubConnectionId,
    repository: {
      repositoryId: repository.id,
      githubRepositoryId: repository.githubRepositoryId,
      fullNameAtCapture: repository.fullName,
    },
    branchRef: input.branchRef,
    dockerfilePath: input.dockerfilePath,
    contextPath: input.contextPath,
    buildArgs: input.buildArgs ?? {},
    buildSecrets,
    platforms: input.platforms,
    builder: { builderId: builder.id, ...profile },
    destination: {
      registryConnectionId: registry.id,
      authority: registry.authority,
      repository: destinationRepository,
    },
  };
  const result: GitSourceRevision = {
    version: 1,
    id: randomUUID(),
    sourceId: source.id,
    revision,
    ...content,
    recipeHash: hashJson(content),
    createdAt: new Date().toISOString(),
  };
  await tx.gitSourceRevision.create({
    data: {
      id: result.id,
      sourceId: source.id,
      revision,
      githubConnectionId: repository.githubConnectionId,
      repositoryId: repository.id,
      builderId: builder.id,
      registryConnectionId: registry.id,
      branchRef: input.branchRef,
      recipeHash: result.recipeHash,
      snapshotJson: json(result),
      createdAt: new Date(result.createdAt),
    },
  });
  if (buildSecrets.length)
    await tx.gitSourceSecretReference.createMany({
      data: buildSecrets.map((secret) => ({ sourceRevisionId: result.id, ...secret })),
    });
  await tx.gitSource.update({
    where: { id: source.id },
    data: {
      currentRevisionId: result.id,
      autoDeploy: input.autoDeploy ?? source.autoDeploy,
      ...(input.autoDeploy !== undefined && input.autoDeploy !== source.autoDeploy
        ? { policyRevision: { increment: 1 } }
        : {}),
    },
  });
  return result;
}

export function requireGitSource(service: ServiceRecord) {
  if (
    service.sourceKind !== 'github' ||
    !service.gitSource?.currentRevision ||
    service.database ||
    service.kind !== 'application'
  )
    throw new OperationRequestError(409, 'GIT_SOURCE_REQUIRED', '此服务没有可用的 Git 应用来源。');
  return {
    source: service.gitSource,
    revision: readGitSourceRevision(service.gitSource.currentRevision.snapshotJson),
  };
}
