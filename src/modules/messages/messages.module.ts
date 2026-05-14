import { Injectable, NotFoundException, ForbiddenException, BadRequestException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsString, IsNotEmpty, MaxLength, IsOptional, IsArray, IsUUID, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { R2StorageService } from '../../common/utils/r2-storage';
import { extractFirstUrl, fetchLinkPreview } from '../../common/utils/unfurl';
import { PushModule, PushService } from '../push/push.module';

// ───── DTOs ──────────────────────────────────────────────────────────────────

export class SendMessageDto {
  @IsOptional() @IsString() @MaxLength(8000) body?: string;
  @IsOptional() @IsArray() @IsUUID(undefined, { each: true }) attachmentIds?: string[];
  @IsOptional() @IsUUID() replyToId?: string;
}
export class EditMessageDto {
  @IsString() @IsNotEmpty() @MaxLength(8000) body: string = '';
}
export class CreateGroupDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string = '';
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(50) @IsUUID(undefined, { each: true }) memberIds: string[] = [];
}
export class RenameConversationDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string = '';
}
export class AddMemberDto {
  @IsUUID() workspaceMemberId: string = '';
}
export class ReactionDto {
  @IsString() @MaxLength(16) emoji: string = '';
}
export class ForwardDto {
  @IsUUID() toConversationId: string = '';
  @IsOptional() @IsString() @MaxLength(500) comment?: string;
}
export class MuteDto {
  // ISO timestamp; pass an empty/missing value to unmute.
  @IsOptional() @IsString() mutedUntil?: string | null;
}
export class SearchMessagesDto {
  @IsString() @IsNotEmpty() @MaxLength(200) q: string = '';
}

// ───── Shared includes ───────────────────────────────────────────────────────

const MEMBER_INCLUDE = {
  user: { select: { id: true, name: true, email: true, avatarUrl: true } },
};

const MESSAGE_INCLUDE = {
  sender: { include: MEMBER_INCLUDE },
  attachments: { select: { id: true, fileName: true, fileSize: true, mimeType: true, storageKey: true } },
  reactions: {
    select: {
      emoji: true,
      workspaceMemberId: true,
      workspaceMember: { include: { user: { select: { id: true, name: true } } } },
    },
  },
  replyTo: {
    select: {
      id: true, body: true, senderId: true, kind: true, deletedAt: true,
      sender: { include: MEMBER_INCLUDE },
    },
  },
  forwardedFrom: {
    select: {
      id: true, body: true, senderId: true, conversationId: true,
      sender: { include: MEMBER_INCLUDE },
    },
  },
};

// ───── Service ───────────────────────────────────────────────────────────────

@Injectable()
export class MessagesService {
  constructor(private prisma: PrismaService, private storage: R2StorageService, private push: PushService) {}

  async listConversations(wid: string, mid: string) {
    const memberships = await this.prisma.conversationMember.findMany({
      where: { workspaceMemberId: mid, conversation: { workspaceId: wid } },
      include: {
        conversation: {
          include: {
            members: { include: { workspaceMember: { include: MEMBER_INCLUDE } } },
            messages: { take: 1, orderBy: { createdAt: 'desc' }, where: { deletedAt: null } },
          },
        },
      },
    });
    const rows = memberships
      .map(m => {
        const c = m.conversation;
        const isGroup = !!c.name;
        const others = c.members
          .filter((cm: any) => cm.workspaceMemberId !== mid)
          .map((cm: any) => cm.workspaceMember);
        const lastMsg = c.messages[0] || null;
        const unread = lastMsg && (!m.lastReadAt || new Date(lastMsg.createdAt) > m.lastReadAt) && lastMsg.senderId !== mid ? 1 : 0;
        return {
          id: c.id,
          workspaceId: c.workspaceId,
          name: c.name,
          isGroup,
          memberCount: c.members.length,
          lastMessageAt: c.lastMessageAt,
          createdAt: c.createdAt,
          mutedUntil: m.mutedUntil,
          // For 1:1 the UI shows the "other" person; for groups it shows c.name and a stack of avatars.
          other: isGroup ? null : (others[0] || null),
          members: c.members.map((cm: any) => cm.workspaceMember),
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

  async getOrCreateWith(wid: string, mid: string, otherMid: string) {
    if (mid === otherMid) throw new BadRequestException('Cannot start a conversation with yourself');
    const other = await this.prisma.workspaceMember.findFirst({ where: { id: otherMid, workspaceId: wid, isActive: true } });
    if (!other) throw new NotFoundException('Target member not found');

    // 1:1 = a conversation with name=null AND exactly two members including both ids.
    const existing = await this.prisma.conversation.findFirst({
      where: {
        workspaceId: wid,
        name: null,
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

  /** Create a group conversation. Caller is auto-added. */
  async createGroup(wid: string, mid: string, dto: CreateGroupDto) {
    // De-dupe + ensure caller is included.
    const ids = Array.from(new Set([mid, ...dto.memberIds]));
    if (ids.length < 3) throw new BadRequestException('Groups need at least 3 members');
    const valid = await this.prisma.workspaceMember.findMany({
      where: { id: { in: ids }, workspaceId: wid, isActive: true }, select: { id: true },
    });
    if (valid.length !== ids.length) throw new BadRequestException('One or more members are invalid');

    const created = await this.prisma.conversation.create({
      data: {
        workspaceId: wid,
        name: dto.name.trim(),
        members: { create: ids.map(id => ({ workspaceMemberId: id })) },
      },
    });
    return this.hydrateConversation(created.id, mid);
  }

  async renameConversation(wid: string, cid: string, mid: string, name: string) {
    await this.assertParticipant(cid, mid);
    const conv = await this.prisma.conversation.findUnique({ where: { id: cid } });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (!conv.name) throw new BadRequestException('1:1 conversations cannot be renamed');
    return this.prisma.conversation.update({ where: { id: cid }, data: { name: name.trim() } });
  }

  async addMember(wid: string, cid: string, mid: string, newMemberId: string) {
    await this.assertParticipant(cid, mid);
    const conv = await this.prisma.conversation.findUnique({ where: { id: cid } });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (!conv.name) throw new BadRequestException('Cannot add members to a 1:1 conversation — create a group instead');
    const m = await this.prisma.workspaceMember.findFirst({ where: { id: newMemberId, workspaceId: wid, isActive: true } });
    if (!m) throw new NotFoundException('Member not found');
    await this.prisma.conversationMember.upsert({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: newMemberId } },
      create: { conversationId: cid, workspaceMemberId: newMemberId },
      update: {},
    });
    return { ok: true };
  }

  async removeMember(wid: string, cid: string, mid: string, removeMid: string) {
    await this.assertParticipant(cid, mid);
    const conv = await this.prisma.conversation.findUnique({ where: { id: cid }, include: { _count: { select: { members: true } } } });
    if (!conv) throw new NotFoundException('Conversation not found');
    if (!conv.name) throw new BadRequestException('Cannot leave or kick from a 1:1');
    if (conv._count.members <= 2 && removeMid !== mid) throw new BadRequestException('Group must have at least 2 members');
    await this.prisma.conversationMember.deleteMany({ where: { conversationId: cid, workspaceMemberId: removeMid } });
    return { ok: true };
  }

  private async hydrateConversation(cid: string, mid: string) {
    const c = await this.prisma.conversation.findUnique({
      where: { id: cid },
      include: {
        members: { include: { workspaceMember: { include: MEMBER_INCLUDE } } },
        messages: { take: 1, orderBy: { createdAt: 'desc' }, where: { deletedAt: null } },
      },
    });
    if (!c) throw new NotFoundException('Conversation not found');
    const isGroup = !!c.name;
    const others = c.members.filter(m => m.workspaceMemberId !== mid).map(m => m.workspaceMember);
    return {
      id: c.id,
      workspaceId: c.workspaceId,
      name: c.name,
      isGroup,
      memberCount: c.members.length,
      lastMessageAt: c.lastMessageAt,
      createdAt: c.createdAt,
      other: isGroup ? null : (others[0] || null),
      members: c.members.map(m => m.workspaceMember),
      lastMessage: c.messages[0] || null,
      unread: 0,
    };
  }

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
        include: MESSAGE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
      this.prisma.message.count({ where }),
    ]);
    return { messages: messages.reverse(), meta: paginationMeta(total, page, perPage) };
  }

  async sendMessage(wid: string, cid: string, mid: string, dto: SendMessageDto, kind: string = 'text') {
    await this.assertParticipant(cid, mid);
    const body = (dto.body || '').trim();
    const hasAttachments = (dto.attachmentIds?.length || 0) > 0;
    if (!body && !hasAttachments && kind === 'text') throw new BadRequestException('Empty message');

    // Validate reply target lives in the same conversation.
    if (dto.replyToId) {
      const replyTo = await this.prisma.message.findUnique({ where: { id: dto.replyToId } });
      if (!replyTo || replyTo.conversationId !== cid) throw new BadRequestException('replyToId is not in this conversation');
    }

    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: { conversationId: cid, senderId: mid, body, kind, replyToId: dto.replyToId || null },
        include: MESSAGE_INCLUDE,
      }),
      this.prisma.conversation.update({ where: { id: cid }, data: { lastMessageAt: new Date() } }),
      this.prisma.conversationMember.update({
        where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: mid } },
        data: { lastReadAt: new Date() },
      }),
    ]);

    // Link uploaded attachments to this message.
    if (hasAttachments) {
      await this.prisma.attachment.updateMany({
        where: { id: { in: dto.attachmentIds! }, workspaceId: wid, uploadedById: mid, messageId: null },
        data: { messageId: message.id },
      });
    }

    // Parse @email mentions and create Notification rows for any recipient who is also a
    // participant in this conversation. Fire-and-forget — failure here shouldn't block sending.
    this.notifyMentions(wid, cid, message.id, mid, body).catch(err => {
      // eslint-disable-next-line no-console
      console.error('mention notify failed', err);
    });

    // Fetch + attach a link preview for the first URL in the body. Best-effort, never blocks.
    this.attachLinkPreview(message.id, body).catch(err => {
      // eslint-disable-next-line no-console
      console.error('unfurl failed', err);
    });

    // Push to all other participants (those not actively viewing the conv aren't filtered here
    // — that's a client-side concern; we just deliver to every device the recipient has).
    this.pushNewMessage(wid, cid, message.id, mid, body || '(attachment)').catch(err => {
      // eslint-disable-next-line no-console
      console.error('push send failed', err);
    });

    if (hasAttachments) {
      return this.prisma.message.findUnique({ where: { id: message.id }, include: MESSAGE_INCLUDE });
    }
    return message;
  }

  /** Pulls @email tokens out of the body, resolves them to conversation participants, and
   *  inserts mention-type Notification rows. Mirrors the comments module's pattern. */
  private async notifyMentions(wid: string, cid: string, messageId: string, senderMid: string, body: string) {
    if (!body) return;
    const emailRe = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = Array.from(new Set(Array.from(body.matchAll(emailRe), (m: any) => m[1].toLowerCase())));
    if (emails.length === 0) return;
    const participants = await this.prisma.conversationMember.findMany({
      where: { conversationId: cid, workspaceMember: { user: { email: { in: emails } } } },
      include: { workspaceMember: { include: { user: { select: { email: true, name: true } } } } },
    });
    const targets = participants.filter((p: any) => p.workspaceMemberId !== senderMid);
    if (targets.length === 0) return;
    const sender = await this.prisma.workspaceMember.findUnique({ where: { id: senderMid }, include: { user: { select: { name: true } } } });
    const senderName = sender?.user?.name || 'Someone';
    await this.prisma.notification.createMany({
      data: targets.map((t: any) => ({
        workspaceId: wid,
        recipientId: t.workspaceMemberId,
        type: 'chat_mention',
        title: `${senderName} mentioned you`,
        body: body.length > 140 ? body.slice(0, 137) + '…' : body,
        data: { conversationId: cid, messageId },
      })),
    });
  }

  private async attachLinkPreview(messageId: string, body: string) {
    if (!body) return;
    const url = extractFirstUrl(body);
    if (!url) return;
    const preview = await fetchLinkPreview(url);
    if (!preview) return;
    await this.prisma.message.update({ where: { id: messageId }, data: { linkPreview: preview as any } });
  }

  /** Send a web push notification to every conversation participant except the sender. */
  private async pushNewMessage(wid: string, cid: string, messageId: string, senderId: string, snippet: string) {
    const recipients = await this.prisma.conversationMember.findMany({
      where: { conversationId: cid, workspaceMemberId: { not: senderId } },
      select: { workspaceMemberId: true, mutedUntil: true },
    });
    const now = new Date();
    const ids = recipients
      .filter(r => !r.mutedUntil || r.mutedUntil < now)
      .map(r => r.workspaceMemberId);
    if (ids.length === 0) return;
    const sender = await this.prisma.workspaceMember.findUnique({ where: { id: senderId }, include: { user: { select: { name: true } } } });
    const conv = await this.prisma.conversation.findUnique({ where: { id: cid }, select: { name: true } });
    const title = conv?.name ? conv.name : (sender?.user?.name || 'New message');
    await this.push.sendToMany(ids, {
      title,
      body: snippet.length > 140 ? snippet.slice(0, 137) + '…' : snippet,
      tag: `conv-${cid}`,
      url: `/messages?conv=${cid}`,
      data: { conversationId: cid, messageId },
    });
  }

  async editMessage(wid: string, cid: string, mid: string, msgId: string, body: string) {
    await this.assertParticipant(cid, mid);
    const msg = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!msg || msg.conversationId !== cid) throw new NotFoundException('Message not found');
    if (msg.senderId !== mid) throw new ForbiddenException('Only the sender can edit');
    if (msg.deletedAt) throw new BadRequestException('Cannot edit a deleted message');
    return this.prisma.message.update({
      where: { id: msgId },
      data: { body: body.trim(), editedAt: new Date() },
      include: MESSAGE_INCLUDE,
    });
  }

  async deleteMessage(wid: string, cid: string, mid: string, msgId: string) {
    await this.assertParticipant(cid, mid);
    const msg = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!msg || msg.conversationId !== cid) throw new NotFoundException('Message not found');
    if (msg.senderId !== mid) throw new ForbiddenException('Only the sender can delete');
    return this.prisma.message.update({
      where: { id: msgId },
      data: { deletedAt: new Date(), body: '' },
      include: MESSAGE_INCLUDE,
    });
  }

  async addReaction(wid: string, cid: string, mid: string, msgId: string, emoji: string) {
    await this.assertParticipant(cid, mid);
    const msg = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!msg || msg.conversationId !== cid) throw new NotFoundException('Message not found');
    await this.prisma.messageReaction.upsert({
      where: { messageId_workspaceMemberId_emoji: { messageId: msgId, workspaceMemberId: mid, emoji } },
      create: { messageId: msgId, workspaceMemberId: mid, emoji },
      update: {},
    });
    return this.prisma.message.findUnique({ where: { id: msgId }, include: MESSAGE_INCLUDE });
  }

  async removeReaction(wid: string, cid: string, mid: string, msgId: string, emoji: string) {
    await this.assertParticipant(cid, mid);
    await this.prisma.messageReaction.deleteMany({ where: { messageId: msgId, workspaceMemberId: mid, emoji } });
    return this.prisma.message.findUnique({ where: { id: msgId }, include: MESSAGE_INCLUDE });
  }

  // ───── Forward / Pin / Mute / Search ───────────────────────────────────────

  /** Forward a message to another conversation. Caller must be a participant of BOTH. */
  async forwardMessage(wid: string, fromCid: string, msgId: string, toCid: string, mid: string, comment?: string) {
    await this.assertParticipant(fromCid, mid);
    await this.assertParticipant(toCid, mid);
    const src = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!src || src.conversationId !== fromCid) throw new NotFoundException('Source message not found');
    if (src.deletedAt) throw new BadRequestException('Cannot forward a deleted message');
    // The forward gets the comment as its body (optional) and points back at src via forwardedFromId.
    // We do NOT copy attachments — they stay on the source. UI shows "Forwarded from X" hint.
    const [created] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId: toCid,
          senderId: mid,
          body: (comment || '').trim(),
          kind: 'text',
          forwardedFromId: msgId,
        },
        include: MESSAGE_INCLUDE,
      }),
      this.prisma.conversation.update({ where: { id: toCid }, data: { lastMessageAt: new Date() } }),
    ]);
    return created;
  }

  async togglePin(wid: string, cid: string, mid: string, msgId: string) {
    await this.assertParticipant(cid, mid);
    const msg = await this.prisma.message.findUnique({ where: { id: msgId } });
    if (!msg || msg.conversationId !== cid) throw new NotFoundException('Message not found');
    return this.prisma.message.update({
      where: { id: msgId },
      data: { isPinned: !msg.isPinned },
      include: MESSAGE_INCLUDE,
    });
  }

  async listPinnedMessages(wid: string, cid: string, mid: string) {
    await this.assertParticipant(cid, mid);
    return this.prisma.message.findMany({
      where: { conversationId: cid, isPinned: true, deletedAt: null },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async setMuted(wid: string, cid: string, mid: string, mutedUntil: string | null | undefined) {
    await this.assertParticipant(cid, mid);
    const at = mutedUntil ? new Date(mutedUntil) : null;
    await this.prisma.conversationMember.update({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: mid } },
      data: { mutedUntil: at },
    });
    return { mutedUntil: at };
  }

  /** Case-insensitive search within a single conversation; pages of 30. */
  async searchInConversation(wid: string, cid: string, mid: string, q: string, page = 1, perPage = 30) {
    await this.assertParticipant(cid, mid);
    const where = { conversationId: cid, deletedAt: null, body: { contains: q, mode: 'insensitive' as const } };
    const [messages, total] = await Promise.all([
      this.prisma.message.findMany({
        where, include: MESSAGE_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * perPage, take: perPage,
      }),
      this.prisma.message.count({ where }),
    ]);
    return { messages, meta: paginationMeta(total, page, perPage) };
  }

  // ───── Attachments ─────────────────────────────────────────────────────────

  async uploadAttachment(wid: string, cid: string, mid: string, file: any) {
    await this.assertParticipant(cid, mid);
    if (!file?.buffer) throw new BadRequestException('No file');
    if (file.size > 50 * 1024 * 1024) throw new BadRequestException('File too large (max 50 MB)');
    const ext = '.' + (file.originalname || '').split('.').pop()?.toLowerCase();
    const BLOCKED = ['.exe', '.bat', '.sh', '.ps1', '.cmd', '.vbs', '.jar', '.msi', '.scr', '.dll'];
    if (BLOCKED.includes(ext)) throw new BadRequestException('Blocked file type');
    const storageKey = `chat/${wid}/${cid}/${uuidv4()}-${file.originalname}`;
    await this.storage.upload(storageKey, file.buffer, file.mimetype);
    return this.prisma.attachment.create({
      data: {
        workspaceId: wid,
        taskId: null,
        messageId: null,
        commentId: null,
        uploadedById: mid,
        fileName: file.originalname,
        fileSize: file.size,
        mimeType: file.mimetype,
        storageKey,
      },
    });
  }

  async getAttachmentUrl(wid: string, aid: string, mid: string) {
    const a = await this.prisma.attachment.findFirst({
      where: { id: aid, workspaceId: wid, message: { conversation: { members: { some: { workspaceMemberId: mid } } } } },
    });
    if (!a) throw new NotFoundException('Attachment not found');
    const url = await this.storage.getDownloadUrl(a.storageKey, a.fileName);
    return { url, fileName: a.fileName, mimeType: a.mimeType };
  }

  async markRead(wid: string, cid: string, mid: string) {
    await this.assertParticipant(cid, mid);
    await this.prisma.conversationMember.update({
      where: { conversationId_workspaceMemberId: { conversationId: cid, workspaceMemberId: mid } },
      data: { lastReadAt: new Date() },
    });
  }

  async unreadCount(wid: string, mid: string) {
    const memberships = await this.prisma.conversationMember.findMany({
      where: { workspaceMemberId: mid, conversation: { workspaceId: wid } },
      select: { conversationId: true, lastReadAt: true, mutedUntil: true },
    });
    if (memberships.length === 0) return 0;
    const now = new Date();
    let count = 0;
    for (const m of memberships) {
      // Skip muted conversations entirely.
      if (m.mutedUntil && m.mutedUntil > now) continue;
      const hasUnread = await this.prisma.message.findFirst({
        where: {
          conversationId: m.conversationId,
          senderId: { not: mid },
          deletedAt: null,
          ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
        },
        select: { id: true },
      });
      if (hasUnread) count++;
    }
    return count;
  }
}

// ───── Controller ────────────────────────────────────────────────────────────

@Controller('workspaces/:wid/conversations')
@UseGuards(WorkspaceGuard)
export class MessagesController {
  constructor(private svc: MessagesService) {}

  @Get() async list(@Param('wid') w: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.listConversations(w, m.id));
  }

  @Get('unread-count') async unread(@Param('wid') w: string, @CurrentMember() m: any) {
    return successResponse({ count: await this.svc.unreadCount(w, m.id) });
  }

  @Post('with/:memberId') async getOrCreate(@Param('wid') w: string, @Param('memberId') om: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.getOrCreateWith(w, m.id, om));
  }

  @Post('group') async createGroup(@Param('wid') w: string, @Body() dto: CreateGroupDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.createGroup(w, m.id, dto));
  }

  @Patch(':cid') async rename(@Param('wid') w: string, @Param('cid') c: string, @Body() dto: RenameConversationDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.renameConversation(w, c, m.id, dto.name));
  }

  @Post(':cid/members') async addMember(@Param('wid') w: string, @Param('cid') c: string, @Body() dto: AddMemberDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.addMember(w, c, m.id, dto.workspaceMemberId));
  }

  @Delete(':cid/members/:mid') async removeMember(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') rm: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.removeMember(w, c, m.id, rm));
  }

  @Get(':cid/messages') async messages(@Param('wid') w: string, @Param('cid') c: string, @CurrentMember() m: any, @Query() p: PaginationDto) {
    const r = await this.svc.listMessages(w, c, m.id, p.page, p.perPage);
    return successResponse(r.messages, r.meta);
  }

  @Post(':cid/messages') async send(@Param('wid') w: string, @Param('cid') c: string, @Body() dto: SendMessageDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.sendMessage(w, c, m.id, dto));
  }

  @Patch(':cid/messages/:mid') async edit(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') id: string, @Body() dto: EditMessageDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.editMessage(w, c, m.id, id, dto.body));
  }

  @Delete(':cid/messages/:mid') async del(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') id: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.deleteMessage(w, c, m.id, id));
  }

  @Post(':cid/messages/:mid/reactions') async react(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') id: string, @Body() dto: ReactionDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.addReaction(w, c, m.id, id, dto.emoji));
  }

  @Delete(':cid/messages/:mid/reactions/:emoji') async unreact(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') id: string, @Param('emoji') emoji: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.removeReaction(w, c, m.id, id, decodeURIComponent(emoji)));
  }

  @Post(':cid/messages/:mid/forward')
  async forward(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') id: string, @Body() dto: ForwardDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.forwardMessage(w, c, id, dto.toConversationId, m.id, dto.comment));
  }

  @Post(':cid/messages/:mid/pin')
  async pin(@Param('wid') w: string, @Param('cid') c: string, @Param('mid') id: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.togglePin(w, c, m.id, id));
  }

  @Get(':cid/pinned')
  async pinned(@Param('wid') w: string, @Param('cid') c: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.listPinnedMessages(w, c, m.id));
  }

  @Post(':cid/mute')
  async mute(@Param('wid') w: string, @Param('cid') c: string, @Body() dto: MuteDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.setMuted(w, c, m.id, dto.mutedUntil));
  }

  @Get(':cid/search')
  async search(@Param('wid') w: string, @Param('cid') c: string, @Query('q') q: string, @Query() p: PaginationDto, @CurrentMember() m: any) {
    if (!q || !q.trim()) return successResponse([], paginationMeta(0, p.page, p.perPage));
    const r = await this.svc.searchInConversation(w, c, m.id, q.trim(), p.page, p.perPage);
    return successResponse(r.messages, r.meta);
  }

  @Post(':cid/attachments') @UseInterceptors(FileInterceptor('file'))
  async upload(@Param('wid') w: string, @Param('cid') c: string, @UploadedFile() f: any, @CurrentMember() m: any) {
    return successResponse(await this.svc.uploadAttachment(w, c, m.id, f));
  }

  @Get(':cid/attachments/:aid/url') async attachmentUrl(@Param('wid') w: string, @Param('aid') a: string, @CurrentMember() m: any) {
    return successResponse(await this.svc.getAttachmentUrl(w, a, m.id));
  }

  @Post(':cid/mark-read') async mark(@Param('wid') w: string, @Param('cid') c: string, @CurrentMember() m: any) {
    await this.svc.markRead(w, c, m.id);
    return successResponse({ ok: true });
  }
}

@Module({
  imports: [PushModule],
  controllers: [MessagesController],
  providers: [MessagesService, R2StorageService],
  exports: [MessagesService],
})
export class MessagesModule {}
