import { Agent } from 'node:https';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  ManualDataError,
  MAX_ARTIFACT_BYTES,
  MAX_METADATA_BYTES,
  fail,
  privateHandle,
} from './manual-data-core.mjs';
import { connectionMaterial } from '../packages/infrastructure/dist/kubernetes/config.js';

const WebSocket = createRequire(
  new URL('../packages/infrastructure/package.json', import.meta.url),
)('ws');
/** Private operator transport. CLI callers select commands from manual-data-commands, never arbitrary argv. */
export async function executeChannel(
  connection,
  selection,
  command,
  { inputFile = null, outputFile = null, maximum = MAX_METADATA_BYTES, timeoutMs = 900_000 } = {},
) {
  if (
    ![selection.namespace, selection.name].every(
      (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9.-]{0,251}[a-z0-9]$/.test(v),
    ) ||
    !Array.isArray(command) ||
    !command.length ||
    command.length > 200 ||
    command.some((v) => typeof v !== 'string' || v.includes('\0')) ||
    Buffer.byteLength(JSON.stringify(command)) > 64 * 1024 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > MAX_ARTIFACT_BYTES
  )
    fail('MANUAL_EXEC_INPUT', '远端固定命令目标或边界无效。');
  const material = connectionMaterial(connection),
    agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      ca: material.ca,
      cert: material.certificate,
      key: material.privateKey,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    });
  const url = new URL(
    `/api/v1/namespaces/${selection.namespace}/pods/${selection.name}/exec`,
    connection.endpoint,
  );
  url.protocol = 'wss:';
  url.searchParams.set('container', 'app');
  url.searchParams.set('stdout', 'true');
  url.searchParams.set('stderr', 'true');
  url.searchParams.set('stdin', String(Boolean(inputFile)));
  url.searchParams.set('tty', 'false');
  for (const arg of command) url.searchParams.append('command', arg);
  let output,
    input,
    socket,
    settled = false,
    statusSeen = false,
    stdoutBytes = 0,
    stderrBytes = 0,
    pendingBytes = 0,
    wireFrames = 0,
    inputBytes = 0,
    inputComplete = false;
  const chunks = [];
  let writes = Promise.resolve(),
    inputWork = Promise.resolve();
  try {
    if (outputFile) output = await open(outputFile, 'wx', 0o600);
    if (inputFile) input = await privateHandle(inputFile, MAX_ARTIFACT_BYTES);
    return await new Promise((resolve, reject) => {
      const timeout = globalThis.AbortSignal.timeout(timeoutMs);
      const stop = (code) => {
        if (settled) return;
        settled = true;
        reject(new ManualDataError(code, '固定远端操作未完成；保留原数据、维护状态和不完整证据。'));
        socket?.terminate();
      };
      timeout.addEventListener('abort', () => stop('MANUAL_EXEC_TIMEOUT'), { once: true });
      socket = new WebSocket(url, ['v5.channel.k8s.io'], {
        agent,
        followRedirects: false,
        handshakeTimeout: 5000,
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
        rejectUnauthorized: true,
        headers: {
          'User-Agent': 'ozz-manual-data/1.0.0',
          ...(material.token ? { Authorization: `Bearer ${material.token}` } : {}),
        },
      });
      const send = (bytes) =>
        new Promise((yes, no) =>
          socket.send(bytes, { binary: true }, (error) => (error ? no(error) : yes())),
        );
      socket.once('open', () => {
        if (socket.protocol !== 'v5.channel.k8s.io') {
          stop('MANUAL_EXEC_PROTOCOL');
          return;
        }
        inputWork = (async () => {
          if (!input) return;
          for await (const chunk of input.createReadStream({
            autoClose: false,
            highWaterMark: 32 * 1024,
          })) {
            if (settled || statusSeen) break;
            inputBytes += chunk.length;
            if (inputBytes > MAX_ARTIFACT_BYTES) throw new Error('bound');
            await send(Buffer.concat([Buffer.from([0]), chunk]));
          }
          if (!settled && !statusSeen) {
            await send(Buffer.from([255, 0]));
            inputComplete = true;
          }
        })().catch(() => stop('MANUAL_EXEC_INPUT_FAILED'));
      });
      socket.on('unexpected-response', (_request, response) => {
        response.destroy();
        stop('MANUAL_EXEC_REJECTED');
      });
      socket.on('error', () => stop('MANUAL_EXEC_CONNECTION'));
      socket.on('close', () => {
        if (!statusSeen) stop('MANUAL_EXEC_STATUS_MISSING');
      });
      socket.on('message', (raw, binary) => {
        if (settled) return;
        const frame = Buffer.isBuffer(raw)
          ? raw
          : Array.isArray(raw)
            ? Buffer.concat(raw)
            : Buffer.from(raw);
        wireFrames++;
        if (!binary || frame.length < 1 || wireFrames > 1_000_000) {
          stop('MANUAL_EXEC_PROTOCOL');
          return;
        }
        const channel = frame[0],
          bytes = frame.subarray(1);
        if (channel === 255) {
          if (frame.length !== 2 || ![0, 1, 2].includes(frame[1])) stop('MANUAL_EXEC_PROTOCOL');
          return;
        }
        if (statusSeen) {
          stop('MANUAL_EXEC_PROTOCOL');
          return;
        }
        if (channel === 1) {
          stdoutBytes += bytes.length;
          pendingBytes += bytes.length;
          if (stdoutBytes > maximum || pendingBytes > 4 * 1024 * 1024) {
            stop('MANUAL_EXEC_TOO_LARGE');
            return;
          }
          if (output) {
            if (pendingBytes >= 512 * 1024) socket.pause();
            writes = writes
              .then(async () => {
                let offset = 0;
                while (offset < bytes.length) {
                  const result = await output.write(bytes, offset, bytes.length - offset);
                  if (!result.bytesWritten) throw new Error('short write');
                  offset += result.bytesWritten;
                }
                pendingBytes -= bytes.length;
                if (pendingBytes < 512 * 1024 && !settled) socket.resume();
              })
              .catch(() => stop('MANUAL_EXEC_OUTPUT_FAILED'));
          } else {
            chunks.push(bytes);
            pendingBytes -= bytes.length;
          }
        } else if (channel === 2) {
          stderrBytes += bytes.length;
          if (stderrBytes > 1024 * 1024) stop('MANUAL_EXEC_TOO_LARGE');
        } else if (channel === 3) {
          if (bytes.length > 16 * 1024) {
            stop('MANUAL_EXEC_PROTOCOL');
            return;
          }
          let status;
          try {
            status = JSON.parse(bytes.toString('utf8'));
          } catch {
            stop('MANUAL_EXEC_PROTOCOL');
            return;
          }
          if (
            status.status !== 'Success' ||
            status.details?.causes?.some(
              (cause) => cause.reason === 'ExitCode' && cause.message !== '0',
            )
          ) {
            stop('MANUAL_EXEC_FAILED');
            return;
          }
          statusSeen = true;
          void (async () => {
            await writes;
            await inputWork;
            if (settled) return;
            if (input && !inputComplete) {
              stop('MANUAL_EXEC_INPUT_INCOMPLETE');
              return;
            }
            if (output) await output.sync();
            settled = true;
            socket.close();
            resolve({
              stdout: output ? null : Buffer.concat(chunks, stdoutBytes),
              sizeBytes: String(stdoutBytes),
              inputBytes: String(inputBytes),
            });
          })().catch(() => stop('MANUAL_EXEC_OUTPUT_FAILED'));
        } else stop('MANUAL_EXEC_PROTOCOL');
      });
    });
  } finally {
    socket?.terminate();
    agent.destroy();
    await writes;
    await inputWork;
    await output?.close();
    await input?.close();
  }
}
