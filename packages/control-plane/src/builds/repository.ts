import { randomUUID } from 'node:crypto';
import { Prisma, type BuildRun } from '@ozz/database';
import {
  BuilderError,
  artifactIdentityHash,
  buildContentHash,
  canonicalJson,
  compareEpoch,
  hashBuildSpec,
  parseBuildRunSpec,
  parseEpoch,
  parseObservation,
  verifyEndProof,
  type BuildRunSpec,
  type BuildRunObservation,
  type BuildEventPage,
} from '@ozz/infrastructure/build';
import { assertWritable, readRecoveryState } from '../recovery.js';
import { TaskExecutionError } from '../tasks/contracts.js';
import { TaskRepository, type DeploymentLease } from '../tasks/repository.js';
import { readServiceSnapshot } from '../services/snapshots.js';
import { lockTask } from '../tasks/records.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
export interface BuildReconcileLease {
  runId: string;
  token: string;
  expiresAt: Date;
}
export class BuildRepository {
  constructor(readonly tasks: TaskRepository) {}
  get db() {
    return this.tasks.db;
  }
  async checkpoint<T>(
    lease: DeploymentLease,
    work: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    let result: T | undefined;
    if (
      !(await this.tasks.checkpoint(lease, async (tx) => {
        result = await work(tx);
      }))
    )
      throw new TaskExecutionError('BUILD_TASK_FENCE_LOST', '构建任务租约已失效。');
    return result as T;
  }
  async prepare(lease: DeploymentLease, spec: BuildRunSpec, builderId: string): Promise<BuildRun> {
    return this.checkpoint(lease, async (tx) => {
      const deployment = await tx.deployment.findUniqueOrThrow({
        where: { id: lease.deploymentId },
      });
      if (
        deployment.kind !== 'git_deploy' ||
        !deployment.sourceRevisionId ||
        spec.deploymentId !== deployment.id
      )
        throw new BuilderError('BUILD_SPEC_INVALID');
      if (
        await tx.buildRun.count({ where: { deploymentId: deployment.id, executionClosedAt: null } })
      )
        throw new TaskExecutionError('BUILD_TERMINATION_PENDING', '原构建尚未取得结束证明。', true);
      const previous = await tx.buildRun.findFirst({
        where: { deploymentId: deployment.id },
        orderBy: { runNumber: 'desc' },
      });
      return tx.buildRun.create({
        data: {
          id: spec.runId,
          deploymentId: deployment.id,
          runNumber: (previous?.runNumber ?? 0) + 1,
          builderId,
          builderInstanceId: spec.profile.instanceId,
          specJson: json(parseBuildRunSpec(spec)),
          specHash: hashBuildSpec(spec),
          generation: lease.generation,
          ownershipEpoch: 1,
          logsExpireAt: new Date(Date.now() + 14 * 86400000),
        },
      });
    });
  }
  async markSending(lease: DeploymentLease, runId: string): Promise<BuildRun> {
    return this.checkpoint(lease, async (tx) => {
      const run = await tx.buildRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.deploymentId !== lease.deploymentId || run.executionClosedAt || run.cancelRequestedAt)
        throw new BuilderError('BUILD_EPOCH_STALE');
      return tx.buildRun.update({
        where: { id: run.id },
        data: {
          submissionAttemptedAt: run.submissionAttemptedAt ?? new Date(),
          executionState: 'open',
          nextReconcileAt: new Date(Date.now() + 5000),
        },
      });
    });
  }
  async acquire(runId: string): Promise<BuildReconcileLease | null> {
    return this.db.$transaction(async (tx) => {
      await assertWritable(tx);
      const initial = await tx.buildRun.findUnique({
        where: { id: runId },
        select: { deploymentId: true },
      });
      if (!initial) return null;
      await lockTask(tx, { type: 'deployment', id: initial.deploymentId });
      await tx.$queryRaw`SELECT id FROM "BuildRun" WHERE id=${runId}::uuid FOR UPDATE`;
      const run = await tx.buildRun.findUniqueOrThrow({ where: { id: runId } });
      if (run.reconcileLeaseExpiresAt && run.reconcileLeaseExpiresAt > new Date()) return null;
      const lease = { runId, token: randomUUID(), expiresAt: new Date(Date.now() + 25000) };
      await tx.buildRun.update({
        where: { id: runId },
        data: { reconcileLeaseToken: lease.token, reconcileLeaseExpiresAt: lease.expiresAt },
      });
      return lease;
    });
  }
  private async reconcileRow(tx: Prisma.TransactionClient, lease: BuildReconcileLease) {
    await assertWritable(tx);
    const initial = await tx.buildRun.findUniqueOrThrow({
      where: { id: lease.runId },
      select: { deploymentId: true },
    });
    await lockTask(tx, { type: 'deployment', id: initial.deploymentId });
    await tx.$queryRaw`SELECT id FROM "BuildRun" WHERE id=${lease.runId}::uuid FOR UPDATE`;
    const run = await tx.buildRun.findUniqueOrThrow({
      where: { id: lease.runId },
      include: { builder: true, deployment: true },
    });
    if (
      run.reconcileLeaseToken !== lease.token ||
      !run.reconcileLeaseExpiresAt ||
      run.reconcileLeaseExpiresAt <= new Date()
    )
      throw new TaskExecutionError('BUILD_RECONCILE_FENCE_LOST', '构建结束核对租约已失效。');
    return run;
  }
  async observe(
    runId: string,
    observation: BuildRunObservation,
    events?: BuildEventPage,
  ): Promise<boolean> {
    const lease = await this.acquire(runId);
    if (!lease) return false;
    try {
      await this.save(lease, observation, events);
      return true;
    } catch (error) {
      await this.unknown(
        lease,
        error instanceof BuilderError ? error.code : 'BUILD_OBSERVATION_UNKNOWN',
      );
      throw error;
    }
  }
  async save(
    lease: BuildReconcileLease,
    raw: BuildRunObservation,
    events?: BuildEventPage,
  ): Promise<void> {
    const observation = parseObservation(raw);
    await this.db.$transaction(async (tx) => {
      const row = await this.reconcileRow(tx, lease);
      await this.persistFacts(tx, row, observation, events);
    });
  }
  /** No ordinary work checkpoint: cancellation/expired task leases may still record signed closure. */
  private async persistFacts(
    tx: Prisma.TransactionClient,
    row: Prisma.BuildRunGetPayload<{ include: { builder: true; deployment: true } }>,
    observation: BuildRunObservation,
    events?: BuildEventPage,
  ): Promise<void> {
    const spec = parseBuildRunSpec(row.specJson);
    if (
      observation.runId !== row.id ||
      observation.specHash !== row.specHash ||
      observation.builderInstanceId !== row.builderInstanceId ||
      observation.installationId !== spec.installationId ||
      BigInt(observation.ledgerRevision) < row.remoteLedgerRevision
    )
      throw new BuilderError('BUILD_PROOF_INVALID');
    const remoteEpoch = row.remoteEpochJson ? parseEpoch(row.remoteEpochJson) : undefined;
    if (remoteEpoch && compareEpoch(observation.epoch, remoteEpoch) < 0)
      throw new BuilderError('BUILD_EPOCH_STALE');
    if (row.executionClosedAt) {
      if (
        !observation.proof ||
        canonicalJson(row.endProofJson) !== canonicalJson(observation.proof)
      )
        throw new BuilderError('BUILD_PROOF_INVALID');
    }
    const snapshot = readServiceSnapshot(row.deployment.snapshotJson);
    if (snapshot.version !== 3 || snapshot.source.revision.id !== row.deployment.sourceRevisionId)
      throw new BuilderError('BUILD_SPEC_INVALID');
    const artifact = observation.artifact;
    if (
      artifact &&
      (artifact.contentHash !== buildContentHash(spec) ||
        artifact.commitSha !== spec.source.commitSha ||
        artifact.recipeHash !== spec.source.recipeHash ||
        artifact.archive.builderInstanceId !== spec.profile.instanceId)
    )
      throw new BuilderError('BUILD_ARTIFACT_INVALID');
    const proof = observation.proof
      ? verifyEndProof(observation.proof, {
          spec,
          specHash: row.specHash,
          publicKey: row.builder.identityPublicKey,
          minimumEpoch: remoteEpoch,
          minimumLedgerRevision: row.remoteLedgerRevision.toString(),
          artifact,
        })
      : null;
    if (
      proof &&
      (proof.payload.ledgerRevision !== observation.ledgerRevision ||
        compareEpoch(proof.payload.epoch, observation.epoch) !== 0)
    )
      throw new BuilderError('BUILD_PROOF_INVALID');
    if (artifact) {
      const existing = await tx.buildArtifact.findUnique({ where: { id: artifact.id } });
      if (existing && canonicalJson(existing.descriptorJson) !== canonicalJson(artifact))
        throw new BuilderError('BUILD_ARTIFACT_INVALID');
      if (!existing) {
        if (artifact.producedByRunId !== row.id || spec.action !== 'build_and_push')
          throw new BuilderError('BUILD_ARTIFACT_INVALID');
        await tx.buildArtifact.create({
          data: {
            id: artifact.id,
            producedByRunId: row.id,
            sourceRevisionId: snapshot.source.revision.id,
            registryConnectionId: snapshot.source.revision.destination.registryConnectionId,
            commitSha: artifact.commitSha,
            recipeHash: artifact.recipeHash,
            specHash: row.specHash,
            descriptorJson: json(artifact),
            rootDigest: artifact.rootDigest,
            mediaType: artifact.rootMediaType,
            platformsJson: json(artifact.platforms),
            archiveHandle: artifact.archive.handle,
            builderInstanceId: artifact.archive.builderInstanceId,
            archiveSha256: artifact.archive.sha256,
            archiveBytes: BigInt(artifact.archive.bytes),
            archiveExpiresAt: new Date(artifact.archive.expiresAt),
            producedAt: new Date(artifact.producedAt),
            destinationJson: json(snapshot.source.revision.destination),
            locationState: 'oci',
            availability: 'available',
          },
        });
      }
      if (row.deployment.artifactId && row.deployment.artifactId !== artifact.id)
        throw new BuilderError('BUILD_ARTIFACT_INVALID');
      await tx.deployment.update({
        where: { id: row.deploymentId },
        data: { artifactId: artifact.id },
      });
      if (proof?.payload.pushReceipt) {
        if (proof.payload.artifactIdentityHash !== artifactIdentityHash(artifact))
          throw new BuilderError('BUILD_PROOF_INVALID');
        await tx.buildArtifact.update({
          where: { id: artifact.id },
          data: {
            locationState: 'registry',
            pushedAt: existing?.pushedAt ?? new Date(proof.payload.pushReceipt.confirmedAt),
            availability:
              existing?.availability === 'available' && existing.resolvedImageJson
                ? 'available'
                : 'unknown',
          },
        });
      }
    } else if (row.deployment.artifactId || spec.action === 'push_existing')
      throw new BuilderError('BUILD_ARTIFACT_INVALID');
    let afterSequence = row.afterSequence;
    let addedBytes = 0;
    let truncated = row.logsTruncated;
    if (events) {
      const global = await tx.buildLogChunk.aggregate({ _sum: { bytes: true } });
      for (const event of events.events) {
        if (BigInt(event.sequence) <= row.afterSequence) continue;
        // eslint-disable-next-line no-control-regex -- Persist only printable log text plus tabs/newlines.
        const content = event.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
        const bytes = Buffer.byteLength(content);
        if (
          bytes > 8192 ||
          row.logBytes + addedBytes + bytes > 8 * 1024 * 1024 ||
          (global._sum.bytes ?? 0) + addedBytes + bytes > 512 * 1024 * 1024
        ) {
          truncated = true;
          break;
        }
        await tx.buildLogChunk.upsert({
          where: { runId_sequence: { runId: row.id, sequence: BigInt(event.sequence) } },
          create: {
            runId: row.id,
            sequence: BigInt(event.sequence),
            phase: event.phase,
            timestamp: new Date(event.at),
            content,
            bytes,
            truncated: event.kind === 'truncated',
            expiresAt: row.logsExpireAt ?? new Date(Date.now() + 14 * 86400000),
          },
          update: {},
        });
        addedBytes += bytes;
        afterSequence = BigInt(event.sequence);
      }
      truncated ||= events.truncated;
    }
    const epoch =
      compareEpoch(observation.epoch, {
        generation: row.generation,
        ownershipEpoch: row.ownershipEpoch,
      }) > 0
        ? observation.epoch
        : { generation: row.generation, ownershipEpoch: row.ownershipEpoch };
    await tx.buildRun.update({
      where: { id: row.id },
      data: {
        ...epoch,
        remoteEpochJson: json(observation.epoch),
        remoteLedgerRevision: BigInt(observation.ledgerRevision),
        observedAt: new Date(),
        observationState: 'reachable',
        lastErrorCode: null,
        phase: observation.phase,
        ...(proof && !row.executionClosedAt
          ? {
              executionState: 'ended',
              executionClosedAt: new Date(proof.payload.endedAt),
              proofVerifiedAt: new Date(),
              endProofJson: json(proof),
            }
          : {}),
        afterSequence,
        logBytes: row.logBytes + addedBytes,
        logsTruncated: truncated,
        reconcileLeaseToken: null,
        reconcileLeaseExpiresAt: null,
        nextReconcileAt: new Date(Date.now() + 3000),
      },
    });
  }
  async unknown(lease: BuildReconcileLease, code: string): Promise<void> {
    await this.db
      .$transaction(async (tx) => {
        const row = await this.reconcileRow(tx, lease);
        await tx.buildRun.update({
          where: { id: row.id },
          data: {
            observationState: 'unknown',
            lastErrorCode: /^[A-Z0-9_]{1,80}$/u.test(code) ? code : 'BUILD_OBSERVATION_UNKNOWN',
            reconcileLeaseToken: null,
            reconcileLeaseExpiresAt: null,
            nextReconcileAt: new Date(Date.now() + 5000),
          },
        });
      })
      .catch(() => {});
  }
  async cancellationEpoch(lease: BuildReconcileLease, remote: BuildRunObservation | null) {
    return this.db.$transaction(async (tx) => {
      const row = await this.reconcileRow(tx, lease);
      const state = await assertWritable(tx);
      if (row.executionClosedAt)
        return { generation: row.generation, ownershipEpoch: row.ownershipEpoch };
      if (
        remote &&
        (remote.runId !== row.id ||
          remote.specHash !== row.specHash ||
          remote.builderInstanceId !== row.builderInstanceId ||
          BigInt(remote.ledgerRevision) < row.remoteLedgerRevision)
      )
        throw new BuilderError('BUILD_PROOF_INVALID');
      const minimum = remote?.epoch ?? {
        generation: row.generation,
        ownershipEpoch: row.ownershipEpoch,
      };
      if (state.generation < minimum.generation) throw new BuilderError('BUILD_EPOCH_STALE');
      const epoch = {
        generation: state.generation,
        ownershipEpoch: Math.max(row.ownershipEpoch, minimum.ownershipEpoch) + 1,
      };
      await tx.buildRun.update({
        where: { id: row.id },
        data: {
          ...epoch,
          ...(remote
            ? {
                remoteEpochJson: json(remote.epoch),
                remoteLedgerRevision: BigInt(remote.ledgerRevision),
              }
            : {}),
          cancelRequestedAt: row.cancelRequestedAt ?? new Date(),
        },
      });
      return epoch;
    });
  }
  async closeUnsubmitted(lease: BuildReconcileLease): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const row = await this.reconcileRow(tx, lease);
      if (row.submissionAttemptedAt || row.executionState !== 'prepared') return false;
      await tx.buildRun.update({
        where: { id: row.id },
        data: {
          executionState: 'never_submitted',
          executionClosedAt: new Date(),
          closureReason: row.deployment.cancelRequestedAt
            ? 'cancelled_before_submission'
            : 'rejected_before_submission',
          reconcileLeaseToken: null,
          reconcileLeaseExpiresAt: null,
        },
      });
      return true;
    });
  }
  /** Called only inside the explicit restore-unlock transaction after remote reads. */
  async applyRestoreProof(
    tx: Prisma.TransactionClient,
    runId: string,
    observation: BuildRunObservation,
  ): Promise<void> {
    if (!observation.proof || !(await readRecoveryState(tx)).restoreLocked)
      throw new BuilderError('BUILD_PROOF_INVALID');
    const initial = await tx.buildRun.findUniqueOrThrow({
      where: { id: runId },
      select: { deploymentId: true },
    });
    await lockTask(tx, { type: 'deployment', id: initial.deploymentId });
    await tx.$queryRaw`SELECT id FROM "BuildRun" WHERE id=${runId}::uuid FOR UPDATE`;
    const row = await tx.buildRun.findUniqueOrThrow({
      where: { id: runId },
      include: { builder: true, deployment: true },
    });
    await this.persistFacts(tx, row, observation);
  }
}
