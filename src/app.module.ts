import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { appConfig, authConfig, redisConfig, storageConfig, aiConfig, pushConfig } from './config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { ListsModule } from './modules/lists/lists.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { CommentsModule } from './modules/comments/comments.module';
import { AttachmentsModule } from './modules/attachments/attachments.module';
import { RemindersModule } from './modules/reminders/reminders.module';
import { RecurrenceModule } from './modules/recurrence/recurrence.module';
import { TemplatesModule } from './modules/templates/templates.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SearchModule } from './modules/search/search.module';
import { ViewsModule } from './modules/views/views.module';
import { ReportsModule } from './modules/reports/reports.module';
import { AiModule } from './modules/ai/ai.module';
import { AuditModule } from './modules/audit/audit.module';
import { TrashModule } from './modules/trash/trash.module';
import { EmailIngestionModule } from './modules/email-ingestion/email-ingestion.module';
import { MessagesModule } from './modules/messages/messages.module';
import { PushModule } from './modules/push/push.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { WorkersModule } from './workers/workers.module';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module';
import { JwtAuthGuard } from './common/guards';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';

function shouldSkipThrottle(ctx: any): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  const secret = process.env.THROTTLE_BYPASS_SECRET;
  if (!secret) return false;
  // ThrottlerGuard passes its ExecutionContext; for the HTTP path, switchToHttp()
  // exposes the request whose headers carry the bypass token.
  try {
    const req = ctx?.switchToHttp?.()?.getRequest?.();
    const header = req?.headers?.['x-bypass-throttle'];
    return typeof header === 'string' && header === secret;
  } catch {
    return false;
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, authConfig, redisConfig, storageConfig, aiConfig, pushConfig] }),
    // Two throttler buckets: the global `default` (100/min) and a tight `auth`
    // bucket (5/min) for login + signup, applied per-route via @Throttle below.
    //
    // Skip conditions:
    //   1. NODE_ENV=test — keeps the in-memory tracker from carrying state
    //      across the API's own jest suite (auth.spec.ts hits /signup 9x).
    //   2. `x-bypass-throttle` request header matching env.THROTTLE_BYPASS_SECRET
    //      — lets the E2E suite (which legitimately creates many ephemeral users
    //      against live prod) skip throttling without weakening real-world
    //      brute-force protection. The secret is set on the VPS .env and
    //      mirrored in Playwright's env at run time.
    ThrottlerModule.forRoot([
      { name: 'default', ttl: 60_000, limit: 100, skipIf: shouldSkipThrottle },
      { name: 'auth', ttl: 60_000, limit: 5, skipIf: shouldSkipThrottle },
    ]),
    BullModule.forRootAsync({
      useFactory: () => {
        const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
        return {
          connection: {
            host: url.hostname,
            port: parseInt(url.port || '6379', 10),
            password: url.password || undefined,
            tls: url.protocol === 'rediss:' ? {} : undefined,
          },
        };
      },
    }),
    PrismaModule,
    AuthModule, WorkspacesModule, ListsModule, TasksModule, CommentsModule,
    AttachmentsModule, RemindersModule, RecurrenceModule, TemplatesModule,
    NotificationsModule, SearchModule, ViewsModule, ReportsModule,
    AiModule, AuditModule, TrashModule, EmailIngestionModule, MessagesModule, PushModule, RealtimeModule, WorkersModule,
    ClientErrorsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global audit logger. Reads req.__auditData if a controller sets it on
    // success; controllers that don't set it just write no audit row. Matches
    // the behavior promised in the api CLAUDE.md.
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
