import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  BuilderError,
  parseArtifact,
  parseIdentity,
  uuid,
  type BuilderErrorCode,
  type BuildRunSpec,
  type BuildCredentials,
  type OciArtifact,
  type TerminationEvidence,
} from '@ozz/infrastructure/build';
import type { BuildExecutionDriver } from './manager.js';

/** All OS privilege is confined to the installed, root-owned launcher. Source is always rootless. */
export class LinuxBuildDriver implements BuildExecutionDriver {
  constructor(private readonly launcher = '/usr/local/libexec/ozz-builder-launch') {
    if (!launcher.startsWith('/') || launcher.includes('\0'))
      throw new BuilderError('BUILD_ISOLATION_UNAVAILABLE');
  }
  private async call(
    action: string,
    spec?: BuildRunSpec,
    payload: object = {},
    output?: (text: string) => Promise<void>,
    signal?: AbortSignal,
    failureCode: BuilderErrorCode = 'BUILD_ISOLATION_UNAVAILABLE',
  ): Promise<unknown> {
    if (process.platform !== 'linux') throw new BuilderError('BUILD_ISOLATION_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const child = spawn(
        '/usr/bin/sudo',
        ['-n', '--', this.launcher, action, ...(spec ? [uuid(spec.runId)] : [])],
        {
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const decoder = new StringDecoder('utf8');
      let pending = '';
      let result: unknown;
      let hasResult = false;
      let invalid = false;
      let receivedBytes = 0;
      let outputQueue = Promise.resolve();
      const timer = setTimeout(
        () => child.kill('SIGTERM'),
        action === 'phase' ? (spec!.limits.timeoutSeconds + 30) * 1000 : 60000,
      );
      const abort = () => child.kill('SIGTERM');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk: Buffer) => {
        pending += decoder.write(chunk);
        if (pending.length > 1048576) {
          invalid = true;
          child.kill('SIGTERM');
          return;
        }
        for (;;) {
          const newline = pending.indexOf('\n');
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          try {
            const item = JSON.parse(line) as { type?: unknown; text?: unknown; value?: unknown };
            if (item.type === 'log' && typeof item.text === 'string') {
              receivedBytes += Buffer.byteLength(item.text);
              // Drain unlimited child output without retaining it after the configured log bound.
              if (receivedBytes <= 9 * 1024 * 1024) {
                const text = item.text;
                outputQueue = outputQueue.then(() => output?.(text));
              }
            } else if (item.type === 'result' && !hasResult) {
              result = item.value;
              hasResult = true;
            } else throw new Error();
          } catch {
            invalid = true;
            child.kill('SIGTERM');
          }
        }
      });
      // Launcher diagnostics are never raw task output or part of a thrown error.
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(new BuilderError('BUILD_ISOLATION_UNAVAILABLE'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        void outputQueue.then(
          () => {
            if (code || invalid || !hasResult || pending.trim())
              reject(new BuilderError(signal?.aborted ? 'BUILD_TRANSPORT_CANCELLED' : failureCode));
            else resolve(result);
          },
          () => reject(new BuilderError('BUILD_UNAVAILABLE')),
        );
      });
      child.stdin.end(JSON.stringify({ ...(spec ? { spec } : {}), ...payload }));
      if (signal?.aborted) abort();
    });
  }
  async preflight(): ReturnType<BuildExecutionDriver['preflight']> {
    const raw = (await this.call('preflight')) as Record<string, unknown>;
    const signed = parseIdentity({
      payload: {
        ...raw,
        version: 1,
        challenge: 'a'.repeat(32),
        instanceId: (raw.profile as { instanceId: string }).instanceId,
        highGeneration: 0,
        checkedAt: new Date().toISOString(),
      },
      signature: { algorithm: 'Ed25519', keyId: '0'.repeat(64), value: 'A'.repeat(86) },
    });
    const { profile, platform, isolation, limits, maxConcurrency } = signed.payload;
    return { profile, platform, isolation, limits, maxConcurrency };
  }
  async prepare(spec: BuildRunSpec, leaseUntil: string): Promise<void> {
    await this.call('prepare', spec, { leaseUntil });
  }
  async renew(spec: BuildRunSpec, leaseUntil: string): Promise<void> {
    await this.call('renew', spec, { leaseUntil });
  }
  async checkout(
    spec: BuildRunSpec,
    credentials: Extract<BuildCredentials, { phase: 'checkout' }>,
    output: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.call(
      'phase',
      spec,
      { phase: 'checkout', credentials },
      output,
      signal,
      'BUILD_CHECKOUT_FAILED',
    );
  }
  async solve(
    spec: BuildRunSpec,
    credentials: Extract<BuildCredentials, { phase: 'building' }>,
    output: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<OciArtifact> {
    await this.call(
      'phase',
      spec,
      { phase: 'building', credentials },
      output,
      signal,
      'BUILD_SOLVE_FAILED',
    );
    return parseArtifact(await this.call('collect', spec));
  }
  async artifact(spec: BuildRunSpec, artifact?: OciArtifact): Promise<OciArtifact | null> {
    const raw = await this.call('artifact', spec, artifact ? { artifact } : {});
    return raw === null ? null : parseArtifact(raw);
  }
  async push(
    spec: BuildRunSpec,
    artifact: OciArtifact,
    credentials: Extract<BuildCredentials, { phase: 'pushing' }>,
    output: (text: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.call(
      'phase',
      spec,
      { phase: 'pushing', artifact, credentials },
      output,
      signal,
      'BUILD_PUSH_FAILED',
    );
  }
  async stop(spec: BuildRunSpec): Promise<TerminationEvidence> {
    const evidence = (await this.call('stop', spec)) as TerminationEvidence;
    if (evidence.kind === 'never_started') return evidence;
    if (
      evidence.kind === 'cgroup_empty' &&
      /^[A-Za-z0-9_.:-]{1,128}$/u.test(evidence.executionGroupId)
    )
      return { ...evidence, bootId: uuid(evidence.bootId) };
    if (
      evidence.kind === 'host_rebooted' &&
      uuid(evidence.executionBootId) !== uuid(evidence.observedBootId)
    )
      return evidence;
    throw new BuilderError('BUILD_PROOF_INVALID');
  }
}
