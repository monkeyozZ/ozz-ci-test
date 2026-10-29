import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Connection,
  ServerChannel,
  ParsedKey,
} from '../../packages/infrastructure/node_modules/@types/ssh2/index.js';
import {
  K3S_VERSION,
  SshAdapter,
  SshAdapterError,
  parseSshCredential,
  type SshInitializeOptions,
  type SshTarget,
} from '../../packages/infrastructure/dist/ssh.js';

const requireInfrastructure = createRequire(
  fileURLToPath(new URL('../../packages/infrastructure/package.json', import.meta.url)),
);
const { Server, utils } = requireInfrastructure(
  'ssh2',
) as typeof import('../../packages/infrastructure/node_modules/@types/ssh2/index.js');
const keyDirectory = mkdtempSync(join(tmpdir(), 'ozz-ssh-fixture-keys-'));
const hostKey = generateTestKey();
const publicKey = utils.parseKey(hostKey.private) as ParsedKey;
const fingerprint =
  'SHA256:' +
  createHash('sha256').update(publicKey.getPublicSSH()).digest('base64').replace(/=+$/, '');
const password = 'synthetic-ssh-secret-never-in-errors';
const machineId = 'd8eeb92e4d7b45f0b609702d7ea83410';
const installationId = '4d801bf1-c74f-4d3a-994b-3d4b1a42a3e4';
const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
});

afterAll(() => rmSync(keyDirectory, { recursive: true, force: true }));

function generateTestKey(passphrase = ''): { private: string; public: string } {
  // ssh2 1.17's test-key generator truncates an Ed25519 public key beginning with
  // zero (about 1/256 keys). Real OpenSSH generation preserves all 32 bytes.
  const file = join(keyDirectory, randomUUID());
  execFileSync(
    'ssh-keygen',
    ['-q', '-t', 'ed25519', '-a', '16', '-Z', 'aes256-ctr', '-N', passphrase, '-f', file],
    { stdio: 'ignore', timeout: 5000 },
  );
  return { private: readFileSync(file, 'utf8'), public: readFileSync(file + '.pub', 'utf8') };
}

function observation(overrides: Record<string, unknown> = {}) {
  return {
    machineId,
    hostname: 'ozz-test-node',
    os: 'ubuntu',
    osVersion: '24.04',
    architecture: 'arm64',
    kernel: '6.8.0-test',
    init: 'systemd',
    cpuCount: 2,
    memoryBytes: 4 * 1024 ** 3,
    memoryAvailableBytes: 3 * 1024 ** 3,
    rootDiskBytes: 80 * 1024 ** 3,
    rootDiskAvailableBytes: 60 * 1024 ** 3,
    dataDiskBytes: 80 * 1024 ** 3,
    dataDiskAvailableBytes: 60 * 1024 ** 3,
    privileged: true,
    memoryCgroupAvailable: true,
    systemdAvailable: true,
    ports: [22, 80, 443, 6443, 10250]
      .map((port) => ({ protocol: 'tcp', port, listening: port === 22 }))
      .concat([{ protocol: 'udp', port: 8472, listening: false }]),
    firewall: 'unknown',
    k3s: {
      installed: false,
      version: null,
      installationId: null,
      installationPhase: null,
      secretsEncryption: 'unknown',
    },
    blockers: [],
    warnings: ['cloud_firewall_unknown', 'firewall_requires_review'],
    ...overrides,
  };
}

function send(channel: ServerChannel, frames: unknown[], exitCode = 0) {
  channel.write(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n');
  channel.exit(exitCode);
  channel.end();
}

async function fixture(
  options: {
    respond?: (script: string, channel: ServerChannel) => void;
    acceptedPassword?: string;
    acceptedPublicKey?: ParsedKey;
  } = {},
) {
  const connections = new Set<Connection>();
  const commands: { command: string; script: string }[] = [];
  let authentications = 0;
  let termSignals = 0;
  const server = new Server({ hostKeys: [hostKey.private] }, (connection) => {
    connections.add(connection);
    connection.on('error', () => {});
    connection.once('close', () => connections.delete(connection));
    connection.on('authentication', (context) => {
      authentications++;
      if (
        context.username === 'ozz' &&
        context.method === 'password' &&
        context.password === (options.acceptedPassword ?? password)
      )
        context.accept();
      else if (
        context.username === 'ozz' &&
        context.method === 'publickey' &&
        options.acceptedPublicKey?.getPublicSSH().equals(context.key.data) &&
        (!context.signature ||
          (context.blob &&
            options.acceptedPublicKey.verify(context.blob, context.signature, context.hashAlgo) ===
              true))
      )
        context.accept();
      else context.reject(['password', 'publickey']);
    });
    connection.on('ready', () =>
      connection.on('session', (accept) => {
        const session = accept();
        session.on('signal', (accept, _reject, info) => {
          if (info.name === 'TERM') termSignals++;
          accept?.();
        });
        session.on('exec', (accept, _reject, info) => {
          const channel = accept();
          let uploaded = Buffer.alloc(0);
          let started = false;
          channel.on('error', () => {});
          channel.stderr.on('error', () => {});
          channel.on('data', (chunk: Buffer) => {
            if (started) return;
            uploaded = Buffer.concat([uploaded, chunk]);
            const newline = uploaded.indexOf(10);
            if (newline < 0) return;
            const size = Number(uploaded.subarray(0, newline).toString('ascii'));
            if (uploaded.length < newline + 1 + size) return;
            started = true;
            const script = uploaded.subarray(newline + 1, newline + 1 + size).toString('utf8');
            commands.push({ command: info.command, script });
            if (options.respond) options.respond(script, channel);
            else send(channel, [{ type: 'preflight', data: observation() }]);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test SSH socket is missing.');
  const target: SshTarget = {
    host: '127.0.0.1',
    port: address.port,
    username: 'ozz',
    hostKeyFingerprint: fingerprint,
  };
  disposers.push(async () => {
    for (const connection of connections) connection.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    target,
    commands,
    connections,
    get authentications() {
      return authentications;
    },
    get termSignals() {
      return termSignals;
    },
  };
}

function initialization(overrides: Partial<SshInitializeOptions> = {}): SshInitializeOptions {
  return {
    installationId,
    expectedMachineId: machineId,
    apiEndpoint: 'https://127.0.0.1:36443',
    nodeName: 'ozz-node',
    onCredential: () => {},
    ...overrides,
  };
}

const encodedSecret = Buffer.from(
  'synthetic-bootstrap-credential-private-material-never-in-results',
).toString('base64');
function initializedFrames() {
  return [
    ...['downloading', 'installing', 'starting', 'waiting_ready', 'verifying_encryption'].map(
      (stage) => ({ type: 'progress', stage }),
    ),
    {
      type: 'credential',
      kubeconfig: {
        apiVersion: 'v1',
        kind: 'Config',
        'current-context': 'default',
        clusters: [
          {
            name: 'default',
            cluster: {
              server: 'https://127.0.0.1:36443',
              'certificate-authority-data': encodedSecret,
            },
          },
        ],
        users: [
          {
            name: 'default',
            user: { 'client-certificate-data': encodedSecret, 'client-key-data': encodedSecret },
          },
        ],
        contexts: [{ name: 'default', context: { cluster: 'default', user: 'default' } }],
      },
    },
    {
      type: 'initialized',
      data: {
        installationId,
        machineId,
        architecture: 'arm64',
        version: K3S_VERSION,
        nodeName: 'ozz-node',
        apiEndpoint: 'https://127.0.0.1:36443',
        secretsEncryption: 'enabled',
        resumed: false,
      },
    },
  ];
}

describe('SSH adapter across a real SSH transport', () => {
  it('observes the host key without authenticating, opening a session or persisting trust', async () => {
    const server = await fixture();
    const adapter = new SshAdapter();
    await expect(adapter.discoverHostKey(server.target)).resolves.toMatchObject({
      fingerprint,
      algorithm: 'ssh-ed25519',
    });
    expect(server.authentications).toBe(0);
    expect(server.commands).toHaveLength(0);
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('refuses a changed fingerprint before sending a password or executing any command', async () => {
    const server = await fixture();
    const adapter = new SshAdapter();
    await expect(
      adapter.preflight(
        { ...server.target, hostKeyFingerprint: 'SHA256:' + 'a'.repeat(43) },
        { password },
      ),
    ).rejects.toMatchObject({ code: 'SSH_FINGERPRINT_MISMATCH', sideEffects: 'none' });
    expect(server.authentications).toBe(0);
    expect(server.commands).toHaveLength(0);
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('authenticates a password, returns only validated observations and closes all resources', async () => {
    const server = await fixture({
      respond: (_script, channel) => {
        channel.stderr.write(password);
        send(channel, [{ type: 'preflight', data: observation({ unexpectedSecret: password }) }]);
      },
    });
    const result = await new SshAdapter().preflight(server.target, { password });
    expect(result).toMatchObject({
      machineId,
      os: 'ubuntu',
      architecture: 'arm64',
      privileged: true,
      k3s: { installed: false },
    });
    expect(Date.parse(result.observedAt)).toBeGreaterThan(Date.now() - 10_000);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(server.commands).toHaveLength(1);
    expect(server.commands[0]!.script).not.toContain(password);
    expect(server.commands[0]!.command).not.toContain(server.target.username);
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('supports a passphrase protected private key without an agent or keyboard interactive fallback', async () => {
    const passphrase = 'synthetic-key-passphrase';
    const key = generateTestKey(passphrase);
    const parsed = utils.parseKey(key.private, passphrase) as ParsedKey;
    const server = await fixture({ acceptedPublicKey: parsed });
    await expect(
      new SshAdapter().preflight(server.target, { privateKey: key.private, passphrase }),
    ).resolves.toMatchObject({ machineId });
    const before = server.authentications;
    await expect(
      new SshAdapter().preflight(server.target, {
        privateKey: key.private,
        passphrase: 'wrong-passphrase',
      }),
    ).rejects.toMatchObject({ code: 'SSH_INVALID_CREDENTIAL' });
    expect(server.authentications).toBe(before);
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('classifies authentication errors without including a credential or remote exception', async () => {
    const server = await fixture({ acceptedPassword: 'another-password' });
    const error = await new SshAdapter()
      .preflight(server.target, { password })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(SshAdapterError);
    expect(error).toMatchObject({ code: 'SSH_AUTH_FAILED', sideEffects: 'none' });
    expect(String(error) + JSON.stringify(error)).not.toContain(password);
    expect(server.commands).toHaveLength(0);
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('rejects invalid endpoint and mixed authentication inputs before opening a connection', async () => {
    const server = await fixture();
    for (const host of [
      'host;bad-command',
      'user@host',
      'host\nname',
      '-oProxyCommand=bad',
      'https://host',
      '`bad`',
    ]) {
      await expect(
        new SshAdapter().preflight({ ...server.target, host }, { password }),
      ).rejects.toMatchObject({ code: 'SSH_INVALID_TARGET' });
    }
    for (const input of [
      { password, privateKey: hostKey.private },
      { password, passphrase: 'extra' },
      { password, agent: '/tmp/agent' },
      { password: '' },
    ]) {
      expect(() => parseSshCredential(input)).toThrow(SshAdapterError);
    }
    expect(server.authentications).toBe(0);
    expect(server.commands).toHaveLength(0);
  });

  it('bounds stalled handshakes and tears down the underlying socket', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', () => {});
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    disposers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error();
    await expect(
      new SshAdapter({ connectTimeoutMs: 100 }).discoverHostKey({
        host: '127.0.0.1',
        port: address.port,
      }),
    ).rejects.toMatchObject({ code: 'SSH_TIMEOUT' });
    await expect.poll(() => sockets.size).toBe(0);
  });

  it('interrupts a running preflight and closes its channel and client', async () => {
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const server = await fixture({ respond: () => commandStarted() });
    const controller = new AbortController();
    const pending = new SshAdapter().preflight(
      server.target,
      { password },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SSH_CANCELLED',
      sideEffects: 'none',
    });
    await started;
    controller.abort();
    await rejected;
    await expect.poll(() => server.connections.size).toBe(0);
    expect(server.termSignals).toBe(1);
  });

  it('bounds a connected command independently of handshake readiness', async () => {
    const server = await fixture({ respond: () => {} });
    await expect(
      new SshAdapter({ preflightTimeoutMs: 100 }).preflight(server.target, { password }),
    ).rejects.toMatchObject({ code: 'SSH_TIMEOUT', sideEffects: 'none' });
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it.each(['stdout', 'stderr'])(
    'caps %s before unbounded output can enter observations or logs',
    async (stream) => {
      const server = await fixture({
        respond: (_script, channel) => {
          (stream === 'stdout' ? channel : channel.stderr).write(Buffer.alloc(32 * 1024, 65));
        },
      });
      await expect(
        new SshAdapter({ maxOutputBytes: 8192 }).preflight(server.target, { password }),
      ).rejects.toMatchObject({ code: 'SSH_OUTPUT_LIMIT' });
      await expect.poll(() => server.connections.size).toBe(0);
    },
  );

  it('keeps concurrent servers and machine observations separate', async () => {
    const otherMachine = 'f424afad08434f8096d7b6158644e096';
    const first = await fixture();
    const second = await fixture({
      respond: (_script, channel) =>
        send(channel, [{ type: 'preflight', data: observation({ machineId: otherMachine }) }]),
    });
    const adapter = new SshAdapter();
    const results = await Promise.all([
      adapter.preflight(first.target, { password }),
      adapter.preflight(second.target, { password }),
    ]);
    expect(results.map((result) => result.machineId)).toEqual([machineId, otherMachine]);
    await expect.poll(() => first.connections.size + second.connections.size).toBe(0);
  });

  it('does not trust malformed, failed or excessive protocol frames', async () => {
    for (const frames of [
      [{ type: 'preflight', data: observation({ memoryAvailableBytes: Number.MAX_SAFE_INTEGER }) }],
      [{ type: 'unexpected', message: password }],
      [{ type: 'error', code: password, message: password }],
      Array.from({ length: 33 }, () => ({ type: 'progress', stage: 'preflight' })),
    ]) {
      const server = await fixture({ respond: (_script, channel) => send(channel, frames) });
      const error = await new SshAdapter()
        .preflight(server.target, { password })
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SshAdapterError);
      expect(String(error) + JSON.stringify(error)).not.toContain(password);
    }
  });
});

describe('immutable SSH initialization and credential handoff', () => {
  it.each([
    { override: { machineId: '0'.repeat(32) }, code: 'SSH_IDENTITY_CHANGED' },
    {
      override: {
        k3s: {
          installed: true,
          version: K3S_VERSION,
          installationId: null,
          installationPhase: null,
          secretsEncryption: 'unknown',
        },
      },
      code: 'SSH_K3S_ALREADY_INSTALLED',
    },
    { override: { privileged: false }, code: 'SSH_PRIVILEGE_REQUIRED' },
    { override: { blockers: ['ports_in_use'] }, code: 'SSH_PREFLIGHT_BLOCKED' },
    {
      override: {
        k3s: {
          installed: true,
          version: K3S_VERSION,
          installationId: '45423c1b-4e64-4340-ac4b-0e4570976956',
          installationPhase: 'prepared',
          secretsEncryption: 'enabled',
        },
      },
      code: 'SSH_INSTALLATION_CONFLICT',
    },
  ])('stops at read-only preflight for $code', async ({ override, code }) => {
    const server = await fixture({
      respond: (_script, channel) =>
        send(channel, [{ type: 'preflight', data: observation(override) }]),
    });
    const onCredential = vi.fn();
    await expect(
      new SshAdapter().initialize(server.target, { password }, initialization({ onCredential })),
    ).rejects.toMatchObject({ code, sideEffects: 'none' });
    expect(server.commands).toHaveLength(1);
    expect(onCredential).not.toHaveBeenCalled();
  });

  it('hands credentials only to the required callback and returns bounded safe progress', async () => {
    const server = await fixture({
      respond: (script, channel) =>
        send(
          channel,
          script.includes('INTENT =')
            ? initializedFrames()
            : [{ type: 'preflight', data: observation() }],
        ),
    });
    const onCredential = vi.fn();
    const onProgress = vi.fn();
    const result = await new SshAdapter().initialize(
      server.target,
      { password },
      initialization({ onCredential, onProgress }),
    );
    expect(result).toMatchObject({
      installationId,
      machineId,
      version: K3S_VERSION,
      apiEndpoint: 'https://127.0.0.1:36443',
      resumed: false,
    });
    expect(JSON.stringify(result)).not.toContain(encodedSecret);
    expect(JSON.stringify(onProgress.mock.calls)).not.toContain(encodedSecret);
    expect(onCredential).toHaveBeenCalledOnce();
    const config = JSON.parse(onCredential.mock.calls[0]![0] as string);
    expect(config.clusters[0].cluster.server).toBe('https://127.0.0.1:36443');
    expect(config.users[0].user['client-key-data']).toBe(encodedSecret);
    expect(onProgress.mock.calls.map(([progress]) => progress.stage)).toEqual([
      'connecting',
      'preflight',
      'downloading',
      'installing',
      'starting',
      'waiting_ready',
      'verifying_encryption',
      'storing_credential',
      'completed',
    ]);
    expect(server.commands).toHaveLength(2);
    expect(server.commands[1]!.script).not.toContain(password);
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('preserves evidence of possible remote changes when credential encryption fails', async () => {
    const server = await fixture({
      respond: (script, channel) =>
        send(
          channel,
          script.includes('INTENT =')
            ? initializedFrames()
            : [{ type: 'preflight', data: observation() }],
        ),
    });
    const error = await new SshAdapter()
      .initialize(
        server.target,
        { password },
        initialization({
          onCredential: () => {
            throw new Error(encodedSecret);
          },
        }),
      )
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'SSH_CREDENTIAL_STORE_FAILED',
      sideEffects: 'may_have_changed',
    });
    expect(String(error) + JSON.stringify(error)).not.toContain(encodedSecret);
    expect(server.commands).toHaveLength(2);
  });

  it('stops a running installation on cancellation and marks that remote changes may remain', async () => {
    let installStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      installStarted = resolve;
    });
    const server = await fixture({
      respond: (script, channel) => {
        if (!script.includes('INTENT ='))
          send(channel, [{ type: 'preflight', data: observation() }]);
        else {
          channel.write(JSON.stringify({ type: 'progress', stage: 'downloading' }) + '\n');
          installStarted();
        }
      },
    });
    const controller = new AbortController();
    const onCredential = vi.fn();
    const pending = new SshAdapter().initialize(
      server.target,
      { password },
      initialization({ signal: controller.signal, onCredential }),
    );
    const rejected = expect(pending).rejects.toMatchObject({
      code: 'SSH_CANCELLED',
      sideEffects: 'may_have_changed',
    });
    await started;
    controller.abort();
    await rejected;
    expect(onCredential).not.toHaveBeenCalled();
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('halts remote work if a durable progress callback fails', async () => {
    const server = await fixture({
      respond: (script, channel) => {
        if (!script.includes('INTENT ='))
          send(channel, [{ type: 'preflight', data: observation() }]);
        else channel.write(JSON.stringify({ type: 'progress', stage: 'downloading' }) + '\n');
      },
    });
    await expect(
      new SshAdapter().initialize(
        server.target,
        { password },
        initialization({
          onProgress: ({ stage }) => {
            if (stage === 'downloading') throw new Error(password);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SSH_PROGRESS_FAILED', sideEffects: 'may_have_changed' });
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('retains the execution timeout when cancellation also interrupts a pending progress write', async () => {
    const server = await fixture({
      respond: (script, channel) => {
        if (!script.includes('INTENT ='))
          send(channel, [{ type: 'preflight', data: observation() }]);
        else channel.write(JSON.stringify({ type: 'progress', stage: 'downloading' }) + '\n');
      },
    });
    await expect(
      new SshAdapter({ initializeTimeoutMs: 100 }).initialize(
        server.target,
        { password },
        initialization({
          onProgress: ({ stage }) => {
            if (stage === 'downloading') return new Promise<void>(() => {});
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'SSH_TIMEOUT', sideEffects: 'may_have_changed' });
    await expect.poll(() => server.connections.size).toBe(0);
  });

  it('refuses a credential frame with implicit execution before calling the encryption hook', async () => {
    const frames = initializedFrames();
    const credential = frames.find((frame) => 'kubeconfig' in frame);
    if (!credential || !('kubeconfig' in credential)) throw new Error();
    Object.assign(credential.kubeconfig.users[0]!.user, { exec: { command: password } });
    const server = await fixture({
      respond: (script, channel) =>
        send(
          channel,
          script.includes('INTENT =') ? frames : [{ type: 'preflight', data: observation() }],
        ),
    });
    const onCredential = vi.fn();
    const error = await new SshAdapter()
      .initialize(server.target, { password }, initialization({ onCredential }))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'SSH_INVALID_RESPONSE', sideEffects: 'may_have_changed' });
    expect(String(error) + JSON.stringify(error)).not.toContain(password);
    expect(onCredential).not.toHaveBeenCalled();
  });

  it('rejects endpoint and machine changes before SSH connects', async () => {
    const server = await fixture();
    for (const override of [
      { apiEndpoint: 'http://example.test:6443' },
      { apiEndpoint: 'https://user:password@example.test:6443' },
      { apiEndpoint: 'https://example.test:6443/path' },
      { nodeName: 'node;bad' },
      { installationId: 'not-a-durable-id' },
      { expectedMachineId: 'unknown' },
    ])
      await expect(
        new SshAdapter().initialize(server.target, { password }, initialization(override)),
      ).rejects.toMatchObject({ code: 'SSH_INVALID_INSTALLATION', sideEffects: 'none' });
    expect(server.authentications).toBe(0);
    expect(server.commands).toHaveLength(0);
  });
});
