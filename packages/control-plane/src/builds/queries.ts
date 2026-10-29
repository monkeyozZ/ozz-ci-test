import type { PrismaClient } from '@ozz/database';
import { parseArtifact } from '@ozz/infrastructure/build';
import type { ResolvedImage } from '@ozz/infrastructure/registry';
import { OperationRequestError, validateOperationId } from '../tasks/contracts.js';

export class BuildQueries {
  constructor(private readonly db: PrismaClient) {}
  async detail(deploymentId: string) {
    validateOperationId(deploymentId);
    const deployment = await this.db.deployment.findUnique({
      where: { id: deploymentId },
      include: { artifact: true, buildRuns: { orderBy: { runNumber: 'asc' } } },
    });
    if (!deployment)
      throw new OperationRequestError(404, 'DEPLOYMENT_NOT_FOUND', '发布任务不存在。');
    const artifact = deployment.artifact;
    return {
      sourceRevisionId: deployment.sourceRevisionId,
      reuseArtifactId: deployment.reuseArtifactId,
      runs: deployment.buildRuns.map((run) => ({
        id: run.id,
        runNumber: run.runNumber,
        builderId: run.builderId,
        builderInstanceId: run.builderInstanceId,
        specHash: run.specHash,
        epoch: { generation: run.generation, ownershipEpoch: run.ownershipEpoch },
        phase: run.phase,
        executionState: run.executionState,
        executionClosedAt: run.executionClosedAt?.toISOString() ?? null,
        closureReason: run.closureReason,
        submissionAttemptedAt: run.submissionAttemptedAt?.toISOString() ?? null,
        cancelRequestedAt: run.cancelRequestedAt?.toISOString() ?? null,
        observationState: run.observationState,
        lastObservedAt: run.observedAt?.toISOString() ?? null,
        lastErrorCode: run.lastErrorCode,
        ledgerRevision: run.remoteLedgerRevision.toString(),
        proofVerifiedAt: run.proofVerifiedAt?.toISOString() ?? null,
        logsTruncated: run.logsTruncated,
        logsExpireAt: run.logsExpireAt?.toISOString() ?? null,
        createdAt: run.createdAt.toISOString(),
      })),
      artifact: artifact
        ? {
            state: artifact.locationState as 'oci' | 'registry',
            id: artifact.id,
            producedByRunId: artifact.producedByRunId,
            sourceRevisionId: artifact.sourceRevisionId,
            commitSha: artifact.commitSha,
            recipeHash: artifact.recipeHash,
            rootDigest: artifact.rootDigest,
            rootMediaType: artifact.mediaType,
            platforms: parseArtifact(artifact.descriptorJson).platforms,
            archiveBytes: artifact.archiveBytes.toString(),
            archiveExpiresAt: artifact.archiveExpiresAt.toISOString(),
            registryConnectionId: artifact.registryConnectionId,
            destination: artifact.destinationJson,
            image: artifact.resolvedImageJson as unknown as ResolvedImage | null,
            pushedAt: artifact.pushedAt?.toISOString() ?? null,
            lastVerifiedAt: artifact.lastVerifiedAt?.toISOString() ?? null,
            availability: artifact.availability,
          }
        : { state: 'none' as const },
    };
  }
  async logs(
    deploymentId: string,
    query: { runId?: string; cursor?: string; limit?: number } = {},
  ) {
    validateOperationId(deploymentId);
    const limit = Math.max(1, Math.min(100, Number.isSafeInteger(query.limit) ? query.limit! : 50));
    let after = 0n;
    let runId = query.runId;
    if (query.cursor) {
      try {
        if (query.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/u.test(query.cursor)) throw new Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as {
          version: unknown;
          runId: string;
          after: string;
        };
        if (
          cursor.version !== 1 ||
          !/^(0|[1-9][0-9]{0,18})$/u.test(cursor.after) ||
          (runId && runId !== cursor.runId)
        )
          throw new Error();
        validateOperationId(cursor.runId);
        runId = cursor.runId;
        after = BigInt(cursor.after);
        if (after > 9223372036854775807n) throw new Error();
      } catch {
        throw new OperationRequestError(422, 'INVALID_CURSOR', '构建日志游标无效。');
      }
    }
    if (runId) validateOperationId(runId);
    const run = await this.db.buildRun.findFirst({
      where: { deploymentId, ...(runId ? { id: runId } : {}) },
      orderBy: { runNumber: 'desc' },
    });
    if (!run && !(await this.db.deployment.count({ where: { id: deploymentId } })))
      throw new OperationRequestError(404, 'DEPLOYMENT_NOT_FOUND', '发布任务不存在。');
    if (runId && !run)
      throw new OperationRequestError(404, 'BUILD_RUN_NOT_FOUND', '构建不属于此发布任务。');
    const expired = Boolean(run?.logsExpireAt && run.logsExpireAt <= new Date());
    const rows =
      !run || expired
        ? []
        : await this.db.buildLogChunk.findMany({
            where: { runId: run.id, sequence: { gt: after }, expiresAt: { gt: new Date() } },
            orderBy: { sequence: 'asc' },
            take: limit + 1,
          });
    let bytes = 0;
    const retained = rows.slice(0, limit).filter((row) => {
      bytes += row.bytes;
      return bytes <= 65536;
    });
    const hasMore = retained.length < rows.length;
    return {
      runId: run?.id ?? null,
      runNumber: run?.runNumber ?? null,
      source: 'builder' as const,
      available: retained.length > 0,
      unavailableReason: retained.length
        ? null
        : expired
          ? 'expired'
          : run
            ? 'not_available'
            : 'not_started',
      truncated: run?.logsTruncated ?? false,
      expiresAt: run?.logsExpireAt?.toISOString() ?? null,
      items: retained.map((row) => ({
        sequence: row.sequence.toString(),
        phase: row.phase,
        timestamp: row.timestamp.toISOString(),
        content: row.content,
        truncated: row.truncated,
      })),
      pageInfo: {
        hasMore,
        nextCursor:
          hasMore && retained.length
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  runId: run!.id,
                  after: retained.at(-1)!.sequence.toString(),
                }),
              ).toString('base64url')
            : null,
      },
    };
  }
}
export type BuildDetailView = Awaited<ReturnType<BuildQueries['detail']>>;
export type BuildLogPage = Awaited<ReturnType<BuildQueries['logs']>>;
