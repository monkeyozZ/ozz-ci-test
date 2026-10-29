import { K3S_VERSION } from './ssh/assets.js';
import {
  SshAdapterError,
  type SshAdapterOptions,
  type SshCallOptions,
  type SshCredential,
  type SshEndpoint,
  type SshHostKey,
  type SshInitialization,
  type SshInitializeOptions,
  type SshPreflight,
  type SshProgressStage,
  type SshTarget,
} from './ssh/contracts.js';
import { initializeScript } from './ssh/install-script.js';
import { preflightScript, pythonCommand } from './ssh/preflight-script.js';
import {
  Frames,
  bootstrapCredential,
  preflightObservation,
  record,
  requireSuccessfulOutput,
} from './ssh/protocol.js';
import { connect, discover, execute } from './ssh/transport.js';
import {
  parseSshCredential,
  validateEndpoint,
  validateInitialization,
  validateTarget,
} from './ssh/validation.js';

export * from './ssh/contracts.js';
export { K3S_VERSION, K3S_ASSET_SOURCE } from './ssh/assets.js';
export { parseSshCredential } from './ssh/validation.js';

const remoteStages: readonly SshProgressStage[] = [
  'downloading',
  'installing',
  'starting',
  'waiting_ready',
  'verifying_encryption',
];

function bound(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError('SSH adapter limits are outside their supported range.');
  return value;
}

async function hook(
  callback: () => void | Promise<void>,
  signal: AbortSignal | undefined,
  code: 'SSH_PROGRESS_FAILED' | 'SSH_CREDENTIAL_STORE_FAILED',
): Promise<void> {
  if (signal?.aborted) throw new SshAdapterError('SSH_CANCELLED');
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: SshAdapterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new SshAdapterError('SSH_CANCELLED'));
    const timer = setTimeout(() => finish(new SshAdapterError(code)), 10_000);
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(callback)
      .then(
        () => finish(),
        () => finish(new SshAdapterError(code)),
      );
  });
}

/**
 * Isolated SSH sessions with pinned host identity, bounded I/O and fixed remote programs.
 * initialize preserves remote side effects on errors; the durable task owns retries and fencing.
 */
export class SshAdapter {
  private readonly connectTimeoutMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly initializeTimeoutMs: number;
  private readonly maxOutputBytes: number;

  constructor(options: SshAdapterOptions = {}) {
    this.connectTimeoutMs = bound(options.connectTimeoutMs, 10_000, 50, 60_000);
    this.preflightTimeoutMs = bound(options.preflightTimeoutMs, 30_000, 50, 120_000);
    this.initializeTimeoutMs = bound(options.initializeTimeoutMs, 600_000, 100, 900_000);
    this.maxOutputBytes = bound(options.maxOutputBytes, 256 * 1024, 1024, 1024 * 1024);
  }

  async discoverHostKey(endpoint: SshEndpoint, options: SshCallOptions = {}): Promise<SshHostKey> {
    validateEndpoint(endpoint);
    return discover(endpoint, this.connectTimeoutMs, options.signal);
  }

  async preflight(
    target: SshTarget,
    credential: SshCredential,
    options: SshCallOptions = {},
  ): Promise<SshPreflight> {
    validateTarget(target);
    const connection = await connect(
      target,
      parseSshCredential(credential),
      this.connectTimeoutMs,
      options.signal,
    );
    const frames = new Frames();
    const result = await execute(connection, pythonCommand, preflightScript, {
      timeoutMs: this.preflightTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal: options.signal,
      onStdout: (chunk) => frames.push(chunk),
    });
    frames.finish();
    requireSuccessfulOutput(frames, result.exitCode);
    if (frames.values.length !== 1 || frames.values[0]?.type !== 'preflight')
      throw new SshAdapterError('SSH_INVALID_RESPONSE');
    return preflightObservation(frames.values[0].data);
  }

  async initialize(
    target: SshTarget,
    credential: SshCredential,
    options: SshInitializeOptions,
  ): Promise<SshInitialization> {
    validateTarget(target);
    const { apiEndpoint, apiHostname } = validateInitialization(options);
    const parsedCredential = parseSshCredential(credential);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const signal = controller.signal;
    let mutated = false;
    let progressFailure: SshAdapterError | undefined;
    let progressQueue = Promise.resolve();
    const notify = (stage: SshProgressStage) =>
      hook(() => options.onProgress?.({ stage }), signal, 'SSH_PROGRESS_FAILED');
    try {
      await notify('connecting');
      await notify('preflight');
      const before = await this.preflight(target, parsedCredential, { signal });
      if (before.machineId !== options.expectedMachineId)
        throw new SshAdapterError('SSH_IDENTITY_CHANGED');
      if (before.k3s.installed && before.k3s.installationId === null)
        throw new SshAdapterError('SSH_K3S_ALREADY_INSTALLED');
      if (
        before.k3s.installationId !== null &&
        before.k3s.installationId !== options.installationId
      )
        throw new SshAdapterError('SSH_INSTALLATION_CONFLICT');
      if (!before.privileged) throw new SshAdapterError('SSH_PRIVILEGE_REQUIRED');
      if (before.blockers.length > 0) throw new SshAdapterError('SSH_PREFLIGHT_BLOCKED');
      const connection = await connect(target, parsedCredential, this.connectTimeoutMs, signal);
      const seenStages = new Set<SshProgressStage>();
      const frames = new Frames((frame) => {
        if (frame.type !== 'progress') return;
        const stage = frame.stage as SshProgressStage;
        if (!remoteStages.includes(stage) || seenStages.has(stage))
          throw new SshAdapterError('SSH_INVALID_RESPONSE');
        seenStages.add(stage);
        progressQueue = progressQueue
          .then(() => notify(stage))
          .catch((error: unknown) => {
            progressFailure ??=
              error instanceof SshAdapterError ? error : new SshAdapterError('SSH_PROGRESS_FAILED');
            controller.abort();
          });
      });
      mutated = true;
      const output = await execute(
        connection,
        pythonCommand,
        initializeScript({
          installationId: options.installationId,
          machineId: options.expectedMachineId,
          nodeName: options.nodeName,
          apiEndpoint,
          apiHostname,
          timeoutSeconds: Math.max(1, Math.floor(this.initializeTimeoutMs / 1000) - 5),
        }),
        {
          timeoutMs: this.initializeTimeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          signal,
          onStdout: (chunk) => frames.push(chunk),
        },
      );
      frames.finish();
      await progressQueue;
      if (progressFailure) throw progressFailure;
      requireSuccessfulOutput(frames, output.exitCode);
      const completed = frames.values.filter((frame) => frame.type === 'initialized');
      const credentials = frames.values.filter((frame) => frame.type === 'credential');
      if (
        completed.length !== 1 ||
        credentials.length !== 1 ||
        seenStages.size !== remoteStages.length ||
        frames.values.some(
          (frame) => !['progress', 'credential', 'initialized'].includes(frame.type as string),
        )
      )
        throw new SshAdapterError('SSH_INVALID_RESPONSE');
      const data = record(completed[0]!.data);
      if (
        data.installationId !== options.installationId ||
        data.machineId !== options.expectedMachineId ||
        data.nodeName !== options.nodeName ||
        data.apiEndpoint !== apiEndpoint ||
        data.version !== K3S_VERSION ||
        data.architecture !== before.architecture ||
        !['arm64', 'amd64'].includes(data.architecture as string) ||
        data.secretsEncryption !== 'enabled' ||
        typeof data.resumed !== 'boolean'
      )
        throw new SshAdapterError('SSH_INVALID_RESPONSE');
      await notify('storing_credential');
      let raw: string | undefined = bootstrapCredential(credentials[0]!.kubeconfig, apiEndpoint);
      try {
        await hook(() => options.onCredential(raw!), signal, 'SSH_CREDENTIAL_STORE_FAILED');
      } finally {
        raw = undefined;
        credentials[0]!.kubeconfig = undefined;
      }
      await notify('completed');
      return {
        observedAt: new Date().toISOString(),
        installationId: options.installationId,
        machineId: options.expectedMachineId,
        architecture: data.architecture as 'arm64' | 'amd64',
        version: K3S_VERSION,
        nodeName: options.nodeName,
        apiEndpoint,
        secretsEncryption: 'enabled',
        resumed: data.resumed,
      };
    } catch (error) {
      const safe =
        progressFailure ??
        (error instanceof SshAdapterError ? error : new SshAdapterError('SSH_REMOTE_FAILED'));
      controller.abort();
      await progressQueue;
      throw new SshAdapterError(safe.code, mutated ? 'may_have_changed' : 'none');
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }
}
