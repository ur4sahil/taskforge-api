import { Injectable, Module, Controller, Post, Body, Headers, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Public } from '../../common/decorators';
import { successResponse } from '../../common/dto/response.dto';

/**
 * Normalized inbound-email payload. The Cloudflare Email Worker (or any other
 * mail provider adapter) is responsible for converting raw email into this shape.
 *
 *   to       — list address (envelope recipient). String OR array; first valid wins.
 *   from     — sender email; matched to a WorkspaceMember to set the task creator.
 *   cc       — optional, used only for metadata for now.
 *   subject  — becomes the task title (truncated to 255).
 *   text     — plain-text body, becomes the task description.
 */
interface InboundEmailPayload {
  to?: string | string[];
  from?: string;
  cc?: string[];
  subject?: string;
  text?: string;
}

/** Pull `addr@domain.tld` out of `Display Name <addr@domain.tld>` or return as-is. */
function extractAddress(value: string): string {
  const angle = value.match(/<([^>]+)>/);
  return (angle?.[1] || value || '').trim().toLowerCase();
}

@Injectable()
export class EmailIngestionService {
  private readonly log = new Logger('EmailIngestion');
  constructor(private prisma: PrismaService) {}

  async process(payload: InboundEmailPayload) {
    // Resolve the list address — handle multi-recipient by trying each To: until one matches.
    const recipients = (Array.isArray(payload.to) ? payload.to : [payload.to || ''])
      .map(r => extractAddress(r || ''))
      .filter(Boolean);
    if (recipients.length === 0) throw new BadRequestException('Missing To: address');

    const list = await this.prisma.list.findFirst({
      where: { inboundEmail: { in: recipients }, inboundEmailEnabled: true, archivedAt: null },
    });
    if (!list) {
      this.log.warn(`No active list matches recipients: ${recipients.join(', ')}`);
      throw new BadRequestException('Unknown or disabled inbound address');
    }

    // Sender attribution: if the sender's email matches a workspace member, that's the creator.
    // Otherwise fall back to the list's creator so the task has a valid creatorId either way.
    const senderEmail = extractAddress(payload.from || '');
    let creatorId = list.createdById;
    let assigneeId: string | null = list.defaultAssigneeId;
    if (senderEmail) {
      const sender = await this.prisma.workspaceMember.findFirst({
        where: { workspaceId: list.workspaceId, isActive: true, user: { email: senderEmail } },
        select: { id: true },
      });
      if (sender) { creatorId = sender.id; if (!assigneeId) assigneeId = sender.id; }
    }

    const subject = (payload.subject || '').trim() || 'Untitled email task';
    const task = await this.prisma.task.create({
      data: {
        workspaceId: list.workspaceId,
        listId: list.id,
        title: subject.substring(0, 255),
        description: payload.text || '',
        status: 'todo' as any,
        priority: 'medium' as any,
        creatorId,
        assigneeId,
        source: 'email' as any,
      },
    });
    await this.prisma.taskEmailMetadata.create({
      data: {
        taskId: task.id,
        fromAddress: senderEmail || (payload.from || '').substring(0, 255),
        toAddress: recipients[0],
        ccAddresses: (payload.cc || []).map(c => extractAddress(c)).filter(Boolean),
        subject,
        receivedAt: new Date(),
      },
    });
    this.log.log(`Email task ${task.id} created in list ${list.id} from ${senderEmail || 'unknown sender'}`);
    return task;
  }
}

@Controller('webhooks')
export class EmailIngestionController {
  private readonly log = new Logger('EmailIngestionController');
  constructor(private svc: EmailIngestionService, private config: ConfigService) {}

  @Public()
  @Post('inbound-email')
  async handle(
    @Body() payload: InboundEmailPayload,
    @Headers('x-inbound-secret') headerSecret: string,
  ) {
    const expected = this.config.get<string>('app.inboundWebhookSecret') || '';
    if (!expected) {
      this.log.error('INBOUND_WEBHOOK_SECRET not configured — refusing inbound email');
      throw new UnauthorizedException('Inbound webhook not configured');
    }
    if (headerSecret !== expected) {
      this.log.warn('Inbound webhook called with bad or missing secret');
      throw new UnauthorizedException('Invalid inbound secret');
    }
    const t = await this.svc.process(payload);
    return successResponse({ taskId: t.id });
  }
}

@Module({ controllers: [EmailIngestionController], providers: [EmailIngestionService], exports: [EmailIngestionService] })
export class EmailIngestionModule {}
