import { createHash, timingSafeEqual } from 'node:crypto';
import {
  Client,
  utils,
  type ClientChannel,
  type ConnectConfig,
  type ServerHostKeyAlgorithm,
} from 'ssh2';
import {
  SshAdapterError,
  type SshCredential,
  type SshEndpoint,
  type SshHostKey,
  type SshTarget,
} from './contracts.js';

const hostAlgorithms: ServerHostKeyAlgorithm[] = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
];

function close(client: Client, channel?: ClientChannel): void {
  // Closing a transport must not discard an earlier, safely classified error.
  try {
    channel?.signal('TERM');
  } catch {
    /* Already disconnected. */
  }
  try {
    channel?.close();
  } catch {
    /* Already disconnected. */
  }
  try {
    client.end();
  } catch {
    /* Already disconnected. */
  }
  try {
    client.destroy();
  } catch {
    /* Already disconnected. */
  }
}

function keyObservation(key: Buffer): SshHostKey {
  if (!Buffer.isBuffer(key) || key.length < 8 || key.length > 16 * 1024)
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const length = key.readUInt32BE(0);
  if (length < 1 || length > 64 || length + 4 > key.length)
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  const algorithm = key.subarray(4, 4 + length).toString('ascii');
  if (
    ![
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'ssh-rsa',
    ].includes(algorithm)
  )
    throw new SshAdapterError('SSH_INVALID_RESPONSE');
  return {
    fingerprint: 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, ''),
    algorithm,
    observedAt: new Date().toISOString(),
  };
}

function connectionError(error: unknown, fingerprintMismatch = false): SshAdapterError {
  if (fingerprintMismatch) return new SshAdapterError('SSH_FINGERPRINT_MISMATCH');
  const level = error && typeof error === 'object' && 'level' in error ? error.level : undefined;
  if (level === 'client-authentication') return new SshAdapterError('SSH_AUTH_FAILED');
  if (level === 'client-timeout') return new SshAdapterError('SSH_TIMEOUT');
  return new SshAdapterError('SSH_CONNECTION_FAILED');
}

function baseConfig(endpoint: SshEndpoint, timeoutMs: number): ConnectConfig {
  return {
    host: endpoint.host,
    port: endpoint.port,
    readyTimeout: timeoutMs,
    keepaliveInterval: 5_000,
    keepaliveCountMax: 2,
    algorithms: { serverHostKey: [...hostAlgorithms] },
    tryKeyboard: false,
    agentForward: false,
  };
}

/** Returns the observed key only after rejecting it, before SSH user authentication. */
export async function discover(
  endpoint: SshEndpoint,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<SshHostKey> {
  if (signal?.aborted) throw new SshAdapterError('SSH_CANCELLED');
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let observation: SshHostKey | undefined;
    const finish = (error?: SshAdapterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      close(client);
      if (error) reject(error);
      else if (observation) resolve(observation);
      else reject(new SshAdapterError('SSH_CONNECTION_FAILED'));
    };
    const abort = () => finish(new SshAdapterError('SSH_CANCELLED'));
    const timer = setTimeout(() => finish(new SshAdapterError('SSH_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    client.on('error', (error: unknown) =>
      finish(observation ? undefined : connectionError(error)),
    );
    client.on('close', () => finish());
    client.once('ready', () => finish(new SshAdapterError('SSH_INVALID_RESPONSE')));
    try {
      client.connect({
        ...baseConfig(endpoint, timeoutMs),
        username: 'ozz-host-key-discovery',
        authHandler: [],
        hostVerifier: (key: Buffer) => {
          try {
            observation = keyObservation(key);
          } catch {
            finish(new SshAdapterError('SSH_INVALID_RESPONSE'));
          }
          // ssh2 emits a verification error; capture the observation without accepting trust.
          return false;
        },
      });
    } catch {
      finish(new SshAdapterError('SSH_CONNECTION_FAILED'));
    }
  });
}

export async function connect(
  target: SshTarget,
  credential: SshCredential,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Client> {
  if (signal?.aborted) throw new SshAdapterError('SSH_CANCELLED');
  if (credential.privateKey !== undefined) {
    try {
      const parsed = utils.parseKey(credential.privateKey, credential.passphrase);
      if (parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey())
        throw new Error();
    } catch {
      throw new SshAdapterError('SSH_INVALID_CREDENTIAL');
    }
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let mismatch = false;
    const finish = (error?: SshAdapterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        close(client);
        reject(error);
      } else resolve(client);
    };
    const abort = () => finish(new SshAdapterError('SSH_CANCELLED'));
    const timer = setTimeout(() => finish(new SshAdapterError('SSH_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    client.on('error', (error: unknown) => finish(connectionError(error, mismatch)));
    client.once('close', () =>
      finish(new SshAdapterError(mismatch ? 'SSH_FINGERPRINT_MISMATCH' : 'SSH_CONNECTION_FAILED')),
    );
    client.once('ready', () => finish());
    try {
      client.connect({
        ...baseConfig(target, timeoutMs),
        username: target.username,
        ...credential,
        authHandler: credential.privateKey === undefined ? ['password'] : ['publickey'],
        hostVerifier: (key: Buffer) => {
          try {
            const actual = Buffer.from(keyObservation(key).fingerprint);
            const expected = Buffer.from(target.hostKeyFingerprint);
            const matches = actual.length === expected.length && timingSafeEqual(actual, expected);
            mismatch = !matches;
            return matches;
          } catch {
            mismatch = true;
            return false;
          }
        },
      });
    } catch {
      finish(new SshAdapterError('SSH_INVALID_CREDENTIAL'));
    }
  });
}

export interface RemoteOutput {
  exitCode: number | null;
}

export async function execute(
  client: Client,
  command: string,
  script: string,
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    onStdout?: (chunk: Buffer) => void;
  },
): Promise<RemoteOutput> {
  if (options.signal?.aborted) {
    close(client);
    throw new SshAdapterError('SSH_CANCELLED');
  }
  return new Promise((resolve, reject) => {
    let channel: ClientChannel | undefined;
    let settled = false;
    let exitCode: number | null = null;
    let outputBytes = 0;
    const finish = (error?: SshAdapterError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      client.off('error', failed);
      client.off('close', disconnected);
      close(client, error ? channel : undefined);
      if (error) reject(error);
      else resolve({ exitCode });
    };
    const abort = () => finish(new SshAdapterError('SSH_CANCELLED'));
    const failed = () => finish(new SshAdapterError('SSH_CONNECTION_FAILED'));
    const disconnected = () => finish(new SshAdapterError('SSH_CONNECTION_FAILED'));
    const timer = setTimeout(() => finish(new SshAdapterError('SSH_TIMEOUT')), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    client.on('error', failed);
    client.on('close', disconnected);
    const receive = (value: Buffer, stdout: boolean) => {
      if (settled) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        finish(new SshAdapterError('SSH_OUTPUT_LIMIT'));
        return;
      }
      if (stdout) {
        try {
          options.onStdout?.(chunk);
        } catch (error) {
          finish(
            error instanceof SshAdapterError ? error : new SshAdapterError('SSH_INVALID_RESPONSE'),
          );
        }
      }
    };
    try {
      client.exec(command, { pty: false }, (error, stream) => {
        if (settled) {
          close(client, stream);
          return;
        }
        if (error) {
          finish(new SshAdapterError('SSH_REMOTE_FAILED'));
          return;
        }
        channel = stream;
        stream.on('data', (chunk: Buffer) => receive(chunk, true));
        stream.stderr.on('data', (chunk: Buffer) => receive(chunk, false));
        stream.stderr.on('error', failed);
        stream.on('error', failed);
        stream.once('exit', (code: number | null) => {
          exitCode = Number.isInteger(code) ? code : null;
        });
        stream.once('close', () => finish());
        const bytes = Buffer.from(script, 'utf8');
        if (bytes.length < 1 || bytes.length > 256 * 1024) {
          finish(new SshAdapterError('SSH_REMOTE_FAILED'));
          return;
        }
        stream.write(String(bytes.length) + '\n');
        stream.write(bytes);
      });
    } catch {
      finish(new SshAdapterError('SSH_REMOTE_FAILED'));
    }
  });
}
