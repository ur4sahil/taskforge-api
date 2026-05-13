import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Module, Controller, Post, Get, Body, Param, Query, UseGuards, Inject, forwardRef, Optional } from '@nestjs/common';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

export class SendMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(4000) body: string = '';
}

const MEMBER_INCLUDE = {
  user: { select: { id: true, name: true, email: true, avatarUrl: true } },
};

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService) {}

  /** Get all conversations the current member participates in, newest activity first. */
  async listConversations(wid: string, mid: string) {
    const memberships = await this.prisma.conversationMember.findMany({
      where: { workspaceMemberId: mid, conversation: { workspaceId: wid } },
      include: {
        conversation: {
          include: {
            members: {
              include: { workspaceMember: { include: MEMBER_INCLUDE } },
            },
            messages: { take: 1, orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });
    // Sort by lastMessageAt (fallback to createdAt) — Prisma can't compose this through the relation cheaply.
    const rows = memberships
      .map(m => {
        const c = m.conversation;
        const other = c.members.find((cm: any) => cm.workspaceMemberId !== mid);
        const lastMsg = c.messages[0] || null;
        const unread = lastMsg && (!m.lastReadAt || new Date(lastMsg.createdAt) > m.lastReadAt) && lastMsg.senderId !== mid ? 1 : 0;
        return {
          id: c.id,
          workspaceId: c.workspaceId,
          lastMessageAt: c.lastMessageAt,
          createdAt: c.createdAt,
          other: other?.workspaceMember || null,
          lastMessage: lastMsg ? { id: lastMsg.id, body: lastMsg.body, kind: lastMsg.kind, senderId: lastMsg.senderId, createdAt: lastMsg.createdAt } : null,
          unread,
        };
      })
      .sort((a, b) => {
        const at = a.lastMessageAt?.getTime() ?? a.createdAt.getTime();
        const bt = b.lastMessageAt?.getTime() ?? b.createdAt.getTime();
        return bt - at;
      });
    return rows;
  }

  /** Find or create the 1:1 conversation between two members of the same workspace. */
  async getOrCreateWith(wid: string, mid: string, otherMid: string) {
    if (mid === otherMid) throw new BadRequestException('Cannot start a conversation with yourself');
    const other = await this.prisma.workspaceMember.findFirst({ where: { id: otherMid, workspaceId: wid, isActive: true } });
    if (!other) throw new NotFoundException('Target member not found');

    // Find an existing 1:1: a conversation in this workspace where both members are present AND it has exactly 2 members.
    const existing = await this.prisma.conversation.findFirst({
      where: {
        workspaceId: wid,
        AND: [
          { members: { some: { workspaceMemberId: mid } } },
          { members: { some: { workspaceMemberId: otherMid } } },
        ],
      },
      include: { members: true },
    });
    if (existing && existing.members.length === 2) return this.hydrateConversation(existing.id, mid);

    const created = await this.prisma.conversation.create({
      data: {
        workspaceId: wid,
        members: { create: [{ workspaceMemberId: mid }, { workspaceMemberId: otherMid }] },
      },
    });
    return this.hydrateConversation(created.id, mid);
  }

  private async hydrateConversation(cid: string, mid: string) {
    const c = await this.prisma.conversation.findUnique({
      where: { id: cid },
      include: {
        members: { include: { workspaceMember: { include: MEMBER_INCLUDE } } },
        messages: { take: 1, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    const other = c.members.find(m => m.workspaceMemberId !== mid);
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
      other: other?.workspaceMember || null,
      lastMessage: c.messages[0] || null,
      unread: 0,
    };
  }

  /** Throw 403 if the current member is not part of this conversation. */
  private async assertParticipant(cid: string, mid: string) {
    const m = await this.prisma.conversationMember.findUnique({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: mid } },
    });
    if (!m) throw new ForbiddenException('Not a participant in this conversation');
    return m;
  }

  async listMessages(wid: string, cid: string, mid: string, page: number, perPage: number) {
    await this.assertParticipant(cid, mid);
    const where = { conversationId: cid };
    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where,
        include: { sender: { include: MEMBER_INCLUDE } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.message.count({ where }),
    ]);
    // Newest first from the DB; reverse so callers receive oldest → newest for natural rendering.
    return { messages: messages.reverse(), meta: paginationMeta(total, page, perPage) };
  }

  async sendMessage(wid: string, cid: string, mid: string, dto: SendMessageDto, kind: string = 'text') {
    await this.assertParticipant(cid, mid);
    const body = dto.body.trim();
    if (!body && kind === 'text') throw new BadRequestException('Empty message');
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { conversationId: cid, senderId: mid, body, kind },
        include: { sender: { include: MEMBER_INCLUDE } },
      }),
      this.prisma.conversation.update({
        where: { id: cid },
        data: { lastMessageAt: new Date() },
      }),
      // Sender's own lastReadAt also bumps; keeps unread counts accurate for them.
      this.prisma.conversationMember.update({
        where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: mid } },
        data: { lastReadAt: new Date() },
      }),
    ]);
    return message;
  }

  async markRead(wid: string, cid: string, mid: string) {
    await this.assertParticipant(cid, mid);
    await this.prisma.conversationMember.update({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: mid } },
      data: { lastReadAt: new Date() },
    });
  }

  /** Count of conversations with at least one unread message for me. */
  async unreadCount(wid: string, mid: string) {
    const memberships = await this.prisma.conversationMember.findMany({
      where: { workspaceMemberId: mid, conversation: { workspaceId: wid } },
      select: { conversationId: true, lastReadAt: true },
    });
    if (memberships.length === 0) return 0;
    let count = 0;
    for (const m of memberships) {
      const hasUnread = await this.prisma.message.findFirst({
        where: {
          conversationId: m.conversationId,
          senderId: { not: mid },
          ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
        },
        select: { id: true },
      });
      if (hasUnread) count++;
    }
    return count;
  }
}

@Controller('workspaces/:wid/conversations')
@UseGuards(WorkspaceGuard)
export class MessagesController {
  constructor(private svc: MessagesService) {}

  @Get()
  async list(@Param('wid') w: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.listConversations(w, m.id));
  }

  @Get('unread-count')
  async unread(@Param('wid') w: string, @CurrentMember() m: any) {
    return successResponse({ count: await this.svc.unreadCount(w, m.id) });
  }

  @Post('with/:memberId')
  async getOrCreate(@Param('wid') w: string, @Param('memberId') om: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.getOrCreateWith(w, m.id, om));
  }

  @Get(':cid/messages')
  async messages(@Param('wid') w: string, @Param('cid') c: string, @CurrentMember() m: any, @Query() p: PaginationDto) {
    const r = await this.svc.listMessages(w, c, m.id, p.page, p.perPage);
    return successResponse(r.messages, r.meta);
  }

  @Post(':cid/messages')
  async send(@Param('wid') w: string, @Param('cid') c: string, @Body() dto: SendMessageDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.sendMessage(w, c, m.id, dto));
  }

  @Post(':cid/mark-read')
  async mark(@Param('wid') w: string, @Param('cid') c: string, @CurrentMember() m: any) {
    await this.svc.markRead(w, c, m.id);
    return successResponse({ ok: true });
  }
}

@Module({
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
