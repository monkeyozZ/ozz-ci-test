import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BuilderError as DriverError } from '../../packages/infrastructure/dist/build.js';
import {
  BuilderError,
  hashBuildSpec,
  verifyEndProof,
  verifySigned,
  verifyInventoryPages,
  type BuildCredentials,
  type BuildRunSpec,
  type OciArtifact,
  type TerminationEvidence,
} from '../../packages/infrastructure/src/build.js';
import { BuildManager, type BuildExecutionDriver } from '../../apps/builder/src/manager.js';
import { FileBuildLedger } from '../../apps/builder/src/ledger.js';
import { buildSpec, ociArtifact } from '../infrastructure/build-fixture.js';

/** Controlled faults exercise the real manager/ledger. They do not claim Linux isolation. */
class FaultDriver implements BuildExecutionDriver {
  prepared = 0;
  solves = 0;
  pushes = 0;
  stops = 0;
  canTerminate = true;
  readFailure = false;
  pushFailure = false;
  artifacts = new Map<string, OciArtifact>();
  outputChunks: string[] = [];
  constructor(readonly spec: BuildRunSpec) {}
  async preflight() {
    return {
      profile: this.spec.profile,
      platform: this.spec.source.platforms[0]!,
      limits: this.spec.limits,
      maxConcurrency: 1,
      isolation: {
        rootless: true as const,
        processSandbox: true as const,
        separateUids: true as const,
        cgroupV2: true as const,
        hardDiskQuota: true as const,
        egressPolicy: true as const,
        independentWatchdog: true as const,
      },
    };
  }
  async prepare() {
    this.prepared += 1;
  }
  async renew() {
    /* Fault fixture: manager enforces the observable lease timer. */
  }
  async checkout(
    _spec: BuildRunSpec,
    _grant: BuildCredentials,
    output: (text: string) => Promise<void>,
  ) {
    for (const chunk of this.outputChunks) await output(chunk);
  }
  async solve(spec: BuildRunSpec) {
    this.solves += 1;
    const artifact = ociArtifact(spec);
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }
  async artifact(_spec: BuildRunSpec, artifact?: OciArtifact) {
    if (this.readFailure) throw new BuilderError('BUILD_UNAVAILABLE');
    return artifact ?? null;
  }
  async push(
    _spec: BuildRunSpec,
    _artifact: OciArtifact,
    _grant: Extract<BuildCredentials, { phase: 'pushing' }>,
    _output: (text: string) => Promise<void>,
  ) {
    this.pushes += 1;
    if (this.pushFailure) throw new BuilderError('BUILD_PUSH_FAILED');
  }
  async stop(): Promise<TerminationEvidence> {
    this.stops += 1;
    if (!this.canTerminate) throw new BuilderError('BUILD_UNAVAILABLE');
    return {
      kind: 'cgroup_empty',
      executionGroupId: 'fixture.service',
      bootId: '11111111-1111-4111-8111-111111111111',
    };
  }
}
const paths: string[] = [];
const managers: BuildManager[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
async function until<T>(sample: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const value = await sample();
    if (ready(value)) return value;
    await delay(10);
  }
  throw new Error('Builder condition timed out');
}
async function setup(
  spec = buildSpec(),
  options: { maxLogBytes?: number; logRetentionMs?: number; initialGeneration?: number } = {},
) {
  const path = await mkdtemp(join(tmpdir(), 'ozz-builder-ledger-'));
  paths.push(path);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signingPrivateKey = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const driver = new FaultDriver(spec);
  const ledger = new FileBuildLedger(path);
  const manager = new BuildManager(ledger, driver, {
    installationId: spec.installationId,
    instanceId: spec.profile.instanceId,
    initialGeneration: 0,
    signingPrivateKey,
    ...options,
  });
  managers.push(manager);
  await manager.start();
  const submit = {
    spec,
    specHash: hashBuildSpec(spec),
    epoch: { generation: options.initialGeneration ?? 0, ownershipEpoch: 1 },
    leaseUntil: new Date(Date.now() + 30000).toISOString(),
  };
  return {
    path,
    spec,
    driver,
    ledger,
    manager,
    submit,
    signingPrivateKey,
    publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}
async function grant(manager: BuildManager, spec: BuildRunSpec, token = 'fixture-token') {
  const observation = await until(
    () => manager.get(spec.runId),
    (value) => Boolean(value?.credentialRequest || value?.proof),
  );
  if (observation!.proof) return observation!;
  const request = observation!.credentialRequest!;
  const base = {
    specHash: observation!.specHash,
    epoch: observation!.epoch,
    nonce: request.nonce,
    expiresAt: new Date(Date.now() + 30000).toISOString(),
  };
  const credentials: BuildCredentials =
    request.phase === 'checkout'
      ? {
          ...base,
          phase: 'checkout',
          githubRepositoryId: spec.source.githubRepositoryId,
          fullName: 'owner/repo',
          cloneUrl: 'https://github.com/owner/repo.git',
          commitSha: spec.source.commitSha,
          token,
        }
      : request.phase === 'building'
        ? { ...base, phase: 'building', secrets: [] }
        : {
            ...base,
            phase: 'pushing',
            authority: spec.destination.authority,
            username: 'push-fixture',
            password: 'push-fixture-only',
          };
  await manager.credentials(spec.runId, credentials);
  await until(
    () => manager.get(spec.runId),
    (value) => Boolean(value?.proof || value?.credentialRequest?.nonce !== request.nonce),
  );
  return (await manager.get(spec.runId))!;
}

describe('durable Builder cancellation, retry and output', () => {
  it('serializes host closure and its proof before accepting a concurrent renewal', async () => {
    const fixture = await setup();
    const { manager, driver, spec, submit } = fixture;
    let signalClosed!: () => void;
    const closed = new Promise<void>((resolve) => (signalClosed = resolve));
    let finishClose!: () => void;
    const closing = new Promise<void>((resolve) => (finishClose = resolve));
    const originalStop = driver.stop.bind(driver);
    vi.spyOn(driver, 'stop').mockImplementation(async () => {
      const evidence = await originalStop();
      signalClosed();
      await closing;
      return evidence;
    });
    const renewHost = vi
      .spyOn(driver, 'renew')
      .mockRejectedValue(new BuilderError('BUILD_ISOLATION_UNAVAILABLE'));
    await manager.submit(submit);
    await grant(manager, spec);
    await grant(manager, spec);
    await grant(manager, spec);
    await closed;
    let settled = false;
    const renewal = manager
      .renew(spec.runId, {
        specHash: submit.specHash,
        epoch: submit.epoch,
        leaseUntil: submit.leaseUntil,
      })
      .then(
        (observation) => ({ observation, error: null }),
        (error: unknown) => ({ observation: null, error }),
      )
      .then((result) => {
        settled = true;
        return result;
      });
    try {
      await delay(30);
      expect(settled).toBe(false);
      expect(renewHost).not.toHaveBeenCalled();
    } finally {
      finishClose();
    }
    const result = await renewal;
    expect(result.error).toBeNull();
    expect(result.observation?.state).toBe('ended');
    expect(result.observation?.proof?.payload.disposition).toEqual({ outcome: 'succeeded' });
    expect(
      verifyEndProof(result.observation?.proof, {
        spec,
        specHash: submit.specHash,
        publicKey: fixture.publicKey,
      }),
    ).toBeTruthy();
    expect(renewHost).not.toHaveBeenCalled();
  });
  it('persists cancellation before PUT and never starts a late replay, including generation zero', async () => {
    const fixture = await setup();
    const { manager, spec, submit, driver } = fixture;
    const cancelled = await manager.cancel(spec.runId, {
      specHash: submit.specHash,
      epoch: submit.epoch,
      reason: 'cancelled',
    });
    expect(cancelled.proof?.payload.terminationEvidence.kind).toBe('never_started');
    expect(await manager.submit(submit)).toEqual(cancelled);
    expect(driver.prepared).toBe(0);
    expect(
      verifyEndProof(cancelled.proof, {
        spec,
        specHash: submit.specHash,
        publicKey: fixture.publicKey,
      }),
    ).toBeTruthy();
    await expect(
      manager.submit({
        ...submit,
        spec: { ...spec, deadlineAt: new Date(Date.now() + 100000).toISOString() },
        specHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'BUILD_SPEC_CONFLICT' });
    const content = await readFile(join(fixture.path, `${spec.runId}.json`), 'utf8');
    expect(content).toContain('cancelTombstone');
  });
  it('keeps cancellation open until the driver confirms the entire execution group ended', async () => {
    const { manager, driver, submit, spec } = await setup();
    driver.canTerminate = false;
    await manager.submit(submit);
    await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.credentialRequest),
    );
    await manager.submit(submit);
    expect(driver.prepared).toBe(1);
    await manager.cancel(spec.runId, {
      specHash: submit.specHash,
      epoch: submit.epoch,
      reason: 'cancelled',
    });
    await delay(100);
    expect((await manager.get(spec.runId))!.proof).toBeNull();
    expect((await manager.get(spec.runId))!.state).toBe('cancelling');
    driver.canTerminate = true;
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(ended!.proof!.payload.executionClosed).toBe(true);
    expect(driver.prepared).toBe(1);
  });
  it('returns an old-epoch terminal proof to a takeover and rejects stale open mutations', async () => {
    const { manager, submit, spec } = await setup();
    await manager.submit(submit);
    await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.credentialRequest),
    );
    await manager.fence({
      installationId: spec.installationId,
      builderInstanceId: spec.profile.instanceId,
      generation: 1,
      requestId: randomUUID(),
      challenge: 'a'.repeat(32),
    });
    await manager.submit({ ...submit, epoch: { generation: 1, ownershipEpoch: 1 } });
    await expect(
      manager.renew(spec.runId, {
        specHash: submit.specHash,
        epoch: submit.epoch,
        leaseUntil: submit.leaseUntil,
      }),
    ).rejects.toMatchObject({ code: 'BUILD_EPOCH_STALE' });
    await manager.cancel(spec.runId, {
      specHash: submit.specHash,
      epoch: { generation: 1, ownershipEpoch: 1 },
      reason: 'cancelled',
    });
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(
      await manager.submit({ ...submit, epoch: { generation: 2, ownershipEpoch: 1 } }),
    ).toEqual(ended);
  });
  it('retains the exported OCI after push failure and can push it without another solve', async () => {
    const { manager, submit, spec, driver } = await setup();
    driver.pushFailure = true;
    await manager.submit(submit);
    await grant(manager, spec);
    await grant(manager, spec);
    await grant(manager, spec);
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(ended!.proof!.payload.disposition.outcome).toBe('failed');
    expect(ended!.artifact).not.toBeNull();
    expect(driver.solves).toBe(1);
    driver.pushFailure = false;
    const retry = {
      ...spec,
      runId: randomUUID(),
      action: 'push_existing' as const,
      artifact: ended!.artifact!,
    };
    await manager.submit({ ...submit, spec: retry, specHash: hashBuildSpec(retry) });
    await grant(manager, retry);
    const pushed = await until(
      () => manager.get(retry.runId),
      (value) => Boolean(value?.proof),
    );
    expect(pushed!.proof!.payload.pushReceipt?.rootDigest).toBe(ended!.artifact!.rootDigest);
    expect(driver.solves).toBe(1);
    expect(driver.pushes).toBe(2);
  });
  it('does not turn an unreadable artifact into a signed no-artifact result', async () => {
    const { manager, submit, spec, driver } = await setup();
    await manager.submit(submit);
    await grant(manager, spec);
    driver.readFailure = true;
    await grant(manager, spec);
    await delay(100);
    const unknown = (await manager.get(spec.runId))!;
    expect(unknown.artifact).not.toBeNull();
    expect(unknown.proof).toBeNull();
    expect(driver.solves).toBe(1);
    driver.readFailure = false;
    await manager.cancel(spec.runId, {
      specHash: submit.specHash,
      epoch: submit.epoch,
      reason: 'cancelled',
    });
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(ended!.artifact!.id).toBe(unknown.artifact!.id);
  });
  it('reconciles a persisted interrupted run after restart without rerunning source', async () => {
    const fixture = await setup();
    const { manager, submit, spec, driver, path, signingPrivateKey } = fixture;
    driver.canTerminate = false;
    await manager.submit(submit);
    await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.credentialRequest),
    );
    await manager.stop();
    driver.canTerminate = true;
    const recovered = new BuildManager(new FileBuildLedger(path), driver, {
      installationId: spec.installationId,
      instanceId: spec.profile.instanceId,
      initialGeneration: 0,
      signingPrivateKey,
    });
    managers.push(recovered);
    await recovered.start();
    const result = (await recovered.get(spec.runId))!;
    expect(result.proof?.payload.disposition).toMatchObject({
      outcome: 'failed',
      code: 'BUILD_MANAGER_RESTARTED',
    });
    expect(driver.prepared).toBe(1);
    expect(await recovered.submit(submit)).toEqual(result);
  });
  it('redacts across transport chunks, keeps metadata small, and expires real log storage without deleting proofs', async () => {
    const fixture = await setup(undefined, { maxLogBytes: 64, logRetentionMs: 10000 });
    const { manager, driver, spec, submit, path, ledger } = fixture;
    driver.outputChunks = ['start fixt', 'ure-token tail\n', 'x'.repeat(1000)];
    await manager.submit(submit);
    await grant(manager, spec);
    await grant(manager, spec);
    await grant(manager, spec);
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    const logs = await manager.events(spec.runId, '0');
    expect(logs.truncated).toBe(true);
    expect(logs.events.map((event) => event.text).join('')).toContain('[REDACTED]');
    const metadata = await readFile(join(path, `${spec.runId}.json`), 'utf8');
    expect(metadata).not.toContain('fixture-token');
    expect(metadata).not.toContain('start ');
    expect(metadata.length).toBeLessThan(15000);
    const raw = await readFile(join(path, `${spec.runId}.events.ndjson`), 'utf8');
    expect(raw).not.toContain('fixture-token');
    await ledger.serial(() => ledger.expireLogs(Date.now() + 20000));
    expect(ledger.totalLogBytes).toBe(0);
    expect(await readdir(path)).not.toContain(`${spec.runId}.events.ndjson`);
    expect((await manager.get(spec.runId))!.proof).toEqual(ended!.proof);
  });
  it('retains failed uploader diagnostics through the final redacted chunk', async () => {
    const { manager, driver, spec, submit, path } = await setup();
    const password = 'push-fixture-only';
    const basic = Buffer.from(`push-fixture:${password}`).toString('base64');
    vi.spyOn(driver, 'push').mockImplementation(async (_spec, _artifact, credentials, output) => {
      expect(credentials.password).toBe(password);
      await output(`password=${password.slice(0, 8)}`);
      await output(`${password.slice(8)} Basic ${basic.slice(0, 17)}`);
      await output(`${basic.slice(17)} mkdir /var/tmp: Permission denied\n`);
      throw new DriverError('BUILD_PUSH_FAILED');
    });
    await manager.submit(submit);
    await grant(manager, spec);
    await grant(manager, spec);
    await grant(manager, spec);
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    const logs = await manager.events(spec.runId, '0');
    expect(logs.events.map((event) => event.text).join('')).toBe(
      'password=[REDACTED] Basic [REDACTED] mkdir /var/tmp: Permission denied\n',
    );
    expect(ended!.proof!.payload.disposition).toMatchObject({
      outcome: 'failed',
      phase: 'pushing',
      code: 'BUILD_PUSH_FAILED',
    });
    const stored = await readFile(join(path, `${spec.runId}.events.ndjson`), 'utf8');
    expect(stored).not.toContain(password);
    expect(stored).not.toContain(basic);
  });
  it('preserves the original phase failure when its final log append fails', async () => {
    const { manager, driver, spec, submit, ledger } = await setup();
    vi.spyOn(driver, 'push').mockImplementation(async (_spec, _artifact, _grant, output) => {
      await output('short diagnostic\n');
      throw new DriverError('BUILD_PUSH_FAILED');
    });
    const append = vi
      .spyOn(ledger, 'appendEvents')
      .mockRejectedValue(new DriverError('BUILD_UNAVAILABLE'));
    await manager.submit(submit);
    await grant(manager, spec);
    await grant(manager, spec);
    await grant(manager, spec);
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(append).toHaveBeenCalledOnce();
    expect(ended!.proof!.payload.disposition).toMatchObject({
      outcome: 'failed',
      phase: 'pushing',
      code: 'BUILD_PUSH_FAILED',
    });
  });
  it('discards a buffered secret prefix when cancellation interrupts a phase', async () => {
    const { manager, driver, spec, submit } = await setup();
    let signalBuffered!: () => void;
    const buffered = new Promise<void>((resolve) => (signalBuffered = resolve));
    let failCheckout!: (error: Error) => void;
    const checkout = new Promise<void>((_resolve, reject) => (failCheckout = reject));
    vi.spyOn(driver, 'checkout').mockImplementation(async (_spec, _grant, output) => {
      await output('safe tail fixture-to');
      signalBuffered();
      await checkout;
    });
    await manager.submit(submit);
    const granting = grant(manager, spec);
    await buffered;
    await manager.cancel(spec.runId, {
      specHash: submit.specHash,
      epoch: submit.epoch,
      reason: 'cancelled',
    });
    failCheckout(new BuilderError('BUILD_TRANSPORT_CANCELLED'));
    await granting;
    const ended = await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(ended!.proof!.payload.disposition).toEqual({ outcome: 'cancelled' });
    expect((await manager.events(spec.runId, '0')).events).toEqual([]);
    expect(driver.solves).toBe(0);
    expect(driver.pushes).toBe(0);
  });
  it('keeps UTF-8 output within its exact byte quota and deletes truncation-only log files', async () => {
    const fixture = await setup(undefined, { maxLogBytes: 2, logRetentionMs: 10000 });
    const { manager, driver, spec, submit, ledger, path } = fixture;
    driver.outputChunks = ['界'.repeat(5000)];
    await manager.submit(submit);
    await grant(manager, spec);
    await grant(manager, spec);
    await grant(manager, spec);
    await until(
      () => manager.get(spec.runId),
      (value) => Boolean(value?.proof),
    );
    expect(ledger.totalLogBytes).toBeLessThanOrEqual(2);
    expect(await readdir(path)).toContain(`${spec.runId}.events.ndjson`);
    await ledger.serial(() => ledger.expireLogs(Date.now() + 20000));
    expect(await readdir(path)).not.toContain(`${spec.runId}.events.ndjson`);
  });
});

describe('installation fencing and complete inventory', () => {
  it('only explicit fences admit a new generation and preserve idempotent receipts across restart', async () => {
    const { manager, spec, submit, driver, publicKey, signingPrivateKey, path } = await setup();
    await expect(
      manager.submit({ ...submit, epoch: { generation: 1, ownershipEpoch: 1 } }),
    ).rejects.toMatchObject({ code: 'BUILD_EPOCH_STALE' });
    expect(verifySigned(await manager.identity('a'.repeat(32)), publicKey).highGeneration).toBe(0);
    const request = {
      installationId: spec.installationId,
      builderInstanceId: spec.profile.instanceId,
      generation: 2,
      requestId: randomUUID(),
      challenge: 'b'.repeat(32),
    };
    const receipt = await manager.fence(request);
    expect(verifySigned(receipt, publicKey).highGeneration).toBe(2);
    expect(await manager.fence(request)).toEqual(receipt);
    await expect(manager.fence({ ...request, generation: 3 })).rejects.toMatchObject({
      code: 'BUILD_SPEC_CONFLICT',
    });
    for (const generation of [0, 1, 3])
      await expect(
        manager.submit({ ...submit, epoch: { generation, ownershipEpoch: 1 } }),
      ).rejects.toMatchObject({ code: 'BUILD_EPOCH_STALE' });
    expect(driver.prepared).toBe(0);
    await manager.stop();
    const recovered = new BuildManager(new FileBuildLedger(path), driver, {
      installationId: spec.installationId,
      instanceId: spec.profile.instanceId,
      initialGeneration: 99,
      signingPrivateKey,
    });
    managers.push(recovered);
    await recovered.start();
    expect(verifySigned(await recovered.identity('c'.repeat(32)), publicKey).highGeneration).toBe(
      2,
    );
    expect(await recovered.fence(request)).toEqual(receipt);
    await expect(
      recovered.fence({ ...request, requestId: randomUUID(), generation: 1 }),
    ).rejects.toMatchObject({ code: 'BUILD_EPOCH_STALE' });
  });
  it('uses the operator generation only when initializing a fresh ledger', async () => {
    const { manager, submit, publicKey } = await setup(undefined, { initialGeneration: 7 });
    expect(verifySigned(await manager.identity('d'.repeat(32)), publicKey).highGeneration).toBe(7);
    await expect(
      manager.submit({ ...submit, epoch: { generation: 0, ownershipEpoch: 1 } }),
    ).rejects.toMatchObject({ code: 'BUILD_EPOCH_STALE' });
    expect((await manager.submit(submit)).epoch.generation).toBe(7);
  });
  it.each([0, 1, 100])(
    'serves more than four fresh signed single-page inventories with %i runs',
    async (runCount) => {
      const { manager, spec, submit, publicKey } = await setup();
      for (let index = 0; index < runCount; index++)
        await manager.cancel(randomUUID(), {
          specHash: submit.specHash,
          epoch: submit.epoch,
          reason: 'cancelled',
        });
      const snapshotIds = new Set<string>();
      for (let index = 0; index < 6; index++) {
        const nonce = randomUUID();
        const page = await manager.inventory(nonce);
        expect(page.payload.nextCursor).toBeNull();
        const inventory = verifyInventoryPages([page], {
          installationId: spec.installationId,
          builderInstanceId: spec.profile.instanceId,
          challenge: nonce,
          publicKey,
        });
        expect(inventory.totalRuns).toBe(runCount);
        expect(inventory.runs).toHaveLength(runCount);
        snapshotIds.add(inventory.snapshotId);
      }
      expect(snapshotIds.size).toBe(6);
    },
  );
  it('snapshots every tombstone with stable bounded pagination and rejects missing or expired pages', async () => {
    const { manager, spec, submit, publicKey, driver } = await setup();
    expect((await manager.inventory('d'.repeat(32))).payload.nextCursor).toBeNull();
    for (let index = 0; index < 101; index++)
      await manager.cancel(randomUUID(), {
        specHash: submit.specHash,
        epoch: submit.epoch,
        reason: 'cancelled',
      });
    const nonce = 'e'.repeat(32);
    const first = await manager.inventory(nonce);
    expect(first.payload.totalRuns).toBe(101);
    expect(first.payload.runs).toHaveLength(100);
    await manager.cancel(randomUUID(), {
      specHash: submit.specHash,
      epoch: submit.epoch,
      reason: 'cancelled',
    });
    const second = await manager.inventory(nonce, first.payload.nextCursor!);
    const expected = {
      installationId: spec.installationId,
      builderInstanceId: spec.profile.instanceId,
      challenge: nonce,
      publicKey,
    };
    const inventory = verifyInventoryPages([first, second], expected);
    expect(inventory.runs).toHaveLength(101);
    expect(inventory.runs.every((run) => run.executionClosed && run.proofHash)).toBe(true);
    expect(() => verifyInventoryPages([first], expected)).toThrow(BuilderError);
    expect(() => verifyInventoryPages([second, first], expected)).toThrow(BuilderError);
    expect(() =>
      verifyInventoryPages([first, second], { ...expected, challenge: 'f'.repeat(32) }),
    ).toThrow(BuilderError);
    const fresh = await manager.inventory('f'.repeat(32));
    expect(fresh.payload.totalRuns).toBe(102);
    expect(fresh.payload.inventoryRevision).not.toBe(first.payload.inventoryRevision);
    const third = await manager.inventory('g'.repeat(32));
    const fourth = await manager.inventory('h'.repeat(32));
    await expect(manager.inventory('i'.repeat(32))).rejects.toMatchObject({
      code: 'BUILD_BUSY',
      retryable: true,
    });
    expect(await manager.inventory(nonce, first.payload.nextCursor!)).toEqual(second);
    await expect(
      manager.inventory('f'.repeat(32), first.payload.nextCursor!),
    ).rejects.toMatchObject({ code: 'BUILD_PROOF_INVALID' });
    const expiredAt =
      Math.max(...[first, fresh, third, fourth].map((page) => Date.parse(page.payload.expiresAt))) +
      1;
    expect(() => verifyInventoryPages([first, second], { ...expected, now: expiredAt })).toThrow(
      BuilderError,
    );
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
    try {
      await expect(manager.inventory(nonce, first.payload.nextCursor!)).rejects.toMatchObject({
        code: 'BUILD_INVENTORY_EXPIRED',
      });
      const renewed = await manager.inventory('i'.repeat(32));
      expect(renewed.payload.totalRuns).toBe(102);
      expect(renewed.payload.snapshotId).not.toBe(first.payload.snapshotId);
    } finally {
      clock.mockRestore();
    }
    expect(driver.prepared).toBe(0);
  });
});
