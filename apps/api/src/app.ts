import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ValidationPipe, type ValidationError } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { loadConfig, createLogger } from '@ozz/config';
import { PrismaService } from '@ozz/database';
import { AppModule } from './app.module';
import { Problem } from './common/problem';
import { ProblemFilter } from './common/problem.filter';
import { preserveBodyLimitResponse } from './common/body-limit';
import { registerApplicationBodyParser } from './common/body-parser.js';
import type { GitHubClient } from '@ozz/infrastructure/github';

function validationFields(items: ValidationError[], parent = ''): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const item of items) {
    const key = parent ? `${parent}.${item.property}` : item.property;
    if (item.constraints) result[key] = Object.values(item.constraints);
    Object.assign(result, validationFields(item.children ?? [], key));
  }
  return result;
}

export async function createApp(
  options: { silent?: boolean; githubAdapter?: GitHubClient } = {},
): Promise<NestFastifyApplication> {
  const config = loadConfig();
  const logger = createLogger('api', { level: options.silent ? 'silent' : config.logLevel });
  const adapter = new FastifyAdapter({
    bodyLimit: 102400,
    requestTimeout: 15000,
    keepAliveTimeout: 10000,
    trustProxy: config.trustedProxyCidrs.length ? config.trustedProxyCidrs : false,
    genReqId: (request: IncomingMessage) => {
      const id = request.headers['x-request-id'];
      return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : randomUUID();
    },
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(options.githubAdapter),
    adapter,
    {
      logger: false,
      abortOnError: false,
      bodyParser: false,
    },
  );
  await app.register(cookie);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      validationError: { target: false, value: false },
      exceptionFactory: (errors) =>
        new Problem(422, 'VALIDATION_FAILED', '请检查标记的字段。', validationFields(errors)),
    }),
  );
  app.useGlobalFilters(new ProblemFilter(options.silent));
  const server = adapter.getInstance();
  registerApplicationBodyParser(server);
  preserveBodyLimitResponse(server);
  server.addHook('onRequest', async (request, reply) => {
    reply.header('X-Request-Id', request.id);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'same-origin');
  });
  server.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });
  app.enableShutdownHooks();
  try {
    await app.init();
    const db = app.get(PrismaService);
    if (config.restoreMode) {
      await db.controlPlaneState.updateMany({
        where: { id: 'control-plane', restoreLocked: false },
        data: { restoreLocked: true, generation: { increment: 1 } },
      });
    }
    await server.ready();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
