import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { clearInterval, setInterval } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import websocket from '@fastify/websocket';

const apiRequire = createRequire(new URL('../../apps/api/package.json', import.meta.url));
apiRequire('reflect-metadata');
const { Controller, Get, HttpCode, Module, Post, Req, Res, Sse, UnauthorizedException } =
  apiRequire('@nestjs/common');
const { NestFactory } = apiRequire('@nestjs/core');
const { FastifyAdapter } = apiRequire('@nestjs/platform-fastify');
const { Observable } = apiRequire('rxjs');

function installedVersion(name, resolver = apiRequire) {
  let directory = dirname(resolver.resolve(name));
  for (;;) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return metadata.version;
    } catch {
      // Walk from the actual entry point; package export maps may hide package.json.
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error('Cannot locate installed package version');
    directory = parent;
  }
}

function decorate(prototype, name, decorator) {
  decorator(prototype, name, Object.getOwnPropertyDescriptor(prototype, name));
}

/** Ephemeral loopback-only protocol fixture. It never imports the product AppModule. */
export async function createProtocolProbe() {
  const signingKey = randomBytes(32);
  const timers = new Set();
  const disposers = new Set();
  const state = {
    sse: { opened: 0, active: 0, closed: 0 },
    stream: { opened: 0, active: 0, closed: 0, upstreamAborts: 0 },
    websocket: { opened: 0, active: 0, closed: 0, abnormalCloses: 0 },
  };
  const sign = (body) => createHmac('sha256', signingKey).update(body).digest();
  const startTimer = (callback) => {
    const timer = setInterval(callback, 15);
    timers.add(timer);
    return timer;
  };
  const stopTimer = (timer) => {
    clearInterval(timer);
    timers.delete(timer);
  };

  class ProbeController {
    signed(request) {
      const signature = request.headers['x-probe-signature'];
      const raw = request.rawBody;
      if (
        !Buffer.isBuffer(raw) ||
        typeof signature !== 'string' ||
        !/^sha256=[a-f0-9]{64}$/.test(signature) ||
        !timingSafeEqual(Buffer.from(signature.slice(7), 'hex'), sign(raw))
      ) {
        throw new UnauthorizedException('Synthetic signature verification failed');
      }
      return { verified: true, rawBytes: raw.length, parsed: request.body };
    }

    events() {
      return new Observable((subscriber) => {
        state.sse.opened++;
        state.sse.active++;
        let sequence = 0;
        const stop = () => subscriber.complete();
        disposers.add(stop);
        const timer = startTimer(() => {
          subscriber.next({ id: String(++sequence), type: 'probe', data: { sequence } });
        });
        return () => {
          stopTimer(timer);
          disposers.delete(stop);
          state.sse.active--;
          state.sse.closed++;
        };
      });
    }

    stream(_request, reply) {
      const upstream = new globalThis.AbortController();
      state.stream.opened++;
      state.stream.active++;
      const abort = () => {
        if (!upstream.signal.aborted) {
          state.stream.upstreamAborts++;
          upstream.abort();
        }
      };
      reply.raw.once('close', abort);
      disposers.add(abort);
      const source = Readable.from(
        (async function* () {
          let sequence = 0;
          try {
            while (!upstream.signal.aborted) {
              await delay(15, undefined, { signal: upstream.signal });
              yield Buffer.from(
                JSON.stringify({ sequence: ++sequence, text: 'bounded chunk' }) + '\n',
              );
            }
          } catch (error) {
            if (error.name !== 'AbortError') throw error;
          } finally {
            reply.raw.off('close', abort);
            disposers.delete(abort);
            state.stream.active--;
            state.stream.closed++;
          }
        })(),
        { objectMode: false, highWaterMark: 1024 },
      );
      return reply.type('application/x-ndjson').send(source);
    }
  }
  Controller('__protocol_probe')(ProbeController);
  decorate(ProbeController.prototype, 'signed', Post('signed'));
  decorate(ProbeController.prototype, 'signed', HttpCode(200));
  Req()(ProbeController.prototype, 'signed', 0);
  decorate(ProbeController.prototype, 'events', Sse('events'));
  decorate(ProbeController.prototype, 'stream', Get('stream'));
  Req()(ProbeController.prototype, 'stream', 0);
  Res()(ProbeController.prototype, 'stream', 1);

  class ProtocolProbeModule {}
  Module({ controllers: [ProbeController] })(ProtocolProbeModule);
  const app = await NestFactory.create(
    ProtocolProbeModule,
    new FastifyAdapter({ bodyLimit: 16384, logger: false, forceCloseConnections: true }),
    { logger: false, rawBody: true, abortOnError: false },
  );
  await app.register(websocket, { options: { maxPayload: 4096 } });
  const server = app.getHttpAdapter().getInstance();
  server.get('/__protocol_probe/socket', { websocket: true }, (socket) => {
    state.websocket.opened++;
    state.websocket.active++;
    const terminate = () => socket.terminate();
    disposers.add(terminate);
    const timer = startTimer(() => {
      if (socket.readyState === 1) socket.ping();
    });
    socket.on('message', (data, binary) => socket.send(data, { binary }));
    socket.once('close', (code) => {
      stopTimer(timer);
      disposers.delete(terminate);
      state.websocket.active--;
      state.websocket.closed++;
      if (code === 1006) state.websocket.abnormalCloses++;
    });
    socket.on('error', () => socket.terminate());
  });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const metrics = () => ({
    sse: { ...state.sse },
    stream: { ...state.stream },
    websocket: { ...state.websocket },
    activeTimers: timers.size,
    activeDisposers: disposers.size,
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    versions: {
      node: process.version,
      nest: installedVersion('@nestjs/core'),
      fastify: server.version,
      websocket: installedVersion('@fastify/websocket', createRequire(import.meta.url)),
    },
    signSyntheticBody: (body) => `sha256=${sign(body).toString('hex')}`,
    metrics,
    async close() {
      for (const dispose of [...disposers]) dispose();
      await app.close();
      for (const timer of [...timers]) stopTimer(timer);
      signingKey.fill(0);
    },
  };
}
