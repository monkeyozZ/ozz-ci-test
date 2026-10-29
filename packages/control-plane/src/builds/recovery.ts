import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type BuildRun } from '@ozz/database';
import {
  BuilderError,
  HttpBuilderClient,
  HttpsBuilderTransport,
  canonicalJson,
  compareEpoch,
  hashJson,
  parseBuildRunSpec,
  parseEpoch,
  parseFenceReceipt,
  parseIdentity,
  parseInventoryPage,
  parseObservation,
  verifyEndProof,
  verifyInventoryPages,
  verifySigned,
  type BuilderClient,
  type BuilderTlsConnection,
  type BuilderInventoryPage,
  type BuildRunObservation,
} from '@ozz/infrastructure/build';
import { parseBuilderCredential } from '../integrations/persistence.js';
import type { SecretCipher } from '../secrets.js';
import type { TaskRepository } from '../tasks/repository.js';
import { lockTask } from '../tasks/records.js';
import { BuildRepository } from './repository.js';
import {
  BUILD_RECOVERY_HISTORY_ACTION,
  parseRecoveryManifest,
  recoveryManifestFacts,
  verifyHistoricalRun,
  type AcceptedBuilderHistory,
  type BuildRecoveryManifest,
  type BuildRecoveryScope,
} from './recovery-history.js';

export { BUILD_RECOVERY_MANIFEST_MAX_BYTES } from './recovery-history.js';
export type { BuildRecoveryManifest, BuildRecoveryScope } from './recovery-history.js';

export interface BuildRecoveryIssue {
  builderId: string;
  code: string;
  runId?: string;
  message: string;
}
export class BuildRecoveryBlocked extends Error {
  readonly code = 'BUILD_RECOVERY_BLOCKED';
  constructor(readonly issues: BuildRecoveryIssue[]) {
    super('Builder 恢复核对尚未通过，恢复锁保持开启。');
    this.name = 'BuildRecoveryBlocked';
  }
}
/** The CLI must hold ControlPlaneState FOR UPDATE and allow bounded remote verification plus local writes. */
export const BUILD_RECOVERY_TRANSACTION_TIMEOUT_MS = 60000;
export interface BuildRecoveryPlan {
  readonly generation: number;
  readonly expiresAt: string;
  readonly historyAcceptanceId?: string;
  readonly acceptedUnknownRunCount?: number;
}
type RegisteredBuilder = Prisma.BuilderGetPayload<{ include: { credential: true } }>;
type InstallationInventory = Omit<BuilderInventoryPage, 'offset' | 'nextCursor'>;
interface LocalState {
  installationId: string;
  generation: number;
  scope: BuildRecoveryScope;
  builders: RegisteredBuilder[];
  runs: BuildRun[];
  acceptedHistory: AcceptedBuilderHistory | null;
}
interface ConnectedBuilder {
  builder: RegisteredBuilder;
  client: BuilderClient;
  highGeneration: number;
}
interface PreparedState {
  local: LocalState;
  fingerprint: string;
  builders: Array<{
    builder: RegisteredBuilder;
    client: BuilderClient;
    inventory: InstallationInventory;
  }>;
  observations: Array<{ runId: string; observation: BuildRunObservation }>;
  unsubmitted: string[];
  verifiedUntil: number | null;
}
const challenge = () => randomBytes(32).toString('base64url');
function blocked(
  builderId: string,
  code: string,
  message: string,
  runId?: string,
): BuildRecoveryBlocked {
  return new BuildRecoveryBlocked([{ builderId, code, message, ...(runId ? { runId } : {}) }]);
}
function remoteFailure(
  builderId: string,
  operation: 'identity' | 'fence' | 'inventory' | 'proof',
  error: unknown,
): BuildRecoveryBlocked {
  if (error instanceof BuildRecoveryBlocked) return error;
  if (
    (error instanceof BuilderError &&
      [
        'BUILD_UNAVAILABLE',
        'BUILD_TIMEOUT',
        'BUILD_TRANSPORT_CANCELLED',
        'BUILD_TLS_INVALID',
        'BUILD_AUTH_INVALID',
      ].includes(error.code)) ||
    (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
  )
    return blocked(
      builderId,
      'BUILDER_UNREACHABLE',
      '无法通过可信连接访问 Builder，未取得完整核对结果。',
    );
  if (error instanceof BuilderError && error.code === 'BUILD_INVENTORY_EXPIRED')
    return blocked(builderId, 'INVENTORY_EXPIRED', 'Builder 清单已过期，请重新准备恢复核对。');
  return blocked(
    builderId,
    operation === 'identity'
      ? 'BUILDER_IDENTITY_MISMATCH'
      : operation === 'fence'
        ? 'BUILDER_FENCE_REJECTED'
        : operation === 'proof'
          ? 'PROOF_INVALID'
          : 'INVENTORY_INVALID',
    operation === 'fence'
      ? 'Builder 未确认本次代际隔离，恢复锁保持开启。'
      : 'Builder 返回的签名、身份或完整性核对未通过。',
  );
}
function fingerprint(local: LocalState): string {
  return hashJson({
    installationId: local.installationId,
    generation: local.generation,
    scope: local.scope,
    builders: local.builders.map((builder) => ({
      id: builder.id,
      instanceId: builder.instanceId,
      revision: builder.revision,
      endpoint: builder.endpoint,
      publicKey: builder.identityPublicKey,
      credentialId: builder.credentialRefId,
      credentialRevision: builder.credential.contentRevision,
      credentialUpdatedAt: builder.credential.updatedAt.toISOString(),
      updatedAt: builder.updatedAt.toISOString(),
    })),
    runs: local.runs.map((run) => ({
      id: run.id,
      builderId: run.builderId,
      builderInstanceId: run.builderInstanceId,
      specHash: run.specHash,
      generation: run.generation,
      ownershipEpoch: run.ownershipEpoch,
      remoteEpoch: run.remoteEpochJson,
      remoteLedgerRevision: run.remoteLedgerRevision.toString(),
      state: run.executionState,
      submissionAttemptedAt: run.submissionAttemptedAt?.toISOString() ?? null,
      executionClosedAt: run.executionClosedAt?.toISOString() ?? null,
      proofHash: run.endProofJson ? hashJson(run.endProofJson) : null,
      updatedAt: run.updatedAt.toISOString(),
    })),
  });
}
function planFingerprint(local: LocalState): string {
  return hashJson({
    local: fingerprint(local),
    acceptedHistory: local.acceptedHistory
      ? { auditId: local.acceptedHistory.auditId, manifestHash: local.acceptedHistory.manifestHash }
      : null,
  });
}

/** Explicit restore flow only. It never submits source, grants credentials, cancels unknown runs, or releases task slots. */
export class BuildRecovery {
  private readonly plans = new WeakMap<BuildRecoveryPlan, PreparedState>();
  private readonly records: BuildRepository;
  constructor(
    private readonly tasks: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly options: {
      clientFactory?: (connection: BuilderTlsConnection) => BuilderClient;
    } = {},
  ) {
    this.records = new BuildRepository(tasks);
  }
  private async local(tx: Prisma.TransactionClient): Promise<LocalState> {
    const state = await tx.controlPlaneState.findUniqueOrThrow({ where: { id: 'control-plane' } });
    if (!state.restoreLocked)
      throw blocked('control-plane', 'RESTORE_NOT_LOCKED', '恢复核对需要先开启控制面恢复锁。');
    const [builders, runs, databaseIdentity, recoveryAudit] = await Promise.all([
      tx.builder.findMany({ include: { credential: true }, orderBy: { id: 'asc' } }),
      tx.buildRun.findMany({ orderBy: { id: 'asc' } }),
      tx.$queryRaw<
        Array<{ database: string; schema: string }>
      >`SELECT current_database() AS database, current_schema() AS schema`,
      tx.auditEvent.findFirst({
        where: {
          resourceType: 'control-plane',
          resourceId: 'control-plane',
          outcome: 'succeeded',
          OR: [
            { action: 'recovery.restore', createdAt: state.updatedAt },
            {
              action: 'recovery:lock',
              metadata: { path: ['lockedAt'], equals: state.updatedAt.toISOString() },
            },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      }),
    ]);
    const scope: BuildRecoveryScope = {
      installationId: state.installationId,
      generation: state.generation,
      lockedAt: state.updatedAt.toISOString(),
      databaseIdentityHash: hashJson(databaseIdentity),
      recoveryAuditId: recoveryAudit?.id ?? null,
    };
    const accepted = await tx.auditEvent.findFirst({
      where: {
        action: BUILD_RECOVERY_HISTORY_ACTION,
        resourceType: 'control-plane',
        outcome: 'succeeded',
        metadata: { path: ['scopeHash'], equals: hashJson(scope) },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    let acceptedHistory: AcceptedBuilderHistory | null = null;
    if (accepted) {
      try {
        const metadata = accepted.metadata as Record<string, unknown>;
        const manifest = parseRecoveryManifest(metadata.manifest);
        if (
          metadata.acknowledgeMissingHistory !== true ||
          metadata.manifestHash !== hashJson(manifest) ||
          accepted.resourceId !== manifest.id ||
          hashJson(manifest.scope) !== hashJson(scope)
        )
          throw new Error();
        acceptedHistory = {
          auditId: accepted.id,
          acceptedAt: accepted.createdAt.toISOString(),
          manifestHash: hashJson(manifest),
          manifest,
        };
      } catch {
        throw blocked(
          'control-plane',
          'ACCEPTANCE_INVALID',
          '已保存的历史运行核对记录无效，恢复锁保持开启。',
        );
      }
    }
    return {
      installationId: state.installationId,
      generation: state.generation,
      scope,
      builders,
      runs,
      acceptedHistory,
    };
  }
  private plan(plan: BuildRecoveryPlan): PreparedState {
    const state = this.plans.get(plan);
    if (!state)
      throw blocked('control-plane', 'PLAN_INVALID', '恢复计划必须来自本次进程中的受控准备步骤。');
    if (Date.parse(plan.expiresAt) <= Date.now())
      throw blocked('control-plane', 'PLAN_EXPIRED', '恢复计划已过期，请重新准备。');
    return state;
  }
  private async inventory(
    builder: RegisteredBuilder,
    client: BuilderClient,
    installationId: string,
    signal: AbortSignal,
  ): Promise<InstallationInventory> {
    const nonce = challenge();
    const pages: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      signal.throwIfAborted();
      const signed = parseInventoryPage(await client.inventory(nonce, cursor, signal));
      const page = verifySigned(signed, builder.identityPublicKey);
      if (
        page.challenge !== nonce ||
        page.installationId !== installationId ||
        page.builderInstanceId !== builder.instanceId ||
        page.offset !== pages.length * 100 ||
        page.totalRuns > 200000 ||
        Date.parse(page.expiresAt) <= Date.now()
      )
        throw new BuilderError('BUILD_PROOF_INVALID');
      pages.push(signed);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return verifyInventoryPages(pages, {
      installationId,
      builderInstanceId: builder.instanceId,
      challenge: nonce,
      publicKey: builder.identityPublicKey,
    });
  }
  private async connect(local: LocalState, signal: AbortSignal): Promise<ConnectedBuilder[]> {
    const clients: ConnectedBuilder[] = [];
    const issues: BuildRecoveryIssue[] = [];
    // Even disabled Builders and Builders without local runs must be inventoried.
    for (const builder of local.builders) {
      let client: BuilderClient;
      try {
        if (
          builder.credential.kind !== 'builder' ||
          (builder.credential.expiresAt && builder.credential.expiresAt <= new Date())
        )
          throw new Error();
        const connection = {
          origin: builder.endpoint,
          ...parseBuilderCredential(this.cipher.decrypt(builder.credential)),
          timeoutMs: 5000,
        };
        client = this.options.clientFactory
          ? this.options.clientFactory(connection)
          : new HttpBuilderClient(new HttpsBuilderTransport(connection));
      } catch {
        issues.push({
          builderId: builder.id,
          code: 'BUILDER_CREDENTIAL_INVALID',
          message: 'Builder 当前控制凭证不可用，无法完成恢复核对。',
        });
        continue;
      }
      try {
        signal.throwIfAborted();
        const nonce = challenge();
        const identity = verifySigned(
          parseIdentity(await client.identity(nonce, signal)),
          builder.identityPublicKey,
        );
        if (
          identity.challenge !== nonce ||
          identity.instanceId !== builder.instanceId ||
          identity.profile.instanceId !== builder.instanceId ||
          Math.abs(Date.now() - Date.parse(identity.checkedAt)) > 60000
        )
          throw new BuilderError('BUILD_IDENTITY_MISMATCH');
        clients.push({ builder, client, highGeneration: identity.highGeneration });
      } catch (error) {
        issues.push(...remoteFailure(builder.id, 'identity', error).issues);
      }
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    return clients;
  }
  private async inspectLocal(
    local: LocalState,
    signal: AbortSignal,
  ): Promise<BuildRecoveryManifest> {
    if (!local.scope.recoveryAuditId)
      throw blocked(
        'control-plane',
        'RECOVERY_INSTANCE_UNRECORDED',
        '请先使用正式恢复或 recovery:lock 建立本次恢复实例，再生成核对清单。',
      );
    const clients = await this.connect(local, signal);
    const manifest: BuildRecoveryManifest = {
      version: 1,
      kind: 'ozz-builder-recovery-history',
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      scope: local.scope,
      localFingerprint: fingerprint(local),
      historyMetadataRestored: false,
      builders: [],
      unknownRuns: [],
    };
    const localIds = new Set(local.runs.map((run) => run.id));
    const issues: BuildRecoveryIssue[] = [];
    const observed: PreparedState['builders'] = [];
    for (const { builder, client, highGeneration } of clients) {
      let inventory: InstallationInventory;
      try {
        inventory = await this.inventory(builder, client, local.installationId, signal);
        if (inventory.highGeneration !== highGeneration)
          throw new BuilderError('BUILD_EPOCH_STALE');
      } catch (error) {
        issues.push(...remoteFailure(builder.id, 'inventory', error).issues);
        continue;
      }
      observed.push({ builder, client, inventory });
      manifest.builders.push({
        builderId: builder.id,
        builderInstanceId: builder.instanceId,
        endpoint: builder.endpoint,
        publicKeyFingerprint: hashJson(builder.identityPublicKey),
        highGeneration: inventory.highGeneration,
        inventoryRevision: inventory.inventoryRevision,
        runInventoryHash: hashJson(inventory.runs),
        totalRuns: inventory.totalRuns,
      });
      for (const remote of inventory.runs) {
        if (localIds.has(remote.runId)) continue;
        if (remote.epoch.generation > inventory.highGeneration) {
          issues.push({
            builderId: builder.id,
            runId: remote.runId,
            code: 'INVENTORY_INVALID',
            message: '备份外运行代次超过已签名的 Builder 高水位。',
          });
          continue;
        }
        if (!remote.executionClosed) {
          issues.push({
            builderId: builder.id,
            runId: remote.runId,
            code: 'REMOTE_RUN_OPEN',
            message: '备份外运行尚未取得可信结束证明，不能接纳其历史记录。',
          });
          continue;
        }
        try {
          signal.throwIfAborted();
          manifest.unknownRuns.push(
            verifyHistoricalRun(
              builder,
              local.installationId,
              remote,
              await client.get(remote.runId, signal),
            ),
          );
        } catch (error) {
          issues.push(
            ...remoteFailure(builder.id, 'proof', error).issues.map((issue) => ({
              ...issue,
              runId: remote.runId,
            })),
          );
        }
      }
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    for (const { builder, client, inventory } of observed) {
      try {
        const current = await this.inventory(builder, client, local.installationId, signal);
        if (
          current.highGeneration !== inventory.highGeneration ||
          current.inventoryRevision !== inventory.inventoryRevision
        )
          throw blocked(
            builder.id,
            'INVENTORY_CHANGED',
            '读取结束证明期间完整运行清单已变化，请重新核对。',
          );
      } catch (error) {
        issues.push(...remoteFailure(builder.id, 'inventory', error).issues);
      }
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    signal.throwIfAborted();
    try {
      return parseRecoveryManifest(manifest);
    } catch {
      throw blocked('control-plane', 'MANIFEST_INVALID', '核对清单的格式或大小超出支持范围。');
    }
  }
  /** Read-only on PostgreSQL and Builder. The operator reviews the returned explicit run list. */
  async inspect(): Promise<BuildRecoveryManifest> {
    return this.tasks.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ControlPlaneState" WHERE id='control-plane' FOR SHARE`;
        const local = await this.local(tx);
        const manifest = await this.inspectLocal(local, AbortSignal.timeout(50000));
        if (fingerprint(await this.local(tx)) !== fingerprint(local))
          throw blocked(
            'control-plane',
            'LOCAL_STATE_CHANGED',
            '生成清单期间本地恢复事实已改变，请重新核对。',
          );
        return manifest;
      },
      { timeout: BUILD_RECOVERY_TRANSACTION_TIMEOUT_MS },
    );
  }
  /** Records one explicit, complete review; acceptance never fences or unlocks the database. */
  async accept(
    raw: unknown,
    acknowledgement: { acknowledgeMissingHistory: boolean },
  ): Promise<{
    auditId: string;
    manifestId: string;
    acceptedRunCount: number;
    alreadyAccepted: boolean;
  }> {
    if (acknowledgement.acknowledgeMissingHistory !== true)
      throw blocked(
        'control-plane',
        'MISSING_HISTORY_ACK_REQUIRED',
        '须明确确认备份后缺失的发布与来源历史不会由结束证明重建。',
      );
    let manifest: BuildRecoveryManifest;
    try {
      manifest = parseRecoveryManifest(raw);
    } catch {
      throw blocked('control-plane', 'MANIFEST_INVALID', '核对文件格式、大小或结束证明无效。');
    }
    if (!manifest.unknownRuns.length)
      throw blocked('control-plane', 'MANIFEST_EMPTY', '清单没有需要显式接纳的备份外运行。');
    const manifestHash = hashJson(manifest);
    return this.tasks.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "ControlPlaneState" WHERE id='control-plane' FOR UPDATE`;
        const local = await this.local(tx);
        if (hashJson(local.scope) !== hashJson(manifest.scope))
          throw blocked(
            'control-plane',
            'RECOVERY_SCOPE_CHANGED',
            '核对文件不属于当前恢复数据库与锁定代次。',
          );
        const existing = await tx.auditEvent.findFirst({
          where: {
            action: BUILD_RECOVERY_HISTORY_ACTION,
            resourceType: 'control-plane',
            resourceId: manifest.id,
          },
        });
        if (
          existing &&
          (existing.metadata as Record<string, unknown>)?.manifestHash !== manifestHash
        )
          throw blocked(
            'control-plane',
            'MANIFEST_CONFLICT',
            '同一个核对 ID 已保存不同内容，不能替换原决定。',
          );
        if (existing && local.acceptedHistory?.auditId !== existing.id)
          throw blocked(
            'control-plane',
            'MANIFEST_SUPERSEDED',
            '该审阅已被后续完整核对取代，请使用当前记录或重新生成清单。',
          );
        const current = await this.inspectLocal(local, AbortSignal.timeout(50000));
        if (
          recoveryManifestFacts(current) !== recoveryManifestFacts(manifest) ||
          fingerprint(await this.local(tx)) !== fingerprint(local)
        )
          throw blocked(
            'control-plane',
            'REVIEW_CHANGED',
            '完整清单、可信身份或本地事实已变化，请重新生成并审阅清单。',
          );
        if (existing)
          return {
            auditId: existing.id,
            manifestId: manifest.id,
            acceptedRunCount: manifest.unknownRuns.length,
            alreadyAccepted: true,
          };
        const accepted = await tx.auditEvent.create({
          data: {
            createdAt: new Date(
              Math.max(
                Date.now(),
                local.acceptedHistory ? Date.parse(local.acceptedHistory.acceptedAt) + 1 : 0,
              ),
            ),
            action: BUILD_RECOVERY_HISTORY_ACTION,
            resourceType: 'control-plane',
            resourceId: manifest.id,
            outcome: 'succeeded',
            metadata: JSON.parse(
              canonicalJson({
                version: 1,
                scopeHash: hashJson(local.scope),
                manifestHash,
                acknowledgeMissingHistory: true,
                manifest,
              }),
            ) as Prisma.InputJsonValue,
          },
        });
        return {
          auditId: accepted.id,
          manifestId: manifest.id,
          acceptedRunCount: manifest.unknownRuns.length,
          alreadyAccepted: false,
        };
      },
      { timeout: BUILD_RECOVERY_TRANSACTION_TIMEOUT_MS },
    );
  }
  async prepare(): Promise<BuildRecoveryPlan> {
    const local = await this.tasks.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ControlPlaneState" WHERE id='control-plane' FOR SHARE`;
      return this.local(tx);
    });
    const signal = AbortSignal.timeout(60000);
    const clients = await this.connect(local, signal);
    const issues: BuildRecoveryIssue[] = [];
    const accepted = local.acceptedHistory?.manifest;
    if (accepted && accepted.localFingerprint !== fingerprint(local))
      throw blocked(
        'control-plane',
        'ACCEPTANCE_STALE',
        '接纳后本地恢复事实已变化，请重新生成并审阅清单。',
      );
    const generation =
      Math.max(local.generation, ...clients.map((item) => item.highGeneration)) + 1;
    if (!Number.isSafeInteger(generation) || generation > 2147483647)
      throw blocked('control-plane', 'GENERATION_EXHAUSTED', '隔离代际超出控制面可存储范围。');
    // All fences precede all inventories. A failed/partial fence is durable and keeps restore locked.
    await this.tasks.db.$transaction(
      async (tx) => {
        // Shared lock prevents another unlock from completing while a remote fence is in flight.
        await tx.$queryRaw`SELECT id FROM "ControlPlaneState" WHERE id='control-plane' FOR SHARE`;
        if (planFingerprint(await this.local(tx)) !== planFingerprint(local))
          throw blocked(
            'control-plane',
            'LOCAL_STATE_CHANGED',
            '本地恢复状态已改变，未发送隔离请求。',
          );
        for (const { builder, client } of clients) {
          try {
            signal.throwIfAborted();
            const request = {
              installationId: local.installationId,
              builderInstanceId: builder.instanceId,
              requestId: randomUUID(),
              generation,
              challenge: challenge(),
            };
            const receipt = verifySigned(
              parseFenceReceipt(await client.fence(request, signal)),
              builder.identityPublicKey,
            );
            const { version: _version, highGeneration, fencedAt, ...received } = receipt;
            if (
              canonicalJson(received) !== canonicalJson(request) ||
              highGeneration !== generation ||
              Math.abs(Date.now() - Date.parse(fencedAt)) > 60000
            )
              throw new BuilderError('BUILD_PROOF_INVALID');
          } catch (error) {
            issues.push(...remoteFailure(builder.id, 'fence', error).issues);
          }
        }
      },
      { timeout: BUILD_RECOVERY_TRANSACTION_TIMEOUT_MS },
    );
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    const inventories: PreparedState['builders'] = [];
    for (const { builder, client } of clients) {
      try {
        const inventory = await this.inventory(builder, client, local.installationId, signal);
        if (inventory.highGeneration !== generation) throw new BuilderError('BUILD_EPOCH_STALE');
        inventories.push({ builder, client, inventory });
      } catch (error) {
        issues.push(...remoteFailure(builder.id, 'inventory', error).issues);
      }
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    if (accepted) {
      for (const { builder, inventory } of inventories) {
        const reviewed = accepted.builders.find((item) => item.builderId === builder.id);
        if (
          !reviewed ||
          reviewed.builderInstanceId !== builder.instanceId ||
          reviewed.endpoint !== builder.endpoint ||
          reviewed.publicKeyFingerprint !== hashJson(builder.identityPublicKey) ||
          reviewed.runInventoryHash !== hashJson(inventory.runs) ||
          reviewed.totalRuns !== inventory.totalRuns
        )
          issues.push({
            builderId: builder.id,
            code: 'ACCEPTED_INVENTORY_CHANGED',
            message: '显式接纳后的完整运行清单或可信身份发生变化，请重新核对。',
          });
      }
      if (accepted.builders.length !== inventories.length)
        issues.push({
          builderId: 'control-plane',
          code: 'ACCEPTED_INVENTORY_CHANGED',
          message: '接纳后的 Builder 登记集合发生变化。',
        });
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    const observations: PreparedState['observations'] = [];
    const unsubmitted: string[] = [];
    const localRuns = new Map(local.runs.map((run) => [run.id, run]));
    for (const { builder, client, inventory } of inventories) {
      const remoteRuns = new Map(inventory.runs.map((run) => [run.runId, run]));
      for (const remote of inventory.runs) {
        const run = localRuns.get(remote.runId);
        if (!run) {
          const historical = accepted?.unknownRuns.find(
            (item) => item.builderId === builder.id && item.runId === remote.runId,
          );
          if (historical) {
            try {
              signal.throwIfAborted();
              const current = verifyHistoricalRun(
                builder,
                local.installationId,
                remote,
                await client.get(remote.runId, signal),
              );
              if (hashJson(current) !== hashJson(historical))
                throw new BuilderError('BUILD_PROOF_INVALID');
            } catch (error) {
              issues.push(
                ...remoteFailure(builder.id, 'proof', error).issues.map((issue) => ({
                  ...issue,
                  runId: remote.runId,
                })),
              );
            }
            continue;
          }
          issues.push({
            builderId: builder.id,
            code: 'UNKNOWN_REMOTE_RUN',
            runId: remote.runId,
            message: 'Builder 保留了本地备份中不存在的运行；须人工核对，未自动导入或取消。',
          });
          continue;
        }
        if (
          run.builderId !== builder.id ||
          run.builderInstanceId !== builder.instanceId ||
          run.specHash !== remote.specHash ||
          run.executionState === 'never_submitted'
        ) {
          issues.push({
            builderId: builder.id,
            code: 'RUN_IDENTITY_MISMATCH',
            runId: run.id,
            message: '本地与 Builder 的运行身份或提交事实冲突。',
          });
          continue;
        }
        if (!remote.executionClosed) {
          issues.push({
            builderId: builder.id,
            code: 'REMOTE_RUN_OPEN',
            runId: run.id,
            message: '远端执行尚未取得可信结束证明，运行槽位保持占用。',
          });
          continue;
        }
        if (run.executionClosedAt) {
          if (!run.endProofJson || hashJson(run.endProofJson) !== remote.proofHash)
            issues.push({
              builderId: builder.id,
              code: 'PROOF_INVALID',
              runId: run.id,
              message: '本地结束证明与 Builder 清单中的证明不同。',
            });
          continue;
        }
        try {
          signal.throwIfAborted();
          const raw = await client.get(run.id, signal);
          if (!raw) throw new BuilderError('BUILD_PROOF_INVALID');
          const observation = parseObservation(raw);
          const spec = parseBuildRunSpec(run.specJson);
          if (
            !observation.proof ||
            observation.runId !== run.id ||
            observation.specHash !== run.specHash ||
            observation.builderInstanceId !== builder.instanceId ||
            observation.installationId !== local.installationId ||
            observation.ledgerRevision !== remote.ledgerRevision ||
            compareEpoch(observation.epoch, remote.epoch) !== 0 ||
            hashJson(observation.proof) !== remote.proofHash
          )
            throw new BuilderError('BUILD_PROOF_INVALID');
          const proof = verifyEndProof(observation.proof, {
            spec,
            specHash: run.specHash,
            publicKey: builder.identityPublicKey,
            minimumEpoch: run.remoteEpochJson ? parseEpoch(run.remoteEpochJson) : undefined,
            minimumLedgerRevision: run.remoteLedgerRevision.toString(),
            artifact: observation.artifact,
          });
          if (
            proof.payload.ledgerRevision !== observation.ledgerRevision ||
            compareEpoch(proof.payload.epoch, observation.epoch) !== 0
          )
            throw new BuilderError('BUILD_PROOF_INVALID');
          observations.push({ runId: run.id, observation });
        } catch (error) {
          issues.push(
            ...remoteFailure(builder.id, 'proof', error).issues.map((issue) => ({
              ...issue,
              runId: run.id,
            })),
          );
        }
      }
      for (const run of local.runs.filter((run) => run.builderId === builder.id)) {
        if (remoteRuns.has(run.id)) continue;
        if (run.submissionAttemptedAt || run.executionState === 'ended')
          issues.push({
            builderId: builder.id,
            code: 'LOCAL_RUN_MISSING',
            runId: run.id,
            message: '本地记录可能已提交，但完整远端清单缺少该运行及墓碑。',
          });
        else if (!run.executionClosedAt && run.executionState === 'prepared')
          unsubmitted.push(run.id);
        else if (!run.executionClosedAt)
          issues.push({
            builderId: builder.id,
            code: 'RUN_IDENTITY_MISMATCH',
            runId: run.id,
            message: '本地运行缺少可核对的提交或结束事实。',
          });
      }
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    const expiresAt = new Date(
      Math.min(
        Date.now() + 60000,
        ...inventories.map((item) => Date.parse(item.inventory.expiresAt)),
      ),
    ).toISOString();
    const plan = Object.freeze({
      generation,
      expiresAt,
      ...(local.acceptedHistory
        ? {
            historyAcceptanceId: local.acceptedHistory.auditId,
            acceptedUnknownRunCount: accepted!.unknownRuns.length,
          }
        : {}),
    });
    this.plans.set(plan, {
      local,
      fingerprint: planFingerprint(local),
      builders: inventories,
      observations,
      unsubmitted,
      verifiedUntil: null,
    });
    this.plan(plan);
    return plan;
  }
  /** Await inside the restore-locked transaction immediately before apply; total remote budget is 20 seconds. */
  async verifyUnchanged(plan: BuildRecoveryPlan): Promise<void> {
    const prepared = this.plan(plan);
    prepared.verifiedUntil = null;
    const signal = AbortSignal.timeout(20000);
    const issues: BuildRecoveryIssue[] = [];
    for (const { builder, client, inventory: original } of prepared.builders) {
      try {
        const current = await this.inventory(
          builder,
          client,
          prepared.local.installationId,
          signal,
        );
        if (
          current.highGeneration !== plan.generation ||
          current.inventoryRevision !== original.inventoryRevision
        )
          throw blocked(
            builder.id,
            'INVENTORY_CHANGED',
            'Builder 清单或隔离代际在核对期间发生变化，请重新准备。',
          );
      } catch (error) {
        issues.push(...remoteFailure(builder.id, 'inventory', error).issues);
      }
    }
    if (issues.length) throw new BuildRecoveryBlocked(issues);
    this.plan(plan);
    prepared.verifiedUntil = Math.min(Date.parse(plan.expiresAt), Date.now() + 10000);
  }
  /** Records remote closure/unsent local closure only; S1 task terminalization and slot release remain separate. */
  async apply(
    tx: Prisma.TransactionClient,
    plan: BuildRecoveryPlan,
  ): Promise<{ generation: number }> {
    const prepared = this.plan(plan);
    if (!prepared.verifiedUntil || prepared.verifiedUntil <= Date.now())
      throw blocked('control-plane', 'PLAN_INVALID', '需要在本次解锁事务中先完成新鲜清单复核。');
    await tx.$queryRaw`SELECT id FROM "ControlPlaneState" WHERE id='control-plane' FOR UPDATE`;
    const current = await this.local(tx);
    if (planFingerprint(current) !== prepared.fingerprint)
      throw blocked(
        'control-plane',
        'LOCAL_STATE_CHANGED',
        '恢复准备后本地 Builder 或运行记录已改变，请重新准备。',
      );
    for (const { runId, observation } of prepared.observations) {
      try {
        await this.records.applyRestoreProof(tx, runId, observation);
      } catch (error) {
        throw new BuildRecoveryBlocked(
          remoteFailure(
            current.runs.find((run) => run.id === runId)!.builderId,
            'proof',
            error,
          ).issues.map((issue) => ({ ...issue, runId })),
        );
      }
    }
    for (const runId of prepared.unsubmitted) {
      const run = current.runs.find((item) => item.id === runId)!;
      await lockTask(tx, { type: 'deployment', id: run.deploymentId });
      await tx.$queryRaw`SELECT id FROM "BuildRun" WHERE id=${runId}::uuid FOR UPDATE`;
      const result = await tx.buildRun.updateMany({
        where: {
          id: runId,
          executionState: 'prepared',
          submissionAttemptedAt: null,
          executionClosedAt: null,
        },
        data: {
          executionState: 'never_submitted',
          executionClosedAt: new Date(),
          closureReason: 'rejected_before_submission',
          reconcileLeaseToken: null,
          reconcileLeaseExpiresAt: null,
        },
      });
      if (result.count !== 1)
        throw blocked(run.builderId, 'LOCAL_STATE_CHANGED', '未提交运行在核对后已改变。', runId);
    }
    if (prepared.verifiedUntil <= Date.now() || Date.parse(plan.expiresAt) <= Date.now())
      throw blocked('control-plane', 'PLAN_EXPIRED', '恢复复核已过期，本次事务必须回滚。');
    prepared.verifiedUntil = null;
    return { generation: plan.generation };
  }
}
