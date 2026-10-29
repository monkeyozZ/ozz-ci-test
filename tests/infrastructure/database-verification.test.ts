import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { StorageFixture } from './storage-fixture.js';
import { statefulWorkload } from './workload-s5-fixture.js';

interface TestSocket {
  send(data: Buffer): void;
  close(): void;
  on(event: 'error', listener: () => void): void;
}
interface TestWsServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    connected: (socket: TestSocket) => void,
  ): void;
}
const { WebSocketServer } = createRequire(
  new URL('../../packages/infrastructure/package.json', import.meta.url),
)('ws') as {
  WebSocketServer: new (options: {
    noServer: boolean;
    handleProtocols: () => string;
  }) => TestWsServer;
};
const fixtures: StorageFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
});
const pgOutput = JSON.stringify({
  version: '17.11 (Debian 17.11-1.pgdg12+1)',
  version_num: '170011',
  username: 'app',
  database: 'app',
});
const redisOutput = `__OZZ_USER__
default
__OZZ_SERVER__
# Server
redis_version:7.4.11
__OZZ_PERSISTENCE__
# Persistence
aof_enabled:1
aof_last_write_status:ok
aof_last_bgrewrite_status:ok
__OZZ_APPENDONLY__
appendonly
yes
__OZZ_APPENDSYNC__
appendfsync
everysec
`;
async function setup(engine: 'postgresql' | 'redis' = 'postgresql') {
  const server = new StorageFixture();
  fixtures.push(server);
  await server.start();
  const context = await statefulWorkload(server, engine);
  const requests: URL[] = [];
  const response = {
    stdout: engine === 'postgresql' ? pgOutput : redisOutput,
    stderr: '',
    exitCode: 0,
    malformedStatus: false,
    hold: false,
    redirect: false,
    emptyChannels: [1],
    onExec: () => {},
  };
  const websocket = new WebSocketServer({
    noServer: true,
    handleProtocols: () => 'v4.channel.k8s.io',
  });
  server.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url!, server.endpoint);
    requests.push(url);
    if (
      request.headers.authorization !== `Bearer ${server.token}` ||
      !url.pathname.endsWith('/exec')
    ) {
      socket.destroy();
      return;
    }
    if (response.redirect) {
      socket.end(
        'HTTP/1.1 307 Temporary Redirect\r\nLocation: https://127.0.0.1:9/forbidden\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => {
      client.on('error', () => {});
      if (response.hold) return;
      response.onExec();
      for (const channel of response.emptyChannels) client.send(Buffer.from([channel]));
      if (response.stdout)
        client.send(Buffer.concat([Buffer.from([1]), Buffer.from(response.stdout)]));
      if (response.stderr)
        client.send(Buffer.concat([Buffer.from([2]), Buffer.from(response.stderr)]));
      const status = response.malformedStatus
        ? 'not-json'
        : JSON.stringify(
            response.exitCode === 0
              ? { status: 'Success' }
              : {
                  status: 'Failure',
                  message: 'private-command-error-must-not-escape',
                  details: { causes: [{ reason: 'ExitCode', message: String(response.exitCode) }] },
                },
          );
      client.send(Buffer.concat([Buffer.from([3]), Buffer.from(status)]));
    });
  });
  const verify = (options: { signal?: AbortSignal } = {}) =>
    context.manager.verifyDatabase(
      server.connection(),
      context.target,
      context.state.inventory,
      context.applied.published,
      context.input.configuration.database!,
      options,
    );
  return { ...context, response, requests, verify };
}

describe('bounded engine-authentication verification in an owned StatefulSet Pod', () => {
  it('accepts the channel-only stdout and stderr opening frames sent by kubelet', async () => {
    const { verify, response } = await setup();
    response.emptyChannels = [1, 2];
    expect(await verify()).toMatchObject({ state: 'ready', authenticated: true });
  });
  it('does not accept a channel-only status as command completion', async () => {
    const { verify, response } = await setup();
    response.emptyChannels = [3];
    expect(await verify()).toMatchObject({
      state: 'unknown',
      authenticated: null,
      code: 'DATABASE_EXEC_UNAVAILABLE',
    });
  });
  it('verifies PostgreSQL user, database and actual major with no password in exec arguments or results', async () => {
    const { verify, requests, input, applied } = await setup();
    const result = await verify();
    expect(result).toMatchObject({
      state: 'ready',
      authenticated: true,
      engine: 'postgresql',
      observedMajor: 17,
      version: '17.11',
      username: 'app',
      databaseName: 'app',
      pod: { controller: applied.published.controller },
    });
    const args = requests[0]!.searchParams.getAll('command');
    expect(args.slice(0, 4)).toEqual(['timeout', '--signal=TERM', '--kill-after=2', '12']);
    expect(args.at(-1)).toContain('PGPASSWORD=ozz-deliberately-invalid-auth-probe');
    expect(args.at(-1)).toContain('127.0.0.1');
    for (const secret of input.configuration.environment.filter((item) =>
      item.name.includes('PASSWORD'),
    ))
      expect(JSON.stringify({ args, result })).not.toContain(secret.value);
  });
  it('distinguishes actual engine-major mismatch from successful authentication', async () => {
    const { verify, response } = await setup();
    response.stdout = JSON.stringify({
      version: '18.0',
      version_num: '180000',
      username: 'app',
      database: 'app',
    });
    expect(await verify()).toMatchObject({
      state: 'failed',
      authenticated: true,
      observedMajor: 18,
      code: 'DATABASE_VERSION_MISMATCH',
    });
  });
  it('does not call a database authenticated when the wrong-password check succeeded', async () => {
    const { verify, response } = await setup();
    response.exitCode = 41;
    response.stdout = '';
    expect(await verify()).toMatchObject({
      state: 'failed',
      authenticated: false,
      code: 'DATABASE_AUTHENTICATION_NOT_REQUIRED',
    });
  });
  it('sanitizes failed authentication and arbitrary stderr', async () => {
    const { verify, response } = await setup();
    response.exitCode = 1;
    response.stderr = 'private-database-password-from-server';
    const observed = await verify();
    expect(observed).toMatchObject({
      state: 'failed',
      authenticated: false,
      code: 'DATABASE_AUTHENTICATION_FAILED',
    });
    expect(JSON.stringify(observed)).not.toContain('private-');
  });
  it('checks Redis ACL identity, version, appendonly, everysec and persistence status', async () => {
    const { verify, requests } = await setup('redis');
    expect(await verify()).toMatchObject({
      state: 'ready',
      authenticated: true,
      version: '7.4.11',
      observedMajor: 7,
      redis: { aofEnabled: true, appendfsync: 'everysec', lastWriteStatus: 'ok' },
    });
    const command = requests[0]!.searchParams.getAll('command').at(-1)!;
    expect(command).toContain('REDISCLI_AUTH');
    expect(command).toContain('ACL WHOAMI');
    expect(command).toContain('CONFIG GET appendonly');
    expect(command).not.toContain('synthetic-private-database-password');
  });
  it('refuses Redis without the required AOF persistence behavior', async () => {
    const { verify, response } = await setup('redis');
    response.stdout = redisOutput.replace('aof_enabled:1', 'aof_enabled:0');
    expect(await verify()).toMatchObject({
      state: 'failed',
      authenticated: true,
      code: 'DATABASE_PERSISTENCE_NOT_READY',
      redis: { aofEnabled: false },
    });
    response.stdout = redisOutput.replace('everysec', 'no');
    expect(await verify()).toMatchObject({
      state: 'failed',
      code: 'DATABASE_PERSISTENCE_NOT_READY',
      redis: { appendfsync: 'no' },
    });
    response.stdout = redisOutput.replace('aof_last_write_status:ok', 'aof_last_write_status:err');
    expect(await verify()).toMatchObject({
      state: 'failed',
      code: 'DATABASE_PERSISTENCE_NOT_READY',
      redis: { lastWriteStatus: 'error' },
    });
  });
  it('discards a successful exec if the same Pod name acquired a different UID', async () => {
    const { verify, response, server } = await setup();
    response.onExec = () => server.rotatePodUids();
    expect(await verify()).toMatchObject({
      state: 'unknown',
      authenticated: null,
      pod: null,
      code: 'WORKLOAD_OWNERSHIP_MISMATCH',
    });
  });
  it('executes nothing when the current Pod does not belong to the published StatefulSet', async () => {
    const { verify, server, requests } = await setup();
    server.podMode = 'spoofed';
    expect(await verify()).toMatchObject({ state: 'unknown', authenticated: null });
    expect(requests).toHaveLength(0);
  });
  it('bounds output and catches malformed channel status without exposing raw data', async () => {
    const { verify, response } = await setup();
    response.stdout = 's'.repeat(40 * 1024);
    expect(await verify()).toMatchObject({ state: 'unknown', code: 'DATABASE_EXEC_TOO_LARGE' });
    response.stdout = pgOutput;
    response.malformedStatus = true;
    expect(await verify()).toMatchObject({ state: 'unknown', code: 'DATABASE_EXEC_UNAVAILABLE' });
  });
  it('rejects redirects and can cancel a live exec without leaking credentials', async () => {
    const { verify, response, requests } = await setup();
    response.redirect = true;
    expect(await verify()).toMatchObject({ state: 'unknown', code: 'DATABASE_EXEC_UNAVAILABLE' });
    expect(requests).toHaveLength(1);
    response.redirect = false;
    response.hold = true;
    const controller = new AbortController();
    const task = verify({ signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await task).toMatchObject({ state: 'unknown', authenticated: null });
  });
});
