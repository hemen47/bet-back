// Must run first: fixes Atlas SRV lookups on resolvers that refuse them.
import './common/dns.js';
import { Logger, StandardSchemaValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestNodeApplication, NodeAdapter } from '@nestjs/platform-node';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';

async function bootstrap() {
  const trustProxy = ['true', '1'].includes(process.env.TRUST_PROXY ?? '');
  const app = await NestFactory.create<NestNodeApplication>(
    AppModule,
    new NodeAdapter(trustProxy ? { trustProxy: true } : {}),
  );
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  const origins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors({
    origin: origins.length > 0 ? origins : false,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');
  Logger.log(`API listening on :${port}`, 'Bootstrap');
}
await bootstrap();
