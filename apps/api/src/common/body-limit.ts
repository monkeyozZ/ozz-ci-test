import type { FastifyInstance } from 'fastify';

export function preserveBodyLimitResponse(server: FastifyInstance): void {
  const drainTimeout = server.server.requestTimeout || 15_000;
  server.addHook('onError', async (request, reply, error) => {
    if (error.code !== 'FST_ERR_CTP_BODY_TOO_LARGE') return;

    // Fastify otherwise closes while the proxy is still uploading and can turn
    // the intended 413 into an upstream TCP reset/502. Discard without buffering
    // so the response can arrive and the next keepalive request stays aligned.
    reply.removeHeader('connection');
    const raw = request.raw;
    if (raw.readableEnded || raw.destroyed) return;
    const deadline = setTimeout(() => raw.destroy(), drainTimeout);
    deadline.unref();
    const cleanup = () => {
      clearTimeout(deadline);
      raw.off('end', cleanup);
      raw.off('close', cleanup);
    };
    raw.once('end', cleanup);
    raw.once('close', cleanup);
    raw.resume();
  });
}
