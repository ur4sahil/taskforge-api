// Make BigInt values JSON-serializable. Prisma returns BigInt for autoincrement
// id columns (e.g. AuditLog.id); without this, `res.json(rows)` throws "Do not
// know how to serialize a BigInt" and the request 500s.
(BigInt.prototype as any).toJSON = function () { return this.toString(); };

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  // The only legitimate caller is the cloudflared tunnel on this same host, which
  // sits one hop in front of us. Trusting exactly that hop makes req.ip the real
  // client address (Cloudflare appends it to X-Forwarded-For; a spoofed header
  // from the client is left of it and ignored). Audit rows and the per-IP auth
  // throttle both depend on this.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  // Run PrismaService.onModuleDestroy / BullMQ worker draining on SIGINT/SIGTERM
  // (pm2 restart), instead of killing jobs mid-flight.
  app.enableShutdownHooks();
  app.use(helmet());
  app.enableCors({
    origin: process.env.APP_URL || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });
  app.useGlobalPipes(new ValidationPipe({
    // whitelist strips unknown props silently. forbidNonWhitelisted is OFF because
    // when a route has multiple @Query() DTOs (e.g. TaskFilterDto + PaginationDto),
    // each DTO sees the FULL query string and would 400 on the other's properties.
    whitelist: true, transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));
  app.useGlobalFilters(new HttpExceptionFilter());
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder().setTitle('TaskForge API').setVersion('1.0').addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }
  const port = parseInt(process.env.PORT || '3001', 10);
  // Loopback only. Public traffic reaches us through the cloudflared tunnel on
  // localhost; binding 0.0.0.0 exposed plain-HTTP :3001 to the internet,
  // bypassing Cloudflare TLS/WAF and the auth throttle. HOST exists for Docker
  // or a dev box that needs LAN access.
  const host = process.env.HOST || '127.0.0.1';
  await app.listen(port, host);
  Logger.log(`TaskForge API on http://${host}:${port}`, 'Bootstrap');
}
bootstrap();
