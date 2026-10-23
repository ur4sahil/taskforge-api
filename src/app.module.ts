import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { appConfig, authConfig, redisConfig, storageConfig, aiConfig, pushConfig, emailConfig } from './config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { UsersModule } from './modules/users/users.module';
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
import { EmailModule } from './common/email/email.module';
import { InvitationsModule } from './modules/invitations/invitations.module';
import { JwtAuthGuard, UserAwareThrottlerGuard } from './common/guards';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { THROTTLERS } from './common/throttle.config';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, authConfig, redisConfig, storageConfig, aiConfig, pushConfig, emailConfig] }),
    // Exactly one throttler: every entry in this array is enforced on every
    // route, so a second 5/min "auth" entry here was rate-limiting all traffic.
    // Credential routes tighten the default bucket with @Throttle(AUTH_THROTTLE).
    // Limits, skip conditions and rationale live in common/throttle.config.ts.
    ThrottlerModule.forRoot(THROTTLERS),
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
    EmailModule,
    AuthModule, UsersModule, WorkspacesModule, InvitationsModule, ListsModule, TasksModule, CommentsModule,
    AttachmentsModule, RemindersModule, RecurrenceModule, TemplatesModule,
    NotificationsModule, SearchModule, ViewsModule, ReportsModule,
    AiModule, AuditModule, TrashModule, EmailIngestionModule, MessagesModule, PushModule, RealtimeModule, WorkersModule,
    ClientErrorsModule, HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: UserAwareThrottlerGuard },
    // Global audit logger. Reads req.__auditData if a controller sets it on
    // success; controllers that don't set it just write no audit row. Matches
    // the behavior promised in the api CLAUDE.md.
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
})
export class AppModule {}
