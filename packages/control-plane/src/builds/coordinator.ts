import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma } from '@ozz/database';
import {
  BuilderError,
  parseArtifact,
  parseBuildRunSpec,
  verifySigned,
  canonicalJson,
  type BuildLimits,
  type BuildRunSpec,
  type BuilderClient,
  type BuilderTlsConnection,
  type BuildRunObservation,
  type BuildCredentials,
} from '@ozz/infrastructure/build';
import { GitHubAdapter, type GitHubClient } from '@ozz/infrastructure/github';
import {
  RegistryAdapter,
  RegistryAdapterError,
  type ImagePlatform,
  type RegistryImageResolver,
  type ResolvedImage,
} from '@ozz/infrastructure/registry';
import type { SecretCipher } from '../secrets.js';
import type { GitSourceSnapshot } from '../git/contracts.js';
import { currentGitCredential } from '../integrations/persistence.js';
import { TaskRepository, type DeploymentLease } from '../tasks/repository.js';
import { TaskExecutionError } from '../tasks/contracts.js';
import { currentBuilderAccess, fixedRegistryCredential } from './access.js';
import { BuildRepository } from './repository.js';

export interface BuildCoordinatorOptions {
  github?: GitHubClient;
  clientFactory?: (connection: BuilderTlsConnection) => BuilderClient;
  limits?: BuildLimits;
  pollMs?: number;
}
export class BuildCoordinator {
  readonly records: BuildRepository;
  private readonly github: GitHubClient;
  constructor(
    readonly tasks: TaskRepository,
    private readonly cipher: SecretCipher,
    private readonly registry: RegistryImageResolver = new RegistryAdapter(),
    readonly options: BuildCoordinatorOptions = {},
  ) {
    this.records = new BuildRepository(tasks);
    this.github = options.github ?? new GitHubAdapter();
  }
  async ensureArtifact(
    lease: DeploymentLease,
    source: GitSourceSnapshot,
    platforms: readonly ImagePlatform[],
    signal: AbortSignal,
  ): Promise<{
    artifactId: string;
    image: ResolvedImage;
    fixedDestination: GitSourceSnapshot['revision']['destination'];
  }> {
    const snapshot = source.revision;
    if (
      platforms.some(
        (required) =>
          !snapshot.platforms.some(
            (platform) =>
              platform.os === required.os && platform.architecture === required.architecture,
          ),
      )
    )
      throw new TaskExecutionError(
        'BUILD_PLATFORM_FIXED',
        '原构建平台不包含当前目标节点架构；请审阅新的来源配置。',
      );
    const deployment = await this.records.checkpoint(lease, (tx) =>
      tx.deployment.findUniqueOrThrow({ where: { id: lease.deploymentId } }),
    );
    if (deployment.sourceRevisionId !== snapshot.id) throw new BuilderError('BUILD_SPEC_INVALID');
    let artifact = deployment.artifactId
      ? await this.tasks.db.buildArtifact.findUniqueOrThrow({
          where: { id: deployment.artifactId },
        })
      : null;
    if (!artifact || artifact.locationState === 'oci') {
      if (
        artifact &&
        (artifact.availability === 'missing' || artifact.archiveExpiresAt <= new Date())
      ) {
        await this.records.checkpoint(lease, (tx) =>
          tx.buildArtifact.update({
            where: { id: artifact!.id },
            data: {
              availability: artifact!.archiveExpiresAt <= new Date() ? 'expired' : 'missing',
            },
          }),
        );
        throw new TaskExecutionError(
          'BUILD_ARTIFACT_MISSING',
          '原 OCI 构建产物已丢失或到期，重试不会重新构建。',
        );
      }
      const access = await this.records.checkpoint(lease, (tx) =>
        currentBuilderAccess(
          tx,
          this.cipher,
          snapshot.builder.builderId,
          snapshot.builder.instanceId,
          this.options.clientFactory,
        ),
      );
      if (!access.builder.enabled) throw new BuilderError('BUILD_UNAVAILABLE');
      const challenge = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
      const identity = verifySigned(
        await access.client.identity(challenge, signal),
        access.builder.identityPublicKey,
      );
      if (
        identity.challenge !== challenge ||
        identity.instanceId !== snapshot.builder.instanceId ||
        identity.profile.instanceId !== snapshot.builder.instanceId ||
        identity.profile.profileRevision !== snapshot.builder.profileRevision ||
        identity.profile.buildkitVersion !== snapshot.builder.buildkitVersion ||
        identity.profile.frontendDigest !== snapshot.builder.frontendDigest ||
        Math.abs(Date.now() - Date.parse(identity.checkedAt)) > 60000
      )
        throw new BuilderError('BUILD_IDENTITY_MISMATCH');
      if (identity.highGeneration !== lease.generation)
        throw new TaskExecutionError(
          'BUILD_EPOCH_STALE',
          'Builder 隔离代际与当前控制面不同，请先完成受控恢复核对。',
        );
      const limits = this.options.limits ?? identity.limits;
      const profile = {
        instanceId: snapshot.builder.instanceId,
        profileRevision: snapshot.builder.profileRevision,
        buildkitVersion: snapshot.builder.buildkitVersion,
        frontendDigest: snapshot.builder.frontendDigest,
      };
      const spec: BuildRunSpec = parseBuildRunSpec({
        version: 1,
        installationId: (deployment.targetJson as { installationId: string }).installationId,
        runId: randomUUID(),
        deploymentId: deployment.id,
        source: {
          githubRepositoryId: snapshot.repository.githubRepositoryId,
          commitSha: source.commitSha,
          recipeHash: snapshot.recipeHash,
          dockerfilePath: snapshot.dockerfilePath,
          contextPath: snapshot.contextPath,
          buildArgs: snapshot.buildArgs,
          buildSecrets: snapshot.buildSecrets.map((secret) => ({
            mountId: secret.mountId,
            version: `${secret.secretRefId}:${secret.contentRevision}:${secret.secretKey}`,
          })),
          platforms: snapshot.platforms,
        },
        profile,
        destination: {
          authority: snapshot.destination.authority,
          repository: snapshot.destination.repository,
        },
        limits,
        deadlineAt: new Date(Date.now() + limits.timeoutSeconds * 1000).toISOString(),
        ...(artifact
          ? { action: 'push_existing', artifact: parseArtifact(artifact.descriptorJson) }
          : { action: 'build_and_push' }),
      });
      const prepared = await this.records.prepare(lease, spec, snapshot.builder.builderId);
      const run = await this.records.markSending(lease, prepared.id);
      let observation = await access.client.submit(
        {
          spec,
          specHash: run.specHash,
          epoch: { generation: run.generation, ownershipEpoch: run.ownershipEpoch },
          leaseUntil: new Date(
            Math.min(Date.now() + 30000, Date.parse(spec.deadlineAt)),
          ).toISOString(),
        },
        signal,
      );
      let grantedNonce: string | null = null;
      let recordedPhase: string | null = null;
      for (;;) {
        let events: import('@ozz/infrastructure/build').BuildEventPage | undefined;
        try {
          const logAccess = await this.records.checkpoint(lease, (tx) =>
            currentBuilderAccess(
              tx,
              this.cipher,
              snapshot.builder.builderId,
              snapshot.builder.instanceId,
              this.options.clientFactory,
            ),
          );
          events = await logAccess.client.events(
            run.id,
            (
              await this.tasks.db.buildRun.findUniqueOrThrow({
                where: { id: run.id },
                select: { afterSequence: true },
              })
            ).afterSequence.toString(),
            signal,
          );
        } catch {
          /* Log availability cannot prevent recording an already obtained closure proof. */
        }
        const saved = await this.records.observe(run.id, observation, events);
        if (saved && recordedPhase !== observation.phase) {
          await this.stage(lease, observation.phase);
          recordedPhase = observation.phase;
        }
        if (observation.proof && saved) {
          const disposition = observation.proof.payload.disposition;
          if (disposition.outcome !== 'succeeded')
            throw new TaskExecutionError(
              disposition.outcome === 'failed'
                ? disposition.code
                : disposition.outcome === 'cancelled'
                  ? 'BUILD_CANCELLED'
                  : 'BUILD_TIMED_OUT',
              '远端构建已结束，请查看构建阶段与日志。',
              disposition.outcome === 'failed' && disposition.phase === 'pushing',
            );
          break;
        }
        // New auth is resolved before each actual use. No source/destination identity is refreshed.
        const current = await this.records.checkpoint(lease, (tx) =>
          currentBuilderAccess(
            tx,
            this.cipher,
            snapshot.builder.builderId,
            snapshot.builder.instanceId,
            this.options.clientFactory,
          ),
        );

        try {
          if (
            observation.credentialRequest &&
            observation.credentialRequest.nonce !== grantedNonce
          ) {
            const grant = await this.credentials(lease, source, observation, signal);
            observation = await current.client.credentials(run.id, grant, signal);
            grantedNonce = grant.nonce;
            if (observation.proof) continue;
          }
          const leaseUntil = new Date(
            Math.min(Date.now() + 30000, Date.parse(spec.deadlineAt)),
          ).toISOString();
          if (Date.parse(leaseUntil) <= Date.now())
            throw new TaskExecutionError(
              'BUILD_DEADLINE_REACHED',
              '已达到原构建期限，正在等待远端停止证明。',
              true,
            );
          observation = await current.client.renew(
            run.id,
            { specHash: run.specHash, epoch: observation.epoch, leaseUntil },
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          // A response can be lost while the same run finishes. Read its proof
          // before abandoning the task lease; never submit or grant again here.
          const ended = await this.readClosure(current.client, run.id, signal);
          if (!ended) throw error;
          observation = ended;
        }
        if (observation.proof) continue;
        await delay(this.options.pollMs ?? 500, undefined, { signal });
        const next = await current.client.get(run.id, signal);
        if (!next) throw new BuilderError('BUILD_RUN_UNKNOWN');
        observation = next;
      }
      const current = await this.tasks.db.deployment.findUniqueOrThrow({
        where: { id: deployment.id },
      });
      artifact = current.artifactId
        ? await this.tasks.db.buildArtifact.findUniqueOrThrow({ where: { id: current.artifactId } })
        : null;
    }
    if (!artifact || artifact.locationState !== 'registry')
      throw new BuilderError('BUILD_ARTIFACT_MISSING');
    if (
      artifact.sourceRevisionId !== snapshot.id ||
      artifact.registryConnectionId !== snapshot.destination.registryConnectionId ||
      canonicalJson(artifact.destinationJson) !== canonicalJson(snapshot.destination)
    )
      throw new BuilderError('BUILD_IDENTITY_MISMATCH');
    const pull = await this.records.checkpoint(lease, (tx) =>
      fixedRegistryCredential(tx, this.cipher, snapshot.destination, 'pull'),
    );
    let image: ResolvedImage;
    try {
      image = artifact.resolvedImageJson
        ? await this.registry.verify(artifact.resolvedImageJson as unknown as ResolvedImage, {
            platforms,
            access: pull.access,
            signal,
          })
        : await this.registry.resolve(
            `${snapshot.destination.authority}/${snapshot.destination.repository}@${artifact.rootDigest}`,
            { platforms, access: pull.access, signal },
          );
      if (image.manifestDigest !== artifact.rootDigest)
        throw new BuilderError('BUILD_ARTIFACT_INVALID');
    } catch (error) {
      const missing =
        error instanceof RegistryAdapterError && error.code === 'REGISTRY_IMAGE_NOT_FOUND';
      await this.records.checkpoint(lease, (tx) =>
        tx.buildArtifact.update({
          where: { id: artifact!.id },
          data: { availability: missing ? 'missing' : 'unknown' },
        }),
      );
      if (missing)
        throw new TaskExecutionError(
          'BUILD_ARTIFACT_MISSING',
          '原 Registry 摘要不存在，重试不会重新构建或自动重新推送。',
        );
      throw error;
    }
    await this.records.checkpoint(lease, (tx) =>
      tx.buildArtifact.update({
        where: { id: artifact!.id },
        data: {
          resolvedImageJson: image as unknown as Prisma.InputJsonValue,
          availability: 'available',
          lastVerifiedAt: new Date(),
        },
      }),
    );
    return { artifactId: artifact.id, image, fixedDestination: snapshot.destination };
  }
  private async readClosure(
    client: BuilderClient,
    runId: string,
    signal: AbortSignal,
  ): Promise<BuildRunObservation | null> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    try {
      while (!bounded.aborted) {
        const observation = await client.get(runId, bounded);
        if (observation?.proof) return observation;
        await delay(Math.min(this.options.pollMs ?? 250, 250), undefined, { signal: bounded });
      }
    } catch {
      // Unavailable/invalid observations never establish termination or release a slot.
    }
    return null;
  }
  private async stage(lease: DeploymentLease, name: string): Promise<void> {
    await this.records.checkpoint(lease, async (tx) => {
      await tx.deploymentStage.updateMany({
        where: {
          deploymentId: lease.deploymentId,
          attempt: lease.attempt,
          status: 'running',
          name: { not: name },
        },
        data: { status: 'succeeded', finishedAt: new Date() },
      });
      await tx.deploymentStage.upsert({
        where: {
          deploymentId_attempt_name: {
            deploymentId: lease.deploymentId,
            attempt: lease.attempt,
            name,
          },
        },
        create: {
          deploymentId: lease.deploymentId,
          attempt: lease.attempt,
          name,
          status: 'running',
          startedAt: new Date(),
        },
        update: { status: 'running', finishedAt: null, errorCode: null },
      });
      await tx.deployment.update({ where: { id: lease.deploymentId }, data: { phase: name } });
    });
  }
  private async credentials(
    lease: DeploymentLease,
    source: GitSourceSnapshot,
    observation: BuildRunObservation,
    signal: AbortSignal,
  ): Promise<BuildCredentials> {
    const request = observation.credentialRequest!;
    const row = await this.tasks.db.buildRun.findUniqueOrThrow({
      where: { id: observation.runId },
      select: { specJson: true },
    });
    const base = {
      specHash: observation.specHash,
      epoch: observation.epoch,
      nonce: request.nonce,
      expiresAt: new Date(
        Math.min(Date.now() + 60000, Date.parse(parseBuildRunSpec(row.specJson).deadlineAt)),
      ).toISOString(),
    };
    if (request.phase === 'checkout') {
      const current = await this.records.checkpoint(lease, (tx) =>
        currentGitCredential(tx, this.cipher, source.revision.githubConnectionId, 'build_checkout'),
      );
      const grant = await this.github.checkout(
        current.token,
        source.revision.repository.githubRepositoryId,
        source.commitSha,
        signal,
      );
      // Recheck cancellation after the network authorization read, before handing any credential out.
      await this.records.checkpoint(lease, async () => {});
      return { ...base, phase: 'checkout', ...grant, token: current.token };
    }
    if (request.phase === 'pushing') {
      const current = await this.records.checkpoint(lease, (tx) =>
        fixedRegistryCredential(tx, this.cipher, source.revision.destination, 'push'),
      );
      const payload = current.payload;
      if (typeof payload.username !== 'string' || typeof payload.password !== 'string')
        throw new BuilderError('BUILD_AUTH_INVALID');
      return {
        ...base,
        phase: 'pushing',
        authority: source.revision.destination.authority,
        username: payload.username,
        password: payload.password,
        ...(typeof payload.caCertificate === 'string'
          ? { caCertificate: payload.caCertificate }
          : {}),
        ...(Array.isArray(payload.tokenServiceOrigins)
          ? { tokenServiceOrigins: payload.tokenServiceOrigins as string[] }
          : {}),
      };
    }
    const secrets = await this.records.checkpoint(lease, async (tx) => {
      const values = [];
      for (const fixed of source.revision.buildSecrets) {
        const secret = await tx.secretReference.findUnique({ where: { id: fixed.secretRefId } });
        if (
          !secret ||
          secret.kind !== 'generic' ||
          secret.contentRevision !== fixed.contentRevision ||
          (secret.expiresAt && secret.expiresAt <= new Date())
        )
          throw new TaskExecutionError(
            'BUILD_SECRET_VERSION_UNAVAILABLE',
            '原构建秘密版本不可用，任务不能改用新内容。',
          );
        const value = this.cipher.decrypt(secret)[fixed.secretKey];
        if (typeof value !== 'string') throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
        values.push({
          mountId: fixed.mountId,
          version: `${fixed.secretRefId}:${fixed.contentRevision}:${fixed.secretKey}`,
          value,
        });
      }
      await tx.auditEvent.create({
        data: {
          action: 'build.secret_used',
          resourceType: 'deployment',
          resourceId: lease.deploymentId,
          outcome: 'resolved',
          metadata: {
            references: source.revision.buildSecrets.map(({ secretRefId, contentRevision }) => ({
              secretRefId,
              contentRevision,
            })),
          },
        },
      });
      return values;
    });
    return { ...base, phase: 'building', secrets };
  }
}
