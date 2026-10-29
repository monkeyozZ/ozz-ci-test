import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, expect, it } from 'vitest';
import { registerApplicationBodyParser } from '../../apps/api/src/common/body-parser.js';

const Fastify = createRequire(new URL('../../apps/api/package.json', import.meta.url))(
  'fastify',
) as (options: { bodyLimit: number }) => Parameters<typeof registerApplicationBodyParser>[0];
const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
function app() {
  const server = Fastify({ bodyLimit: 102400 });
  servers.push(server);
  registerApplicationBodyParser(server);
  server.post('/api/webhooks/github/:repositoryId/:callbackId', async (request) => ({
    buffer: Buffer.isBuffer(request.body),
    sha256: createHash('sha256').update(request.rawWebhookBody!).digest('hex'),
  }));
  server.post('/api/management', async (request) => ({ body: request.body }));
  return server;
}
it('preserves original JSON bytes and defers even malformed JSON to the HMAC boundary', async () => {
  const server = app(),
    payload = Buffer.from('{  "message": "中 文" ,\nBROKEN');
  const response = await server.inject({
    method: 'POST',
    url: '/api/webhooks/github/repo/callback',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    buffer: true,
    sha256: createHash('sha256').update(payload).digest('hex'),
  });
  const management = await server.inject({
    method: 'POST',
    url: '/api/management',
    headers: { 'content-type': 'application/json' },
    payload,
  });
  expect(management.statusCode).toBe(400);
});
it('keeps the management limit while applying the separate bounded Webhook limit', async () => {
  const server = app(),
    medium = Buffer.alloc(110000, 'x');
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/github/repo/callback',
        headers: { 'content-type': 'application/json' },
        payload: medium,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/management',
        headers: { 'content-type': 'application/json' },
        payload: medium,
      })
    ).statusCode,
  ).toBe(413);
  expect(
    (
      await server.inject({
        method: 'POST',
        url: '/api/webhooks/github/repo/callback',
        headers: { 'content-type': 'application/json' },
        payload: Buffer.alloc(512 * 1024 + 1),
      })
    ).statusCode,
  ).toBe(413);
});
