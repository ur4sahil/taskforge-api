import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig, authConfig, redisConfig, storageConfig, aiConfig, pushConfig] }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60000, limit: 100 }]),
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
  ],
})
export class AppModule {}
