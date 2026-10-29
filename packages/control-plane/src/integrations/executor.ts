import type { Prisma } from '@ozz/database';
import { GitHubAdapter, GitHubError, type GitHubClient } from '@ozz/infrastructure/github';
import {
  RegistryProbe,
  RegistryAdapterError,
  type RegistryPermissionProbe,
} from '@ozz/infrastructure/registry';
import { SecretCipher } from '../secrets.js';
import { OperationRequestError, TaskExecutionError } from '../tasks/contracts.js';
import { TaskRepository, type TaskLease, type TaskOutcome } from '../tasks/repository.js';
import {
  auditCredentialUse,
  currentGitCredential,
  currentRegistryCredential,
  integrationCredential,
  parseWebhookSecret,
} from './persistence.js';
import { json } from '../services/persistence.js';
import type { IntegrationOperationInput } from './contracts.js';

export function isIntegrationOperation(kind: string): boolean {
  return kind === 'github_webhook_register' || kind === 'registry_validate';
}
function interrupted(): never {
  throw new TaskExecutionError('EXECUTION_INTERRUPTED', '任务执行租约已失效。', true);
}

export class IntegrationExecutor {
  constructor(
    readonly repository: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly github: GitHubClient = new GitHubAdapter(),
    private readonly registry: RegistryPermissionProbe = new RegistryProbe(),
  ) {}
  async execute(lease: TaskLease, signal: AbortSignal): Promise<TaskOutcome> {
    try {
      const input = lease.input as IntegrationOperationInput;
      if (signal.aborted) interrupted();
      if (lease.kind === 'github_webhook_register')
        return await this.registerHook(lease, input, signal);
      if (lease.kind === 'registry_validate')
        return await this.verifyRegistry(lease, input, signal);
      throw new TaskExecutionError('UNSUPPORTED_OPERATION', '此任务不是受支持的集成操作。');
    } catch (error) {
      if (error instanceof TaskExecutionError) throw error;
      if (error instanceof GitHubError || error instanceof RegistryAdapterError)
        throw new TaskExecutionError(
          error.code,
          error instanceof GitHubError
            ? 'GitHub 注册或授权检查失败，请核对当前连接。'
            : error.message,
          error.retryable,
        );
      if (error instanceof OperationRequestError)
        throw new TaskExecutionError(error.code, error.message);
      throw new TaskExecutionError(
        'INTEGRATION_INTERRUPTED',
        '集成操作中断，请核对已保存的远端操作身份后重试。',
        true,
      );
    }
  }
  private async registerHook(
    lease: TaskLease,
    input: IntegrationOperationInput,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    let captured:
      | {
          token: string;
          githubRepositoryId: string;
          hookId?: string;
          callbackId: string;
          secret: string;
        }
      | undefined;
    const valid = await this.repository.checkpoint(lease, async (tx) => {
      const repo = await tx.gitRepository.findUnique({ where: { id: input.integrationId } });
      if (
        !repo ||
        repo.revision !== input.revision ||
        repo.hookOperationId !== lease.operationId ||
        !repo.hookCallbackId ||
        repo.candidateHookSecretRefId !== input.hookSecretRefId
      )
        throw new OperationRequestError(
          409,
          'WEBHOOK_INTENT_CHANGED',
          '原 Webhook 注册意图已变化。',
        );
      const github = await currentGitCredential(
        tx,
        this.cipher,
        repo.githubConnectionId,
        'webhook_registration',
      );
      const secret = await integrationCredential(
        tx,
        this.cipher,
        input.hookSecretRefId!,
        'webhook',
      );
      await auditCredentialUse(tx, 'webhook_registration_secret', repo.id, secret.id);
      captured = {
        token: github.token,
        githubRepositoryId: repo.githubRepositoryId,
        ...(repo.hookId ? { hookId: repo.hookId } : {}),
        callbackId: repo.hookCallbackId,
        secret: parseWebhookSecret(secret.payload),
      };
      await tx.gitRepository.update({
        where: { id: repo.id },
        data: { candidateHookSecretUntil: new Date(Date.now() + 30 * 60_000) },
      });
    });
    if (!valid || !captured) interrupted();
    const hook = await this.github.registerHook(
      captured.token,
      captured.githubRepositoryId,
      {
        url: input.callbackUrl!,
        secret: captured.secret,
        hookId: captured.hookId,
        registrationId: captured.callbackId,
      },
      signal,
    );
    return {
      result: { repositoryId: input.integrationId, hookId: hook.id, registered: true },
      commit: async (tx) => {
        const repo = await tx.gitRepository.findUniqueOrThrow({
          where: { id: input.integrationId },
        });
        if (
          repo.hookOperationId !== lease.operationId ||
          repo.candidateHookSecretRefId !== input.hookSecretRefId
        )
          throw new OperationRequestError(
            409,
            'WEBHOOK_INTENT_CHANGED',
            '原 Webhook 注册意图已变化。',
          );
        await tx.gitRepository.update({
          where: { id: repo.id },
          data: {
            hookId: hook.id,
            hookState: 'registered',
            hookVerifiedAt: new Date(),
            hookErrorCode: null,
            previousHookSecretRefId: repo.hookSecretRefId,
            previousHookSecretUntil: repo.hookSecretRefId
              ? new Date(Date.now() + 15 * 60_000)
              : null,
            hookSecretRefId: input.hookSecretRefId,
            candidateHookSecretRefId: null,
            candidateHookSecretUntil: null,
          },
        });
      },
    };
  }
  private async verifyRegistry(
    lease: TaskLease,
    input: IntegrationOperationInput,
    signal: AbortSignal,
  ): Promise<TaskOutcome> {
    let captured:
      | {
          push: Awaited<ReturnType<typeof currentRegistryCredential>>;
          pull: Awaited<ReturnType<typeof currentRegistryCredential>>;
        }
      | undefined;
    const valid = await this.repository.checkpoint(lease, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "RegistryConnection" WHERE "id"=${input.integrationId}::uuid FOR UPDATE`;
      const push = await currentRegistryCredential(tx, this.cipher, input.integrationId, 'push'),
        pull = await currentRegistryCredential(tx, this.cipher, input.integrationId, 'pull');
      if (
        push.connection.revision !== input.revision ||
        input.probeRepository !== `${push.connection.namespace}/ozz-probe-${lease.operationId}`
      )
        throw new OperationRequestError(
          409,
          'REGISTRY_PROBE_INTENT_CHANGED',
          '原镜像仓库探针身份已变化。',
        );
      captured = { push, pull };
      await tx.registryConnection.update({
        where: { id: input.integrationId },
        data: {
          pushVerificationState: 'unverified',
          pullVerificationState: 'unverified',
          pushVerifiedAt: null,
          pullVerifiedAt: null,
          pushErrorCode: null,
          pullErrorCode: null,
          pushVerificationJson: {
            operationId: lease.operationId,
            credentialRefId: push.credentialRefId,
          },
          pullVerificationJson: {
            operationId: lease.operationId,
            credentialRefId: pull.credentialRefId,
          },
        },
      });
    });
    if (!valid || !captured) interrupted();
    const credentials = captured;
    const currentProbe = async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT "id" FROM "RegistryConnection" WHERE "id"=${input.integrationId}::uuid FOR UPDATE`;
      const current = await tx.registryConnection.findUniqueOrThrow({
        where: { id: input.integrationId },
      });
      if (
        current.revision !== input.revision ||
        current.pushCredentialRefId !== credentials.push.credentialRefId ||
        current.pullCredentialRefId !== credentials.pull.credentialRefId ||
        (current.pushVerificationJson as { operationId?: string } | null)?.operationId !==
          lease.operationId ||
        (current.pullVerificationJson as { operationId?: string } | null)?.operationId !==
          lease.operationId
      )
        throw new OperationRequestError(
          409,
          'REGISTRY_CREDENTIAL_CHANGED',
          '凭证或验证操作已变化，不能把旧探针结果标记给新凭证。',
        );
      return current;
    };
    const result = await this.registry.verify({
      authority: credentials.push.connection.authority,
      repository: input.probeRepository!,
      push: credentials.push.access,
      pull: credentials.pull.access,
      signal,
      onChecked: async (check) => {
        const saved = await this.repository.checkpoint(lease, async (tx) => {
          const current = await currentProbe(tx);
          const evidence = {
            operationId: lease.operationId,
            probeReference: check.probeReference,
            checkedAt: check.checkedAt,
          };
          await tx.registryConnection.update({
            where: { id: input.integrationId },
            data:
              check.kind === 'push'
                ? {
                    pushVerificationState: 'verified',
                    pushVerifiedAt: new Date(check.checkedAt),
                    pushErrorCode: null,
                    pushVerificationJson: {
                      ...evidence,
                      push: true,
                      credentialRefId: current.pushCredentialRefId,
                    },
                  }
                : {
                    pullVerificationState:
                      check.kind === 'pull_cannot_push' ? 'verified' : 'unverified',
                    pullVerifiedAt: new Date(check.checkedAt),
                    pullErrorCode: null,
                    pullVerificationJson: {
                      ...evidence,
                      pull: true,
                      ...(check.kind === 'pull_cannot_push' ? { pullCannotPush: true } : {}),
                      credentialRefId: current.pullCredentialRefId,
                    },
                  },
          });
        });
        if (!saved) interrupted();
      },
    });
    return {
      result: json(result),
      commit: async (tx) => {
        const current = await currentProbe(tx);
        const checkedAt = new Date(result.checkedAt);
        await tx.registryConnection.update({
          where: { id: current.id },
          data: {
            pushVerificationState: 'verified',
            pullVerificationState: 'verified',
            pushVerifiedAt: checkedAt,
            pullVerifiedAt: checkedAt,
            pushErrorCode: null,
            pullErrorCode: null,
            pushVerificationJson: json({
              ...result,
              operationId: lease.operationId,
              credentialRefId: current.pushCredentialRefId,
            }),
            pullVerificationJson: json({
              operationId: lease.operationId,
              pull: true,
              pullCannotPush: true,
              credentialRefId: current.pullCredentialRefId,
              checkedAt: result.checkedAt,
            }),
          },
        });
      },
    };
  }
  async failed(
    lease: TaskLease,
    tx: Prisma.TransactionClient,
    code: string,
    _message?: string,
  ): Promise<void> {
    const input = lease.input as IntegrationOperationInput;
    if (lease.kind === 'github_webhook_register')
      await tx.gitRepository.updateMany({
        where: { id: input.integrationId, hookOperationId: lease.operationId },
        data: { hookState: 'failed', hookErrorCode: code },
      });
    if (lease.kind === 'registry_validate') {
      await tx.$queryRaw`SELECT "id" FROM "RegistryConnection" WHERE "id"=${input.integrationId}::uuid FOR UPDATE`;
      const current = await tx.registryConnection.findUnique({
        where: { id: input.integrationId },
      });
      if (!current || current.revision !== input.revision) return;
      const failedPush =
        (current.pushVerificationJson as { operationId?: string } | null)?.operationId ===
          lease.operationId && current.pushVerificationState !== 'verified';
      const failedPull =
        (current.pullVerificationJson as { operationId?: string } | null)?.operationId ===
          lease.operationId && current.pullVerificationState !== 'verified';
      if (failedPush || failedPull)
        await tx.registryConnection.update({
          where: { id: current.id },
          data: {
            ...(failedPush
              ? { pushVerificationState: 'failed', pushErrorCode: code, pushVerifiedAt: new Date() }
              : {}),
            ...(failedPull
              ? { pullVerificationState: 'failed', pullErrorCode: code, pullVerifiedAt: new Date() }
              : {}),
          },
        });
    }
  }
}
