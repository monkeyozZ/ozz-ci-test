import { Prisma } from '@ozz/database';
import {
  GitHubAdapter,
  GitHubError,
  gitCommitSha,
  type GitHubClient,
} from '@ozz/infrastructure/github';
import { withWritableControlPlane } from '../recovery.js';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError, type DeploymentTaskRef } from '../tasks/contracts.js';
import { TaskRepository, type OperationActor } from '../tasks/repository.js';
import { ServiceCommands } from '../services/commands.js';
import {
  assertServiceTarget,
  currentTarget,
  json,
  lockService,
  requireIdle,
  requireServiceRevision,
  type ServiceRecord,
} from '../services/persistence.js';
import {
  integer,
  record,
  resourceId,
  validateRuntimeConfiguration,
} from '../services/validation.js';
import { readServiceSnapshot } from '../services/snapshots.js';
import { captureVolumeReferences } from '../storage/persistence.js';
import { captureDatabaseBindings } from '../databases/persistence.js';
import { currentGitCredential } from '../integrations/persistence.js';
import { presentService } from '../services/views.js';
import { serviceInclude } from '../services/persistence.js';
import type { ServiceSnapshotV3, ServiceTarget } from '../services/contracts.js';
import type {
  DeployGitInput,
  GitPreviewInput,
  GitPublicationPreview,
  GitSourceInput,
  GitSourceRevision,
} from './contracts.js';
import { readGitSourceRevision, requireGitSource, saveGitSource } from './persistence.js';

export async function captureGitSnapshot(
  tx: Prisma.TransactionClient,
  service: ServiceRecord,
  revision: GitSourceRevision,
  commitSha: string,
): Promise<ServiceSnapshotV3> {
  const volumes = await captureVolumeReferences(tx, service);
  return {
    version: 3,
    serviceId: service.id,
    serviceName: service.name,
    serviceSlug: service.slug,
    configRevision: service.configRevision,
    configuration: validateRuntimeConfiguration(service.configJson),
    source: { kind: 'github', revision, commitSha: gitCommitSha(commitSha) },
    deployAndStart: false,
    allowConfigurationRepair: false,
    controller: {
      kind: 'Deployment',
      strategy: volumes.some((volume) => !volume.readOnly) ? 'Recreate' : 'RollingUpdate',
    },
    volumes,
    database: null,
    databaseBindings: await captureDatabaseBindings(tx, service),
    template: null,
  };
}
function flag(value: unknown): boolean {
  if (value !== undefined && typeof value !== 'boolean')
    throw new OperationRequestError(422, 'GIT_CONFIRMATION_INVALID', '发布确认须为布尔值。');
  return value === true;
}

/** Preview is durable: admission only consumes the reviewed SHA/snapshot and CAS. */
export class GitCommands {
  readonly services: ServiceCommands;
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly github: GitHubClient = new GitHubAdapter(),
    services?: ServiceCommands,
  ) {
    this.services = services ?? new ServiceCommands(repository, cipher);
  }
  async updateSource(id: string, input: { revision: number; source: GitSourceInput }) {
    resourceId(id);
    record(input, ['revision', 'source'], 'Git 来源修改');
    integer(input.revision, 1, 2147483647, '服务版本');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, id);
      requireServiceRevision(service, input.revision);
      requireGitSource(service);
      await saveGitSource(tx, this.cipher, id, input.source);
      await tx.service.update({ where: { id }, data: { revision: { increment: 1 } } });
      await tx.webhookTarget.updateMany({
        where: { currentServiceId: id, state: 'waiting' },
        data: { state: 'pending', reason: 'source_changed', manualRequired: true },
      });
      return presentService(
        await tx.service.findUniqueOrThrow({ where: { id }, include: serviceInclude }),
      );
    });
  }
  async updatePolicy(
    id: string,
    input: { revision: number; policyRevision: number; autoDeploy: boolean },
  ) {
    resourceId(id);
    record(input, ['revision', 'policyRevision', 'autoDeploy'], '自动发布策略');
    integer(input.revision, 1, 2147483647, '服务版本');
    integer(input.policyRevision, 1, 2147483647, '策略版本');
    if (typeof input.autoDeploy !== 'boolean')
      throw new OperationRequestError(422, 'GIT_POLICY_INVALID', '自动发布策略须为布尔值。');
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, id);
      requireServiceRevision(service, input.revision);
      const { source } = requireGitSource(service);
      if (source.policyRevision !== input.policyRevision)
        throw new OperationRequestError(409, 'REVISION_CONFLICT', '自动发布策略已变化。');
      await tx.gitSource.update({
        where: { id: source.id },
        data: { autoDeploy: input.autoDeploy, policyRevision: { increment: 1 } },
      });
      await tx.service.update({ where: { id }, data: { revision: { increment: 1 } } });
      await tx.webhookTarget.updateMany({
        where: { currentServiceId: id, state: 'waiting' },
        data: { state: 'pending', reason: 'policy_changed', manualRequired: true },
      });
      return presentService(
        await tx.service.findUniqueOrThrow({ where: { id }, include: serviceInclude }),
      );
    });
  }
  async preview(id: string, input: GitPreviewInput): Promise<GitPublicationPreview> {
    resourceId(id);
    record(input, ['revision', 'selection'], 'Git 发布预览');
    integer(input.revision, 1, 2147483647, '服务版本');
    const selection = record(input.selection, ['kind', 'commitSha', 'webhookTargetId'], '提交选择');
    if (!['branch_head', 'commit', 'pending_target'].includes(String(selection.kind)))
      throw new OperationRequestError(
        422,
        'GIT_COMMIT_SELECTION_INVALID',
        '请选择分支 HEAD、完整 commit 或待发布投递。',
      );
    if (
      (selection.kind === 'commit') !== (selection.commitSha !== undefined) ||
      (selection.kind === 'pending_target') !== (selection.webhookTargetId !== undefined)
    )
      throw new OperationRequestError(422, 'GIT_COMMIT_SELECTION_INVALID', '提交选择字段不匹配。');
    const captured = await withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, id);
      requireServiceRevision(service, input.revision);
      const { source, revision: current } = requireGitSource(service);
      let revision = current,
        selectedCommit = selection.kind === 'commit' ? gitCommitSha(selection.commitSha) : null;
      let webhookTargetId: string | null = null;
      let target = await currentTarget(tx, service);
      if (selection.kind === 'pending_target') {
        webhookTargetId = resourceId(selection.webhookTargetId);
        const pending = await tx.webhookTarget.findUnique({
          where: { id: webhookTargetId },
          include: { revision: true },
        });
        if (
          !pending ||
          pending.serviceId !== id ||
          pending.currentServiceId !== id ||
          !['waiting', 'pending'].includes(pending.state) ||
          pending.deploymentId
        )
          throw new OperationRequestError(
            409,
            'WEBHOOK_TARGET_UNAVAILABLE',
            '此待发布投递不可再受理。',
          );
        revision = readGitSourceRevision(pending.revision.snapshotJson);
        selectedCommit = pending.commitSha;
        target = pending.targetJson as unknown as ServiceTarget;
        await assertServiceTarget(tx, service, target);
      }
      const credential = await currentGitCredential(
        tx,
        this.cipher,
        revision.githubConnectionId,
        'publication_preview',
      );
      const issues: GitPublicationPreview['issues'] = [];
      const builder = await tx.builder.findUniqueOrThrow({
        where: { id: revision.builder.builderId },
      });
      const registry = await tx.registryConnection.findUniqueOrThrow({
        where: { id: revision.destination.registryConnectionId },
      });
      if (!builder.enabled || builder.verificationState !== 'verified')
        issues.push({ code: 'BUILDER_NOT_VERIFIED', message: '请先验证并启用原来源的 Builder。' });
      if (
        builder.instanceId !== revision.builder.instanceId ||
        builder.profileRevision !== revision.builder.profileRevision
      )
        issues.push({
          code: 'BUILDER_PROFILE_CHANGED',
          message: '原 Builder 配置版本已变化，请保存新的来源版本。',
        });
      if (
        registry.pushVerificationState !== 'verified' ||
        registry.pullVerificationState !== 'verified'
      )
        issues.push({
          code: 'REGISTRY_NOT_VERIFIED',
          message: '请先完成镜像仓库推送与拉取权限验证。',
        });
      if (service.desiredState === 'stopped')
        issues.push({
          code: 'DEPLOY_AND_START_REQUIRED',
          message: '服务已停止，发布时需要明确选择部署并启动。',
        });
      if (['partial', 'drifted', 'unknown'].includes(service.configurationState))
        issues.push({
          code: 'CONFIGURATION_REPAIR_REQUIRED',
          message: '发布时需要明确确认完整修复当前配置。',
        });
      if (revision.id !== current.id)
        issues.push({
          code: 'REVIEWING_RETAINED_SOURCE',
          message: '此投递保留原来源版本；本次将按该版本和当前运行配置发布。',
        });
      return {
        revision,
        selectedCommit,
        webhookTargetId,
        target,
        token: credential.token,
        configRevision: service.configRevision,
        policyRevision: source.policyRevision,
        desiredState: service.desiredState,
        issues,
      };
    });
    const commit = await this.github.commit(
      captured.token,
      captured.revision.repository.githubRepositoryId,
      captured.selectedCommit ?? captured.revision.branchRef,
    );
    const paths = await Promise.allSettled([
      this.github.path(
        captured.token,
        captured.revision.repository.githubRepositoryId,
        commit.sha,
        captured.revision.dockerfilePath,
        'file',
      ),
      this.github.path(
        captured.token,
        captured.revision.repository.githubRepositoryId,
        commit.sha,
        captured.revision.contextPath,
        'dir',
      ),
    ]);
    for (const [index, result] of paths.entries())
      if (result.status === 'rejected') {
        if (
          !(result.reason instanceof GitHubError) ||
          !['GITHUB_PATH_INVALID', 'GITHUB_NOT_FOUND'].includes(result.reason.code)
        )
          throw result.reason;
        captured.issues.push({
          code: result.reason.code,
          field: index === 0 ? 'dockerfilePath' : 'contextPath',
          message: '固定 commit 中不存在所选 Dockerfile 或构建上下文。',
        });
      }
    return withWritableControlPlane(this.repository.db, async (tx) => {
      const service = await lockService(tx, id);
      requireServiceRevision(service, input.revision);
      await assertServiceTarget(tx, service, captured.target);
      const snapshot = await captureGitSnapshot(tx, service, captured.revision, commit.sha);
      const created = await tx.gitPublicationPreview.create({
        data: {
          serviceId: id,
          serviceRevision: service.revision,
          configRevision: service.configRevision,
          policyRevision: captured.policyRevision,
          sourceRevisionId: captured.revision.id,
          webhookTargetId: captured.webhookTargetId,
          commitSha: commit.sha,
          snapshotJson: json(snapshot),
          targetJson: json(captured.target),
          issuesJson: json(captured.issues),
          expiresAt: new Date(Date.now() + 15 * 60_000),
        },
      });
      // Bound ephemeral previews without touching retained publication identities.
      await tx.gitPublicationPreview.deleteMany({
        where: {
          serviceId: id,
          expiresAt: { lt: new Date(Date.now() - 86_400_000) },
          consumedDeploymentId: null,
        },
      });
      return {
        id: created.id,
        serviceRevision: service.revision,
        configRevision: service.configRevision,
        policyRevision: captured.policyRevision,
        source: snapshot.source,
        target: captured.target,
        configuration: snapshot.configuration,
        snapshot,
        desiredState: service.desiredState,
        webhookTargetId: captured.webhookTargetId,
        issues: captured.issues,
        checkedAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt.toISOString(),
      };
    });
  }
  deploy(id: string, input: DeployGitInput, actor: OperationActor, key: unknown) {
    resourceId(id);
    resourceId(input.previewId);
    integer(input.revision, 1, 2147483647, '服务版本');
    record(
      input,
      ['revision', 'previewId', 'deployAndStart', 'allowConfigurationRepair'],
      'Git 发布',
    );
    const deployAndStart = flag(input.deployAndStart),
      allowConfigurationRepair = flag(input.allowConfigurationRepair);
    return this.repository.enqueueDeployment(
      actor,
      key,
      { kind: 'git_deploy', request: { id, ...input } },
      async (tx) => {
        const service = await lockService(tx, id);
        requireServiceRevision(service, input.revision);
        requireIdle(service);
        requireGitSource(service);
        const preview = await tx.gitPublicationPreview.findUnique({
          where: { id: input.previewId },
        });
        if (
          !preview ||
          preview.serviceId !== id ||
          preview.serviceRevision !== input.revision ||
          preview.configRevision !== service.configRevision ||
          preview.expiresAt <= new Date() ||
          preview.consumedDeploymentId
        )
          throw new OperationRequestError(
            409,
            'GIT_PREVIEW_STALE',
            '发布预览已变化、过期或使用，请重新审阅。',
          );
        const issues = preview.issuesJson as unknown as GitPublicationPreview['issues'];
        if (
          issues.some(
            (issue) =>
              ![
                'DEPLOY_AND_START_REQUIRED',
                'CONFIGURATION_REPAIR_REQUIRED',
                'REVIEWING_RETAINED_SOURCE',
              ].includes(issue.code),
          )
        )
          throw new OperationRequestError(
            409,
            'GIT_PREVIEW_BLOCKED',
            '请解决预览中的来源或集成问题后重新预览。',
          );
        const snapshot = readServiceSnapshot(preview.snapshotJson);
        if (
          snapshot.version !== 3 ||
          snapshot.source.revision.id !== preview.sourceRevisionId ||
          snapshot.source.commitSha !== preview.commitSha
        )
          throw new OperationRequestError(409, 'GIT_PREVIEW_INVALID', '原预览身份不一致。');
        const target = preview.targetJson as unknown as ServiceTarget;
        await assertServiceTarget(tx, service, target);
        let webhookDeliveryId: string | null = null;
        if (preview.webhookTargetId) {
          await tx.$queryRaw`SELECT "id" FROM "WebhookTarget" WHERE "id"=${preview.webhookTargetId}::uuid FOR UPDATE`;
          const pending = await tx.webhookTarget.findUniqueOrThrow({
            where: { id: preview.webhookTargetId },
          });
          if (
            pending.currentServiceId !== id ||
            pending.deploymentId ||
            !['waiting', 'pending'].includes(pending.state) ||
            pending.sourceRevisionId !== preview.sourceRevisionId ||
            pending.commitSha !== preview.commitSha
          )
            throw new OperationRequestError(
              409,
              'WEBHOOK_TARGET_UNAVAILABLE',
              '此待发布投递已变化或受理。',
            );
          webhookDeliveryId = pending.webhookDeliveryId;
        }
        const prepared = await this.services.prepareDeployment(tx, service, target, {
          ...snapshot,
          deployAndStart,
          allowConfigurationRepair,
        });
        if (preview.webhookTargetId && webhookDeliveryId) {
          prepared.webhookTargetId = preview.webhookTargetId;
          prepared.webhookDeliveryId = webhookDeliveryId;
        }
        const onAccepted = prepared.onAccepted;
        prepared.onAccepted = async (db, ref: DeploymentTaskRef) => {
          await onAccepted?.(db, ref);
          await db.gitPublicationPreview.update({
            where: { id: preview.id },
            data: { consumedDeploymentId: ref.id },
          });
          if (preview.webhookTargetId)
            await db.webhookTarget.update({
              where: { id: preview.webhookTargetId },
              data: {
                state: 'enqueued',
                reason: 'manual_publication',
                deploymentId: ref.id,
                admittedAt: new Date(),
              },
            });
        };
        return prepared;
      },
    );
  }
}
