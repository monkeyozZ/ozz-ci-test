import { Readable } from 'node:stream';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ServiceLogReader, type ServiceLogSession } from '@ozz/control-plane/services';
import type { FastifyReply } from 'fastify';
import type { AuthenticatedRequest } from '../../auth/auth.types.js';
import { SecretCipherService } from '../../common/secret-cipher.service.js';
import type { ServiceLogsQueryDto } from './logs.dto.js';
import { ServicesService } from './services.service.js';

@Injectable()
export class ServiceLogsService implements OnModuleDestroy {
  private readonly reader: ServiceLogReader;

  constructor(
    private readonly services: ServicesService,
    cipher: SecretCipherService,
  ) {
    this.reader = new ServiceLogReader(services.repository, cipher);
  }

  async stream(
    id: string,
    query: ServiceLogsQueryDto,
    request: AuthenticatedRequest,
    reply: FastifyReply,
  ) {
    const abort = new AbortController();
    let session: ServiceLogSession | undefined;
    let stream: Readable | undefined;
    const disconnected = () => {
      abort.abort();
      session?.close();
      stream?.destroy();
    };
    // A consumer that stops reading cannot retain a connection/slot indefinitely.
    const deadline = setTimeout(() => reply.raw.destroy(), 65_000);
    deadline.unref();
    const cleanup = () => {
      clearTimeout(deadline);
      reply.raw.off('close', disconnected);
      reply.raw.off('close', cleanup);
      reply.raw.off('finish', cleanup);
      session?.close();
    };
    reply.raw.once('close', disconnected);
    reply.raw.once('close', cleanup);
    reply.raw.once('finish', cleanup);
    try {
      session = await this.services.request(() =>
        this.reader.open(
          id,
          query,
          {
            userId: request.user.id,
            sessionId: request.sessionId,
          },
          abort.signal,
        ),
      );
      const current = session;
      stream = Readable.from(
        (async function* () {
          try {
            yield ': connected\n\n';
            for await (const event of current.events)
              yield `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          } finally {
            // Producer completion can precede the downstream socket draining.
            // Keep its hard deadline until the HTTP response finishes/closes.
            current.close();
          }
        })(),
        { objectMode: false, highWaterMark: 16 * 1024 },
      );
      stream.once('close', () => current.close());
      if (abort.signal.aborted) {
        stream.destroy();
        cleanup();
        return reply;
      }
      return reply
        .type('text/event-stream; charset=utf-8')
        .header('Cache-Control', 'no-store, no-transform')
        .header('X-Accel-Buffering', 'no')
        .send(stream);
    } catch (error) {
      cleanup();
      reply.raw.off('close', cleanup);
      throw error;
    }
  }

  onModuleDestroy(): void {
    this.reader.close();
  }
}
