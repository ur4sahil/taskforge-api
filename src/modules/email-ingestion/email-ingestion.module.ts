import { Injectable, Module, Controller, Post, Body, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Public } from '@/common/decorators';
import { successResponse } from '@/common/dto/response.dto';
@Injectable() export class EmailIngestionService {
  private readonly logger = new Logger('EmailIngestion');
  constructor(private prisma: PrismaService) {}
  async process(payload: any) {
    const to = (payload.to||'').match(/<([^>]+)>/)?.[1] || payload.to;
    const list = await this.prisma.list.findFirst({ where: { inboundEmail: to, inboundEmailEnabled: true, archivedAt: null }, include: { workspace: true } });
    if (!list) throw new BadRequestException('Unknown address');
    const task = await this.prisma.task.create({ data: { workspaceId: list.workspaceId, listId: list.id, title: (payload.subject||'Untitled').substring(0,255), description: payload.text||'', status: 'todo', priority: 'medium', creatorId: list.createdById, assigneeId: list.defaultAssigneeId, source: 'email' } });
    await this.prisma.taskEmailMetadata.create({ data: { taskId: task.id, fromAddress: payload.from||'', toAddress: to, ccAddresses: [], subject: payload.subject||'', receivedAt: new Date() } });
    this.logger.log(`Email task ${task.id} created`); return task;
  }
}
@Controller('webhooks') export class EmailIngestionController { constructor(private svc: EmailIngestionService) {} @Public() @Post('inbound-email') async handle(@Body() p: any) { return successResponse({ taskId: (await this.svc.process(p)).id }); } }
@Module({ controllers: [EmailIngestionController], providers: [EmailIngestionService], exports: [EmailIngestionService] }) export class EmailIngestionModule {}
