import type { FastifyInstance } from 'fastify';
import { GITHUB_WEBHOOK_MAX_BYTES } from '@ozz/control-plane/git';
import '../modules/git/webhook.controller.js';

export function registerApplicationBodyParser(server: FastifyInstance): void {
  const jsonParser = server.getDefaultJsonParser('error', 'error');
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, raw, done) => {
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (request.routeOptions.url?.startsWith('/api/webhooks/github/')) {
      request.rawWebhookBody = body;
      done(null, body);
      return;
    }
    jsonParser(request, body.toString('utf8'), done);
  });
  server.addHook('onRoute', (route) => {
    if (route.url.startsWith('/api/webhooks/github/')) route.bodyLimit = GITHUB_WEBHOOK_MAX_BYTES;
  });
}
