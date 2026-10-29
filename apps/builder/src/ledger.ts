import { constants } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdir, open, readdir, rename, lstat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  hashBuildSpec,
  hashJson,
  parseBuildRunSpec,
  parseObservation,
  parseFenceReceipt,
  integer,
  uuid,
  BuilderError,
  type BuildRunObservation,
  type BuildRunSpec,
  type BuildEvent,
  type BuildEventPage,
  type BuilderFenceReceipt,
  type SignedPayload,
  type BuilderInventoryRun,
} from '@ozz/infrastructure/build';

export interface LedgerRun {
  version: 1;
  spec: BuildRunSpec | null;
  observation: BuildRunObservation;
  started: { checkout: boolean; solve: boolean; uploader: boolean };
  cancelRequested: boolean;
  prepared: boolean;
  lastSequence: string;
  logBytes: number;
  truncated: boolean;
  logsExpireAt: string;
}
/** Tombstones are durable identities and are never garbage-collected with build caches/logs. */
export class FileBuildLedger {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly runs = new Map<string, LedgerRun>();
  private readonly fences = new Map<string, SignedPayload<BuilderFenceReceipt>>();
  private generation = 0;
  constructor(readonly directory: string) {}
  serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  async initialize(
    installationId: string,
    builderInstanceId: string,
    initialGeneration: number,
  ): Promise<void> {
    uuid(installationId);
    uuid(builderInstanceId);
    integer(initialGeneration, 0);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new BuilderError('BUILD_ISOLATION_UNAVAILABLE');
    const names = await readdir(this.directory);
    if (!names.includes('installation.json')) {
      // Adopting an old identity or deriving a generation from run PUTs would defeat fencing.
      if (
        names.some(
          (name) =>
            name === 'generation' ||
            /^[0-9a-f-]{36}\.json$/u.test(name) ||
            name.startsWith('fence-'),
        )
      )
        throw new BuilderError('BUILD_IDENTITY_MISMATCH');
      await this.atomic(
        'installation.json',
        JSON.stringify({ version: 1, installationId, builderInstanceId, initialGeneration }),
      );
    }
    const installation = (await this.readJson('installation.json')) as {
      version?: unknown;
      installationId?: unknown;
      builderInstanceId?: unknown;
      initialGeneration?: unknown;
    };
    if (
      installation.version !== 1 ||
      installation.installationId !== installationId ||
      installation.builderInstanceId !== builderInstanceId
    )
      throw new BuilderError('BUILD_IDENTITY_MISMATCH');
    this.generation = integer(installation.initialGeneration, 0);
    for (const name of names.filter((name) => /^fence-[0-9a-f-]{36}\.json$/u.test(name))) {
      const receipt = parseFenceReceipt(await this.readJson(name));
      if (
        name !== `fence-${receipt.payload.requestId}.json` ||
        receipt.payload.installationId !== installationId ||
        receipt.payload.builderInstanceId !== builderInstanceId
      )
        throw new BuilderError('BUILD_IDENTITY_MISMATCH');
      this.fences.set(receipt.payload.requestId, receipt);
      this.generation = Math.max(this.generation, receipt.payload.highGeneration);
    }
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/u.test(name)) continue;
      const file = await open(
        join(this.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 12 * 1024 * 1024 || stat.mode & 0o077)
          throw new BuilderError('BUILD_PROTOCOL_INVALID');
        const record = JSON.parse(await file.readFile('utf8')) as LedgerRun;
        const observation = parseObservation(record.observation);
        if (
          name !== `${observation.runId}.json` ||
          record.version !== 1 ||
          observation.installationId !== installationId ||
          observation.builderInstanceId !== builderInstanceId ||
          observation.epoch.generation > this.generation ||
          (record.spec && hashBuildSpec(parseBuildRunSpec(record.spec)) !== observation.specHash)
        )
          throw new BuilderError('BUILD_PROTOCOL_INVALID');
        this.runs.set(observation.runId, record);
      } finally {
        await file.close();
      }
    }
  }
  get(id: string): LedgerRun | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }
  all(): LedgerRun[] {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }
  open(): LedgerRun[] {
    return [...this.runs.values()]
      .filter((run) => run.observation.state !== 'ended')
      .map((run) => structuredClone(run));
  }
  get highGeneration(): number {
    return this.generation;
  }
  index(): BuilderInventoryRun[] {
    return [...this.runs.values()]
      .map(({ observation }) => ({
        runId: observation.runId,
        specHash: observation.specHash,
        epoch: { ...observation.epoch },
        ledgerRevision: observation.ledgerRevision,
        executionClosed: observation.proof !== null,
        proofHash: observation.proof ? hashJson(observation.proof) : null,
      }))
      .sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  }
  fenceReceipt(requestId: string): SignedPayload<BuilderFenceReceipt> | undefined {
    const receipt = this.fences.get(requestId);
    return receipt ? structuredClone(receipt) : undefined;
  }
  requireGeneration(generation: number): void {
    if (generation !== this.generation) throw new BuilderError('BUILD_EPOCH_STALE');
  }
  async recordFence(receipt: SignedPayload<BuilderFenceReceipt>): Promise<void> {
    const parsed = parseFenceReceipt(receipt);
    const old = this.fences.get(parsed.payload.requestId);
    if (old) {
      if (canonicalJson(old) !== canonicalJson(parsed))
        throw new BuilderError('BUILD_SPEC_CONFLICT');
      return;
    }
    if (parsed.payload.highGeneration < this.generation)
      throw new BuilderError('BUILD_EPOCH_STALE');
    // One atomic durable file is both the admitted generation and the idempotent signed receipt.
    await this.atomic(`fence-${parsed.payload.requestId}.json`, JSON.stringify(parsed));
    this.fences.set(parsed.payload.requestId, structuredClone(parsed));
    this.generation = parsed.payload.highGeneration;
  }
  get totalLogBytes(): number {
    return [...this.runs.values()].reduce((sum, run) => sum + run.logBytes, 0);
  }
  async appendEvents(record: LedgerRun, events: BuildEvent[]): Promise<void> {
    if (events.length) {
      const file = await open(
        join(this.directory, `${record.observation.runId}.events.ndjson`),
        constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(events.map((event) => JSON.stringify(event) + '\n').join(''));
        await file.sync();
      } finally {
        await file.close();
      }
    }
    await this.save(record);
  }
  async eventPage(runId: string, after: string): Promise<BuildEventPage> {
    const record = this.runs.get(runId);
    if (!record) throw new BuilderError('BUILD_RUN_UNKNOWN');
    const expired = Date.now() >= Date.parse(record.logsExpireAt);
    const events: BuildEvent[] = [];
    let bytes = 0;
    if (!expired && record.logBytes) {
      const file = await open(
        join(this.directory, `${runId}.events.ndjson`),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const input = file.createReadStream();
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          const event = JSON.parse(line) as BuildEvent;
          if (BigInt(event.sequence) <= BigInt(after)) continue;
          const size = Buffer.byteLength(event.text);
          if (events.length >= 100 || bytes + size > 65536) break;
          if (events.at(-1)?.sequence === event.sequence) continue;
          bytes += size;
          events.push(event);
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
    return {
      events,
      nextSequence: events.at(-1)?.sequence ?? after,
      truncated: record.truncated,
      expired,
    };
  }
  async expireLogs(now = Date.now()): Promise<void> {
    for (const current of this.runs.values()) {
      if (current.lastSequence === '0' || Date.parse(current.logsExpireAt) > now) continue;
      await unlink(join(this.directory, `${current.observation.runId}.events.ndjson`)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
      if (current.logBytes) {
        const record = structuredClone(current);
        record.logBytes = 0;
        await this.save(record);
      }
    }
  }
  async save(record: LedgerRun): Promise<void> {
    const old = this.runs.get(record.observation.runId);
    if (
      old?.observation.proof &&
      canonicalJson(old.observation.proof) !== canonicalJson(record.observation.proof)
    )
      throw new BuilderError('BUILD_SPEC_CONFLICT');
    if (
      old &&
      (old.observation.specHash !== record.observation.specHash ||
        BigInt(old.observation.ledgerRevision) > BigInt(record.observation.ledgerRevision))
    )
      throw new BuilderError('BUILD_SPEC_CONFLICT');
    await this.atomic(`${record.observation.runId}.json`, JSON.stringify(record));
    this.runs.set(record.observation.runId, structuredClone(record));
  }
  private async readJson(name: string): Promise<unknown> {
    const file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65536 || stat.mode & 0o077)
        throw new BuilderError('BUILD_PROTOCOL_INVALID');
      return JSON.parse(await file.readFile('utf8')) as unknown;
    } finally {
      await file.close();
    }
  }
  private async atomic(name: string, content: string): Promise<void> {
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(content);
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, join(this.directory, name));
      const directory = await open(this.directory, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
