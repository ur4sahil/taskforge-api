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
  await app.listen(port);
  Logger.log(`TaskForge API on http://localhost:${port}`, 'Bootstrap');
}
bootstrap();
