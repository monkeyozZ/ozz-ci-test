import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinuxBuildDriver } from '../../apps/builder/src/linux-driver.js';
import { buildSpec, ociArtifact } from '../infrastructure/build-fixture.js';
import { hashBuildSpec } from '../../packages/infrastructure/src/build.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const spec = buildSpec();
const common = {
  specHash: hashBuildSpec(spec),
  epoch: { generation: 0, ownershipEpoch: 1 },
  nonce: 'a'.repeat(32),
  expiresAt: new Date(Date.now() + 30000).toISOString(),
};
const credentials = {
  checkout: {
    ...common,
    phase: 'checkout' as const,
    githubRepositoryId: spec.source.githubRepositoryId,
    fullName: 'fixture/application',
    cloneUrl: 'https://github.example.test/fixture/application.git',
    commitSha: spec.source.commitSha,
    token: 'fixture-token-not-live',
  },
  building: { ...common, phase: 'building' as const, secrets: [] },
  pushing: {
    ...common,
    phase: 'pushing' as const,
    authority: spec.destination.authority,
    username: 'fixture',
    password: 'fixture-password-not-live',
  },
};

function failedLauncher() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  spawn.mockImplementationOnce(() => {
    queueMicrotask(() => {
      child.stderr.end('diagnostic with fixture-token-not-live');
      child.stdout.end();
      child.emit('close', 1);
    });
    return child;
  });
  return child;
}

describe('Linux launcher failure boundary', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    spawn.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform);
  });

  it.each([
    ['checkout', 'BUILD_CHECKOUT_FAILED'],
    ['building', 'BUILD_SOLVE_FAILED'],
    ['pushing', 'BUILD_PUSH_FAILED'],
  ] as const)(
    'reports the %s phase without retaining launcher diagnostics',
    async (phase, code) => {
      failedLauncher();
      const driver = new LinuxBuildDriver();
      const output = vi.fn();
      const signal = new AbortController().signal;
      const result =
        phase === 'checkout'
          ? driver.checkout(spec, credentials.checkout, output, signal)
          : phase === 'building'
            ? driver.solve(spec, credentials.building, output, signal)
            : driver.push(spec, ociArtifact(spec), credentials.pushing, output, signal);

      await expect(result).rejects.toMatchObject({ name: 'BuilderError', code, message: code });
      expect(output).not.toHaveBeenCalled();
    },
  );

  it('keeps cancellation distinct from a checkout failure', async () => {
    const child = failedLauncher();
    const abort = new AbortController();
    abort.abort();
    await expect(
      new LinuxBuildDriver().checkout(spec, credentials.checkout, vi.fn(), abort.signal),
    ).rejects.toMatchObject({ code: 'BUILD_TRANSPORT_CANCELLED' });
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('reports isolation failure before a phase is selected', async () => {
    failedLauncher();
    await expect(new LinuxBuildDriver().preflight()).rejects.toMatchObject({
      code: 'BUILD_ISOLATION_UNAVAILABLE',
    });
  });
});
