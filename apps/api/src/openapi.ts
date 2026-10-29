import 'reflect-metadata';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function main() {
  // Swagger reads controller metadata. Initializing the application would run
  // database/key-verification hooks and require the new migration before codegen.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(),
    new FastifyAdapter(),
    {
      logger: false,
      abortOnError: false,
    },
  );
  app.setGlobalPrefix('api');
  try {
    const config = new DocumentBuilder()
      .setTitle('Ozz Control Plane')
      .setVersion('0.1.0')
      .addCookieAuth('ozz_session')
      .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    await writeFile(resolve('docs/openapi.json'), `${JSON.stringify(document, null, 2)}\n`);
  } finally {
    await app.close();
  }
}
void main();
