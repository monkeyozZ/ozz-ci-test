import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { LogRedactor } from '@ozz/infrastructure/log-redaction';
import {
  BuilderError,
  artifactIdentityHash,
  buildContentHash,
  canonicalJson,
  compareEpoch,
  hashBuildSpec,
  inventoryRevision,
  inventoryCursor,
  challenge as parseChallenge,
  parseInstallationFence,
  parseCredentials,
  parseSubmit,
  parseCancel,
  signPayload,
  type BuilderClient,
  type BuilderIdentity,
  type BuildRunSpec,
  type BuildSubmit,
  type BuildRunObservation,
  type BuildCredentials,
  type BuildCancel,
  type RunEpoch,
  type OciArtifact,
  type TerminationEvidence,
  type EndDisposition,
  type BuildPhase,
  type CredentialPhase,
  type BuildEventPage,
  type BuildInstallationFence,
  type BuilderInventoryPage,
} from '@ozz/infrastructure/build';
import { FileBuildLedger, type LedgerRun } from './ledger.js';

export interface BuildExecutionDriver {
  preflight(): Promise<
    Omit<BuilderIdentity, 'version' | 'challenge' | 'instanceId' | 'checkedAt' | 'highGeneration'>
  >;
  prepare(spec: BuildRunSpec, leaseUntil: string): Promise<void>;
  renew(spec: BuildRunSpec, leaseUntil: string): Promise<void>;
  checkout(
    spec: BuildRunSpec,
    credentials: Extract<BuildCredentials, { phase: 'checkout' }>,
    output: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  solve(
    spec: BuildRunSpec,
    credentials: Extract<BuildCredentials, { phase: 'building' }>,
    output: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<OciArtifact>;
  artifact(spec: BuildRunSpec, artifact?: OciArtifact): Promise<OciArtifact | null>;
  push(
    spec: BuildRunSpec,
    artifact: OciArtifact,
    credentials: Extract<BuildCredentials, { phase: 'pushing' }>,
    output: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
  /** Must terminate the *whole* execution group and verify kernel evidence, including after a manager restart. */
  stop(spec: BuildRunSpec): Promise<TerminationEvidence>;
}
export interface BuildManagerOptions {
  installationId: string;
  instanceId: string;
  initialGeneration: number;
  signingPrivateKey: string;
  trustedCloneOrigins?: string[];
  maxLogBytes?: number;
  installationLogBytes?: number;
  logRetentionMs?: number;
  leaseMaxMs?: number;
}
function advance(record: LedgerRun): void {
  record.observation.ledgerRevision = (BigInt(record.observation.ledgerRevision) + 1n).toString();
}
/** One manager owns this ledger. systemd and the root launcher independently enforce that exclusivity. */
export class BuildManager implements BuilderClient {
  private readonly active = new Map<string, { abort: AbortController; work: Promise<void> }>();
  private readonly grants = new Map<string, BuildCredentials>();
  private capabilities: Awaited<ReturnType<BuildExecutionDriver['preflight']>> | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private stopping = false;
  private lastLogCleanup = 0;
  private readonly inventories = new Map<
    string,
    Omit<BuilderInventoryPage, 'offset' | 'nextCursor'>
  >();
  constructor(
    readonly ledger: FileBuildLedger,
    private readonly driver: BuildExecutionDriver,
    private readonly options: BuildManagerOptions,
  ) {}
  async start(): Promise<void> {
    await this.ledger.initialize(
      this.options.installationId,
      this.options.instanceId,
      this.options.initialGeneration,
    );
    this.capabilities = await this.driver.preflight();
    if (this.capabilities.profile.instanceId !== this.options.instanceId)
      throw new BuilderError('BUILD_IDENTITY_MISMATCH');
    await this.ledger.expireLogs();
    for (const record of this.ledger.open()) {
      // Crash recovery never trusts an empty in-memory process table or restarts old source.
      await this.end(record.observation.runId, {
        outcome: 'failed',
        phase: record.observation.phase,
        code: 'BUILD_MANAGER_RESTARTED',
        exitCode: null,
      });
    }
    this.watchdog = setInterval(() => {
      void this.tick().catch(() => {});
    }, 250);
    this.watchdog.unref();
  }
  async identity(challenge: string): ReturnType<BuilderClient['identity']> {
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(challenge) || !this.capabilities)
      throw new BuilderError('BUILD_PROTOCOL_INVALID');
    // Recheck actual kernel/launcher state instead of returning a configuration-only claim.
    const capability = await this.driver.preflight();
    return signPayload(
      {
        version: 1 as const,
        ...capability,
        instanceId: this.options.instanceId,
        challenge,
        highGeneration: this.ledger.highGeneration,
        checkedAt: new Date().toISOString(),
      },
      this.options.signingPrivateKey,
    );
  }
  async fence(raw: BuildInstallationFence): ReturnType<BuilderClient['fence']> {
    const request = parseInstallationFence(raw);
    if (
      request.installationId !== this.options.installationId ||
      request.builderInstanceId !== this.options.instanceId
    )
      throw new BuilderError('BUILD_IDENTITY_MISMATCH');
    return this.ledger.serial(async () => {
      if (this.stopping || !this.capabilities) throw new BuilderError('BUILD_UNAVAILABLE', true);
      const existing = this.ledger.fenceReceipt(request.requestId);
      if (existing) {
        const {
          version: _version,
          highGeneration: _generation,
          fencedAt: _at,
          ...original
        } = existing.payload;
        if (canonicalJson(original) !== canonicalJson(request))
          throw new BuilderError('BUILD_SPEC_CONFLICT');
        return existing;
      }
      if (request.generation < this.ledger.highGeneration)
        throw new BuilderError('BUILD_EPOCH_STALE');
      const receipt = signPayload(
        {
          version: 1 as const,
          ...request,
          highGeneration: request.generation,
          fencedAt: new Date().toISOString(),
        },
        this.options.signingPrivateKey,
      );
      await this.ledger.recordFence(receipt);
      return receipt;
    });
  }
  async inventory(challenge: string, cursor?: string): ReturnType<BuilderClient['inventory']> {
    parseChallenge(challenge);
    if (cursor !== undefined) inventoryCursor(cursor);
    return this.ledger.serial(async () => {
      const now = Date.now();
      for (const [id, snapshot] of this.inventories)
        if (Date.parse(snapshot.expiresAt) <= now) this.inventories.delete(id);
      let snapshot: Omit<BuilderInventoryPage, 'offset' | 'nextCursor'>;
      let offset = 0;
      if (cursor !== undefined) {
        const existing = this.inventories.get(cursor.slice(0, 36));
        if (!existing) throw new BuilderError('BUILD_INVENTORY_EXPIRED');
        if (existing.challenge !== challenge) throw new BuilderError('BUILD_PROOF_INVALID');
        snapshot = existing;
        offset = Number(cursor.slice(37));
        if (offset >= snapshot.totalRuns) throw new BuilderError('BUILD_PROTOCOL_INVALID');
      } else {
        const runs = this.ledger.index();
        if (runs.length > 100 && this.inventories.size >= 4)
          throw new BuilderError('BUILD_BUSY', true);
        if (
          runs.length +
            [...this.inventories.values()].reduce((sum, item) => sum + item.totalRuns, 0) >
          200000
        )
          throw new BuilderError('BUILD_BUSY', true);
        snapshot = {
          version: 1,
          installationId: this.options.installationId,
          builderInstanceId: this.options.instanceId,
          challenge,
          highGeneration: this.ledger.highGeneration,
          inventoryRevision: inventoryRevision(
            this.options.installationId,
            this.options.instanceId,
            this.ledger.highGeneration,
            runs,
          ),
          snapshotId: randomUUID(),
          expiresAt: new Date(now + 60000).toISOString(),
          totalRuns: runs.length,
          runs,
        };
        if (runs.length > 100) this.inventories.set(snapshot.snapshotId, snapshot);
      }
      const runs = snapshot.runs.slice(offset, offset + 100);
      return signPayload(
        {
          ...snapshot,
          offset,
          runs,
          nextCursor:
            offset + runs.length < snapshot.totalRuns
              ? `${snapshot.snapshotId}.${offset + runs.length}`
              : null,
        },
        this.options.signingPrivateKey,
      );
    });
  }
  private lease(spec: BuildRunSpec, value: string): string {
    const at = Date.parse(value);
    if (
      !Number.isFinite(at) ||
      at <= Date.now() ||
      at > Date.now() + (this.options.leaseMaxMs ?? 60000) ||
      at > Date.parse(spec.deadlineAt)
    )
      throw new BuilderError('BUILD_EPOCH_STALE');
    return value;
  }
  private validateSpec(spec: BuildRunSpec): void {
    const caps = this.capabilities;
    if (!caps || this.stopping) throw new BuilderError('BUILD_UNAVAILABLE', true);
    if (
      spec.installationId !== this.options.installationId ||
      spec.profile.instanceId !== this.options.instanceId ||
      canonicalJson(spec.profile) !== canonicalJson(caps.profile)
    )
      throw new BuilderError('BUILD_IDENTITY_MISMATCH');
    if (
      spec.source.platforms.length !== 1 ||
      spec.source.platforms[0]!.architecture !== caps.platform.architecture ||
      (spec.source.platforms[0]!.variant &&
        spec.source.platforms[0]!.variant !==
          (caps.platform.variant ?? (caps.platform.architecture === 'arm64' ? 'v8' : 'v1')))
    )
      throw new BuilderError('BUILD_SPEC_INVALID');
    for (const field of ['cpuMillis', 'memoryMiB', 'pids', 'timeoutSeconds'] as const)
      if (spec.limits[field] > caps.limits[field]) throw new BuilderError('BUILD_LIMIT_EXCEEDED');
    if (
      BigInt(spec.limits.diskBytes) > BigInt(caps.limits.diskBytes) ||
      Date.parse(spec.deadlineAt) <= Date.now() ||
      Date.parse(spec.deadlineAt) > Date.now() + spec.limits.timeoutSeconds * 1000 + 1000
    )
      throw new BuilderError('BUILD_LIMIT_EXCEEDED');
    if (
      spec.action === 'push_existing' &&
      (spec.artifact.contentHash !== buildContentHash(spec) ||
        spec.artifact.archive.builderInstanceId !== this.options.instanceId)
    )
      throw new BuilderError('BUILD_ARTIFACT_INVALID');
  }
  async submit(raw: BuildSubmit): Promise<BuildRunObservation> {
    const request = parseSubmit(raw);
    if (hashBuildSpec(request.spec) !== request.specHash)
      throw new BuilderError('BUILD_SPEC_CONFLICT');
    let created = false;
    const result = await this.ledger.serial(async () => {
      const existing = this.ledger.get(request.spec.runId);
      if (existing && existing.observation.specHash !== request.specHash)
        throw new BuilderError('BUILD_SPEC_CONFLICT');
      // A terminal proof belongs to the original epoch, even when a GET→takeover race occurred.
      if (existing?.observation.proof) return existing.observation;
      this.ledger.requireGeneration(request.epoch.generation);
      if (existing) {
        if (compareEpoch(request.epoch, existing.observation.epoch) < 0)
          throw new BuilderError('BUILD_EPOCH_STALE');
        existing.observation.epoch = request.epoch;
        existing.observation.leaseUntil = this.lease(request.spec, request.leaseUntil);
        advance(existing);
        await this.ledger.save(existing);
        await this.driver.renew(request.spec, existing.observation.leaseUntil);
        return existing.observation;
      }
      this.validateSpec(request.spec);
      if (this.ledger.open().length >= this.capabilities!.maxConcurrency)
        throw new BuilderError('BUILD_BUSY', true);
      created = true;
      const observation: BuildRunObservation = {
        version: 1,
        installationId: request.spec.installationId,
        builderInstanceId: this.options.instanceId,
        runId: request.spec.runId,
        specHash: request.specHash,
        epoch: request.epoch,
        ledgerRevision: '1',
        phase: request.spec.action === 'push_existing' ? 'pushing' : 'checkout',
        state: 'running',
        leaseUntil: this.lease(request.spec, request.leaseUntil),
        credentialRequest: null,
        artifact: request.spec.action === 'push_existing' ? request.spec.artifact : null,
        proof: null,
      };
      await this.ledger.save({
        version: 1,
        spec: request.spec,
        observation,
        started: { checkout: false, solve: false, uploader: false },
        cancelRequested: false,
        prepared: false,
        lastSequence: '0',
        logBytes: 0,
        truncated: false,
        logsExpireAt: new Date(
          Date.now() + (this.options.logRetentionMs ?? 14 * 86400000),
        ).toISOString(),
      });
      return observation;
    });
    if (created && result.state !== 'ended' && !this.active.has(result.runId)) {
      const abort = new AbortController();
      const entry = { abort, work: Promise.resolve() };
      this.active.set(result.runId, entry);
      entry.work = this.drive(result.runId, abort.signal)
        .catch(() => {
          // Failed termination remains visibly open; a later tick/restart retries trusted cleanup.
        })
        .finally(() => {
          if (this.active.get(result.runId) === entry) this.active.delete(result.runId);
        });
    }
    return result;
  }
  async get(runId: string): Promise<BuildRunObservation | null> {
    return this.ledger.get(runId)?.observation ?? null;
  }
  private current(runId: string, specHash: string, epoch: RunEpoch): LedgerRun {
    const record = this.ledger.get(runId);
    if (!record) throw new BuilderError('BUILD_RUN_UNKNOWN');
    if (record.observation.specHash !== specHash) throw new BuilderError('BUILD_SPEC_CONFLICT');
    if (
      !record.observation.proof &&
      (epoch.generation !== this.ledger.highGeneration ||
        compareEpoch(epoch, record.observation.epoch) !== 0)
    )
      throw new BuilderError('BUILD_EPOCH_STALE');
    return record;
  }
  async renew(
    runId: string,
    request: { specHash: string; epoch: RunEpoch; leaseUntil: string },
  ): Promise<BuildRunObservation> {
    return this.ledger.serial(async () => {
      const record = this.current(runId, request.specHash, request.epoch);
      if (record.observation.proof) return record.observation;
      record.observation.leaseUntil = this.lease(record.spec!, request.leaseUntil);
      advance(record);
      await this.ledger.save(record);
      await this.driver.renew(record.spec!, record.observation.leaseUntil);
      return record.observation;
    });
  }
  async credentials(runId: string, raw: BuildCredentials): Promise<BuildRunObservation> {
    const grant = parseCredentials(raw);
    return this.ledger.serial(async () => {
      const record = this.current(runId, grant.specHash, grant.epoch);
      if (record.observation.proof) return record.observation;
      const request = record.observation.credentialRequest;
      if (
        record.cancelRequested ||
        !request ||
        request.phase !== grant.phase ||
        request.nonce !== grant.nonce ||
        Date.parse(grant.expiresAt) <= Date.now() ||
        Date.parse(grant.expiresAt) > Date.now() + 120000 ||
        Date.parse(grant.expiresAt) > Date.parse(record.spec!.deadlineAt)
      )
        throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
      const spec = record.spec!;
      if (
        grant.phase === 'checkout' &&
        (grant.githubRepositoryId !== spec.source.githubRepositoryId ||
          grant.commitSha !== spec.source.commitSha ||
          !(this.options.trustedCloneOrigins ?? ['https://github.com']).includes(
            new URL(grant.cloneUrl).origin,
          ))
      )
        throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
      if (
        grant.phase === 'pushing' &&
        (grant.authority !== spec.destination.authority || !record.observation.artifact)
      )
        throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
      if (
        grant.phase === 'building' &&
        canonicalJson(
          grant.secrets
            .map(({ mountId, version }) => ({ mountId, version }))
            .sort((a, b) => a.mountId.localeCompare(b.mountId)),
        ) !==
          canonicalJson(
            [...spec.source.buildSecrets].sort((a, b) => a.mountId.localeCompare(b.mountId)),
          )
      )
        throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
      if (this.grants.has(runId)) throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
      this.grants.set(runId, grant);
      return record.observation;
    });
  }
  async cancel(runId: string, raw: BuildCancel): Promise<BuildRunObservation> {
    const request = parseCancel(raw);
    const result = await this.ledger.serial(async () => {
      let record = this.ledger.get(runId);
      if (
        record?.observation.specHash !== undefined &&
        record.observation.specHash !== request.specHash
      )
        throw new BuilderError('BUILD_SPEC_CONFLICT');
      if (record?.observation.proof) return record.observation;
      this.ledger.requireGeneration(request.epoch.generation);
      if (record && compareEpoch(request.epoch, record.observation.epoch) < 0)
        throw new BuilderError('BUILD_EPOCH_STALE');
      if (!record) {
        const now = new Date().toISOString();
        record = {
          version: 1,
          spec: null,
          observation: {
            version: 1,
            installationId: this.options.installationId,
            builderInstanceId: this.options.instanceId,
            runId,
            specHash: request.specHash,
            epoch: request.epoch,
            ledgerRevision: '1',
            phase: 'checkout',
            state: 'cancelling',
            leaseUntil: now,
            credentialRequest: null,
            artifact: null,
            proof: null,
          },
          started: { checkout: false, solve: false, uploader: false },
          cancelRequested: true,
          prepared: false,
          lastSequence: '0',
          logBytes: 0,
          truncated: false,
          logsExpireAt: now,
        };
      }
      record.cancelRequested = true;
      record.observation.epoch = request.epoch;
      record.observation.state = 'cancelling';
      record.observation.credentialRequest = null;
      advance(record);
      await this.ledger.save(record);
      return record.observation;
    });
    this.grants.delete(runId);
    this.active.get(runId)?.abort.abort();
    if (!this.active.has(runId) && result.state !== 'ended')
      await this.end(runId, { outcome: 'cancelled' });
    return (await this.get(runId))!;
  }
  private async need(
    runId: string,
    phase: CredentialPhase,
    signal: AbortSignal,
  ): Promise<BuildCredentials> {
    await this.ledger.serial(async () => {
      const record = this.ledger.get(runId)!;
      this.ledger.requireGeneration(record.observation.epoch.generation);
      if (record.cancelRequested || record.observation.proof || signal.aborted)
        throw new BuilderError('BUILD_TRANSPORT_CANCELLED');
      record.observation.phase = phase;
      record.observation.state = 'awaiting_credentials';
      record.observation.credentialRequest = { phase, nonce: randomUUID() };
      advance(record);
      await this.ledger.save(record);
    });
    for (;;) {
      if (signal.aborted) throw new BuilderError('BUILD_TRANSPORT_CANCELLED');
      const grant = this.grants.get(runId);
      if (grant) {
        this.grants.delete(runId);
        await this.ledger.serial(async () => {
          const record = this.ledger.get(runId)!;
          if (
            record.cancelRequested ||
            grant.epoch.generation !== this.ledger.highGeneration ||
            compareEpoch(grant.epoch, record.observation.epoch) !== 0 ||
            Date.parse(grant.expiresAt) <= Date.now()
          )
            throw new BuilderError('BUILD_CREDENTIALS_REJECTED');
          record.observation.state = 'running';
          record.observation.credentialRequest = null;
          record.started[
            phase === 'checkout' ? 'checkout' : phase === 'building' ? 'solve' : 'uploader'
          ] = true;
          advance(record);
          await this.ledger.save(record);
        });
        return grant;
      }
      await delay(50, undefined, { signal });
    }
  }
  private async runPhase<T>(
    runId: string,
    phase: CredentialPhase,
    signal: AbortSignal,
    work: (grant: BuildCredentials, output: (text: string) => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const grant = await this.need(runId, phase, signal);
    const secrets =
      grant.phase === 'checkout'
        ? [grant.token, Buffer.from(`x-access-token:${grant.token}`).toString('base64')]
        : grant.phase === 'pushing'
          ? [grant.password, Buffer.from(`${grant.username}:${grant.password}`).toString('base64')]
          : grant.secrets.map((secret) => secret.value);
    const redactor = new LogRedactor(secrets);
    try {
      const result = await work(grant, async (value) => {
        const text = redactor.push(value);
        if (text) await this.output(runId, phase, text);
      });
      if (!signal.aborted) {
        const tail = redactor.push('', true);
        if (tail) await this.output(runId, phase, tail);
      }
      return result;
    } catch (error) {
      if (!signal.aborted) {
        try {
          const tail = redactor.push('', true);
          if (tail) await this.output(runId, phase, tail);
        } catch {
          // A failed log append must not replace the phase's original failure.
        }
      }
      throw error;
    } finally {
      redactor.clear();
    }
  }
  private async drive(runId: string, signal: AbortSignal): Promise<void> {
    let disposition: EndDisposition = { outcome: 'succeeded' };
    try {
      const record = this.ledger.get(runId)!;
      const spec = record.spec!;
      await this.driver.prepare(spec, record.observation.leaseUntil);
      await this.ledger.serial(async () => {
        const current = this.ledger.get(runId)!;
        current.prepared = true;
        advance(current);
        await this.ledger.save(current);
      });
      if (spec.action === 'build_and_push') {
        await this.runPhase(runId, 'checkout', signal, (grant, output) =>
          this.driver.checkout(
            spec,
            grant as Extract<BuildCredentials, { phase: 'checkout' }>,
            output,
            signal,
          ),
        );
        const artifact = await this.runPhase(runId, 'building', signal, (grant, output) =>
          this.driver.solve(
            spec,
            grant as Extract<BuildCredentials, { phase: 'building' }>,
            output,
            signal,
          ),
        );
        if (artifact.contentHash !== buildContentHash(spec) || artifact.producedByRunId !== runId)
          throw new BuilderError('BUILD_ARTIFACT_INVALID');
        await this.ledger.serial(async () => {
          const current = this.ledger.get(runId)!;
          current.observation.artifact = artifact;
          current.observation.phase = 'exporting';
          advance(current);
          await this.ledger.save(current);
        });
      }
      const artifact = await this.driver.artifact(
        spec,
        this.ledger.get(runId)!.observation.artifact ?? undefined,
      );
      if (!artifact) throw new BuilderError('BUILD_ARTIFACT_MISSING');
      await this.runPhase(runId, 'pushing', signal, (grant, output) =>
        this.driver.push(
          spec,
          artifact,
          grant as Extract<BuildCredentials, { phase: 'pushing' }>,
          output,
          signal,
        ),
      );
    } catch (error) {
      const record = this.ledger.get(runId)!;
      disposition = record.cancelRequested
        ? { outcome: 'cancelled' }
        : Date.now() >= Date.parse(record.spec!.deadlineAt)
          ? { outcome: 'timed_out', phase: record.observation.phase }
          : {
              outcome: 'failed',
              phase: record.observation.phase,
              code: error instanceof BuilderError ? error.code : 'BUILD_EXECUTION_INTERRUPTED',
              exitCode: null,
            };
    }
    await this.end(runId, disposition);
  }
  private async end(runId: string, disposition: EndDisposition): Promise<void> {
    await this.ledger.serial(async () => {
      const record = this.ledger.get(runId);
      if (!record || record.observation.proof) return;
      // Serialize the host close and proof with renew/takeover/grants. Once the
      // host is closed, none may try to renew it before its proof is durable.
      // stop remains mandatory even when a preparation/phase response was lost.
      const evidence = record.spec
        ? await this.driver.stop(record.spec)
        : { kind: 'never_started' as const };
      const recoveredArtifact = record.spec
        ? await this.driver.artifact(record.spec, record.observation.artifact ?? undefined)
        : null;
      if (recoveredArtifact && !record.observation.artifact)
        record.observation.artifact = recoveredArtifact;
      const artifact = record.observation.artifact;
      advance(record);
      const at = new Date().toISOString();
      record.observation.proof = signPayload(
        {
          version: 1,
          installationId: record.observation.installationId,
          builderInstanceId: this.options.instanceId,
          runId,
          specHash: record.observation.specHash,
          epoch: record.observation.epoch,
          ledgerRevision: record.observation.ledgerRevision,
          endedAt: at,
          disposition,
          processes: {
            checkout: record.started.checkout ? 'terminated' : 'never_started',
            solve: record.started.solve ? 'terminated' : 'never_started',
            uploader: record.started.uploader ? 'terminated' : 'never_started',
          },
          executionClosed: true,
          cancelTombstone: record.cancelRequested,
          terminationEvidence: evidence,
          artifactIdentityHash: artifact ? artifactIdentityHash(artifact) : null,
          pushReceipt:
            disposition.outcome === 'succeeded' && artifact
              ? {
                  destination: record.spec!.destination,
                  rootDigest: artifact.rootDigest,
                  confirmedAt: at,
                }
              : null,
        },
        this.options.signingPrivateKey,
      );
      record.observation.state = 'ended';
      record.observation.credentialRequest = null;
      await this.ledger.save(record);
    });
  }
  private async output(runId: string, phase: BuildPhase, text: string): Promise<void> {
    // Strip terminal escape sequences first, then non-text control characters.
    text = text
      // eslint-disable-next-line no-control-regex -- Escape bytes identify terminal control sequences.
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
      // eslint-disable-next-line no-control-regex -- Raw control bytes are deliberately removed from logs.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, '');
    await this.ledger.serial(async () => {
      const record = this.ledger.get(runId)!;
      if (record.truncated || Date.now() >= Date.parse(record.logsExpireAt)) return;
      const remaining = Math.min(
        (this.options.maxLogBytes ?? 8 * 1024 * 1024) - record.logBytes,
        (this.options.installationLogBytes ?? 512 * 1024 * 1024) - this.ledger.totalLogBytes,
      );
      const raw = Buffer.from(text);
      const allowed = Math.max(0, Math.min(raw.length, remaining));
      const events: import('@ozz/infrastructure/build').BuildEvent[] = [];
      for (let start = 0; start < allowed;) {
        let end = Math.min(start + 8000, allowed);
        // Never split a UTF-8 code point: replacement characters would inflate the byte quota.
        while (end > start && end < raw.length && (raw[end]! & 0xc0) === 0x80) end--;
        if (end === start) break;
        const chunk = raw.subarray(start, end).toString('utf8');
        record.lastSequence = (BigInt(record.lastSequence) + 1n).toString();
        events.push({
          sequence: record.lastSequence,
          phase,
          at: new Date().toISOString(),
          kind: 'output',
          text: chunk,
        });
        record.logBytes += end - start;
        start = end;
      }
      if (allowed < raw.length) {
        record.truncated = true;
        record.lastSequence = (BigInt(record.lastSequence) + 1n).toString();
        events.push({
          sequence: record.lastSequence,
          phase,
          at: new Date().toISOString(),
          kind: 'truncated',
          text: 'Build output limit reached.',
        });
      }
      await this.ledger.appendEvents(record, events);
    });
  }
  async events(runId: string, after: string): Promise<BuildEventPage> {
    return this.ledger.eventPage(runId, after);
  }
  private async tick(): Promise<void> {
    if (Date.now() - this.lastLogCleanup > 60000) {
      this.lastLogCleanup = Date.now();
      await this.ledger.serial(() => this.ledger.expireLogs());
    }
    for (const record of this.ledger.open()) {
      if (
        record.cancelRequested ||
        Date.now() >= Date.parse(record.observation.leaseUntil) ||
        Date.now() >= Date.parse(record.spec?.deadlineAt ?? record.observation.leaseUntil)
      ) {
        const running = this.active.get(record.observation.runId);
        running?.abort.abort();
        if (!running)
          await this.end(
            record.observation.runId,
            record.cancelRequested
              ? { outcome: 'cancelled' }
              : { outcome: 'timed_out', phase: record.observation.phase },
          );
      }
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.watchdog) clearInterval(this.watchdog);
    for (const active of this.active.values()) active.abort.abort();
    await Promise.allSettled([...this.active.values()].map((active) => active.work));
  }
}
