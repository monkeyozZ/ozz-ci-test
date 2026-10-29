import { once } from 'node:events';
import { createRequire } from 'node:module';
import { connect, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { preserveBodyLimitResponse } from '../../apps/api/src/common/body-limit.js';

const Fastify = createRequire(new URL('../../apps/api/package.json', import.meta.url))(
  'fastify',
) as (options: Record<string, number>) => Parameters<typeof preserveBodyLimitResponse>[0];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const server = Fastify({ bodyLimit: 102400, requestTimeout: 250, keepAliveTimeout: 10000 });
  preserveBodyLimitResponse(server);
  let accepted = 0;
  server.post('/body', async () => {
    accepted += 1;
    return { accepted: true };
  });
  server.get('/after', async () => ({ ready: true }));
  server.setErrorHandler((error, _request, reply) => {
    reply.status(error.statusCode ?? 500).send({ code: error.code });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => server.close());
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('Missing TCP fixture port');
  const socket = connect(address.port, '127.0.0.1');
  cleanups.push(() => {
    socket.destroy();
  });
  socket.on('error', () => {});
  await once(socket, 'connect');
  let received = '';
  socket.on('data', (chunk: Buffer) => {
    received += chunk.toString();
  });
  const until = async (matches: (value: string) => boolean) => {
    const deadline = Date.now() + 2000;
    while (!matches(received) && Date.now() < deadline) await delay(5);
    expect(matches(received), received).toBe(true);
    return received;
  };
  return { socket, until, accepted: () => accepted };
}

function headers(socket: Socket) {
  socket.write(
    'POST /body HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 110000\r\nConnection: keep-alive\r\n\r\n',
  );
}

it('delivers 413 before upload completion, drains it, and reuses the TCP connection', async () => {
  const probe = await fixture();
  headers(probe.socket);
  const response = await probe.until((text) => text.includes('FST_ERR_CTP_BODY_TOO_LARGE'));
  expect(response).toContain('413 Payload Too Large');
  expect(response.toLowerCase()).not.toContain('connection: close');
  expect(probe.accepted()).toBe(0);
  probe.socket.write('x'.repeat(110000));
  await delay(350);
  probe.socket.write('GET /after HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await probe.until((text) => text.includes('200 OK') && text.includes('"ready":true'));
  expect(probe.accepted()).toBe(0);
});

it('closes an incomplete rejected upload at the request deadline', async () => {
  const probe = await fixture();
  const closed = new Promise<void>((resolve) => probe.socket.once('close', () => resolve()));
  headers(probe.socket);
  await probe.until((text) => text.includes('FST_ERR_CTP_BODY_TOO_LARGE'));
  const started = Date.now();
  await closed;
  expect(Date.now() - started).toBeLessThan(1500);
  expect(probe.socket.destroyed).toBe(true);
  expect(probe.accepted()).toBe(0);
});
