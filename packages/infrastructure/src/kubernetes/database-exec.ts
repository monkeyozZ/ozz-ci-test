import { Agent } from 'node:https';
import { Writable } from 'node:stream';
import WebSocket from 'ws';
import type { Exec, V1Status } from '@kubernetes/client-node' with { 'resolution-mode': 'import' };
import { connectionMaterial } from './config.js';
import type { ParsedKubernetesConnection } from './contracts.js';
type WebSocketInterface = NonNullable<ConstructorParameters<typeof Exec>[1]>;

const postgresql = `
export PGCONNECT_TIMEOUT=4
export PGPASSWORD="\${POSTGRES_PASSWORD:-}"
if [ -z "$PGPASSWORD" ] && [ -r /run/ozz/database/password ]; then
  PGPASSWORD="$(cat /run/ozz/database/password)"; export PGPASSWORD
fi
[ -n "$PGPASSWORD" ] || exit 40
if PGPASSWORD=ozz-deliberately-invalid-auth-probe psql -X -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c 'SELECT 1' >/dev/null 2>&1; then exit 41; fi
exec psql -X -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT json_build_object('version', current_setting('server_version'), 'version_num', current_setting('server_version_num'), 'username', current_user, 'database', current_database())::text"
`;
const redis = `
export REDISCLI_AUTH="\${REDIS_PASSWORD:-}"
if [ -z "$REDISCLI_AUTH" ] && [ -r /run/ozz/database/password ]; then
  REDISCLI_AUTH="$(cat /run/ozz/database/password)"; export REDISCLI_AUTH
fi
[ -n "$REDISCLI_AUTH" ] || exit 40
if REDISCLI_AUTH=ozz-deliberately-invalid-auth-probe redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" ACL WHOAMI >/dev/null 2>&1; then exit 41; fi
printf '__OZZ_USER__\\n'
redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" ACL WHOAMI
printf '__OZZ_SERVER__\\n'
redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" INFO server
printf '__OZZ_PERSISTENCE__\\n'
redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" INFO persistence
printf '__OZZ_APPENDONLY__\\n'
redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" CONFIG GET appendonly
printf '__OZZ_APPENDSYNC__\\n'
redis-cli --no-auth-warning --raw -e -h 127.0.0.1 -p 6379 --user "$REDIS_USERNAME" CONFIG GET appendfsync
`;

export class DatabaseExecError extends Error {
  constructor(
    readonly code:
      | 'DATABASE_EXEC_UNAVAILABLE'
      | 'DATABASE_EXEC_TOO_LARGE'
      | 'DATABASE_EXEC_TIMEOUT'
      | 'DATABASE_EXEC_CANCELLED',
  ) {
    super(code);
    this.name = 'DatabaseExecError';
  }
}

/** Internal-only output. Public database observations select numeric versions and controlled facts. */
export interface DatabaseExecResult {
  stdout: string;
  exitCode: number | null;
}
export async function executeDatabaseCheck(
  connection: ParsedKubernetesConnection,
  selection: { namespace: string; name: string },
  engine: 'postgresql' | 'redis',
  external: AbortSignal,
): Promise<DatabaseExecResult> {
  if (
    ![selection.namespace, selection.name].every(
      (value) => /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(value) && value.length <= 253,
    )
  )
    throw new DatabaseExecError('DATABASE_EXEC_UNAVAILABLE');
  const sdk = await import('@kubernetes/client-node');
  const timeout = AbortSignal.timeout(15_000);
  const signal = AbortSignal.any([external, timeout]);
  const material = connectionMaterial(connection);
  const agent = new Agent({
    keepAlive: false,
    maxSockets: 1,
    ca: material.ca,
    cert: material.certificate,
    key: material.privateKey,
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  });
  const chunks: Buffer[] = [];
  let bytes = 0,
    wireBytes = 0,
    socket: WebSocket | undefined,
    settled = false;
  let resolveResult!: (result: DatabaseExecResult) => void,
    rejectResult!: (error: DatabaseExecError) => void;
  const result = new Promise<DatabaseExecResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const fail = (code: DatabaseExecError['code']) => {
    if (settled) return;
    settled = true;
    rejectResult(new DatabaseExecError(code));
    socket?.terminate();
  };
  const onAbort = () =>
    fail(external.aborted ? 'DATABASE_EXEC_CANCELLED' : 'DATABASE_EXEC_TIMEOUT');
  signal.addEventListener('abort', onAbort, { once: true });
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 32 * 1024) fail('DATABASE_EXEC_TOO_LARGE');
      else chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const stderr = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > 32 * 1024) fail('DATABASE_EXEC_TOO_LARGE');
      callback();
    },
  });
  const finish = (status: V1Status) => {
    if (settled) return;
    let exitCode: number | null = status.status === 'Success' ? 0 : null;
    const raw = status.details?.causes?.find((cause) => cause.reason === 'ExitCode')?.message;
    if (raw && /^\d{1,3}$/u.test(raw) && Number(raw) <= 255) exitCode = Number(raw);
    settled = true;
    resolveResult({ stdout: Buffer.concat(chunks).toString('utf8'), exitCode });
    socket?.close();
  };
  // Exec owns command encoding/channel interpretation. This private transport adds TLS,
  // origin, frame/total-byte, cancellation and redirect bounds absent from its default helper.
  const handler: WebSocketInterface = {
    connect: async (path, _textHandler, binaryHandler) => {
      const endpoint = new URL(connection.endpoint);
      endpoint.protocol = 'wss:';
      const url = new URL(path, endpoint);
      if (
        url.origin !== endpoint.origin ||
        url.pathname !== `/api/v1/namespaces/${selection.namespace}/pods/${selection.name}/exec` ||
        url.hash
      )
        throw new DatabaseExecError('DATABASE_EXEC_UNAVAILABLE');
      return await new Promise<WebSocket>((resolve, reject) => {
        const client = new WebSocket(url, ['v4.channel.k8s.io'], {
          agent,
          followRedirects: false,
          handshakeTimeout: 5000,
          maxPayload: 64 * 1024,
          perMessageDeflate: false,
          rejectUnauthorized: true,
          headers: {
            'User-Agent': 'ozz-database-verification/0.1',
            ...(material.token ? { Authorization: `Bearer ${material.token}` } : {}),
          },
        });
        socket = client;
        client.once('open', () => {
          if (signal.aborted || client.protocol !== 'v4.channel.k8s.io') {
            fail(
              signal.aborted
                ? external.aborted
                  ? 'DATABASE_EXEC_CANCELLED'
                  : 'DATABASE_EXEC_TIMEOUT'
                : 'DATABASE_EXEC_UNAVAILABLE',
            );
            reject(new DatabaseExecError('DATABASE_EXEC_UNAVAILABLE'));
            return;
          }
          resolve(client);
        });
        client.on('unexpected-response', (_request, response) => {
          response.destroy();
          fail('DATABASE_EXEC_UNAVAILABLE');
          reject(new DatabaseExecError('DATABASE_EXEC_UNAVAILABLE'));
        });
        client.on('error', () => {
          fail('DATABASE_EXEC_UNAVAILABLE');
          reject(new DatabaseExecError('DATABASE_EXEC_UNAVAILABLE'));
        });
        client.on('close', () => {
          if (!settled) fail('DATABASE_EXEC_UNAVAILABLE');
        });
        client.on('message', (data, isBinary) => {
          if (settled) return;
          const frame = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data);
          wireBytes += frame.length;
          if (wireBytes > 64 * 1024) {
            fail('DATABASE_EXEC_TOO_LARGE');
            return;
          }
          if (
            !isBinary ||
            frame.length < 1 ||
            ![1, 2, 3].includes(frame[0]!) ||
            (frame[0] === 3 && frame.length === 1)
          ) {
            fail('DATABASE_EXEC_UNAVAILABLE');
            return;
          }
          // Kubelet can open stdout/stderr with a channel-only frame before
          // command output arrives. An empty status still cannot prove an exit.
          try {
            if (binaryHandler && !binaryHandler(frame[0]!, frame.subarray(1))) client.close();
          } catch {
            fail('DATABASE_EXEC_UNAVAILABLE');
          }
        });
        if (signal.aborted) {
          onAbort();
          reject(new DatabaseExecError('DATABASE_EXEC_CANCELLED'));
        }
      });
    },
  };
  try {
    if (signal.aborted) onAbort();
    else {
      // A fresh config never loads ~/.kube or SDK global/default auth. The transport owns credentials.
      const config = new sdk.KubeConfig();
      const executor = new sdk.Exec(config, handler);
      void executor
        .exec(
          selection.namespace,
          selection.name,
          'app',
          [
            'timeout',
            '--signal=TERM',
            '--kill-after=2',
            '12',
            'sh',
            '-ceu',
            engine === 'postgresql' ? postgresql : redis,
          ],
          stdout,
          stderr,
          null,
          false,
          finish,
        )
        .catch(() => fail('DATABASE_EXEC_UNAVAILABLE'));
    }
    return await result;
  } finally {
    signal.removeEventListener('abort', onAbort);
    socket?.terminate();
    agent.destroy();
    stdout.destroy();
    stderr.destroy();
  }
}
