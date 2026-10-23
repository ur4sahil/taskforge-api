import { Injectable, NotFoundException, ForbiddenException, Module, Controller, Post, Get, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

export class CreateCommentDto { @IsString() @IsNotEmpty() body: string = ''; }
export class UpdateCommentDto { @IsString() @IsNotEmpty() body: string = ''; }

const COMMENT_INCLUDE = { author: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, mentions: true, attachments: true };

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService, private notifications: NotificationsService) {}

  async create(wid: string, tid: string, dto: CreateCommentDto, authorId: string) {
    const t = await this.prisma.task.findFirst({
      where: { id: tid, workspaceId: wid, deletedAt: null },
      select: { id: true, title: true, creatorId: true, assigneeId: true },
    });
    if (!t) throw new NotFoundException('Task not found');
    const body = dto.body.trim();
    const comment = await this.prisma.comment.create({
      data: { taskId: tid, authorId, body },
      include: { author: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, attachments: true },
    });
    await this.notifyForComment(wid, t, comment.id, authorId, body);
    return comment;
  }

  /** Edit the body. Author only — or a workspace admin. Mention processing is
   *  re-run against the new body: Mention rows are synced (added for newly
   *  @-mentioned members, removed for mentions that were deleted) and only the
   *  NEWLY mentioned members are notified — followers are not pinged again. */
  async update(wid: string, tid: string, cid: string, dto: UpdateCommentDto, actorMemberId: string, actorRole: string) {
    const comment = await this.prisma.comment.findFirst({
      where: { id: cid, taskId: tid, task: { workspaceId: wid, deletedAt: null } },
      select: { id: true, authorId: true, task: { select: { id: true, title: true, creatorId: true, assigneeId: true } } },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.authorId !== actorMemberId && actorRole !== 'admin') {
      throw new ForbiddenException('Only the author or an admin can edit this comment');
    }
    const body = dto.body.trim();
    const updated = await this.prisma.comment.update({ where: { id: cid }, data: { body }, include: COMMENT_INCLUDE });
    await this.syncMentions(wid, comment.task, cid, comment.authorId, actorMemberId, body);
    return this.prisma.comment.findUniqueOrThrow({ where: { id: updated.id }, include: COMMENT_INCLUDE });
  }

  /** Active members of this workspace whose email is @-mentioned in `body`, minus the author. */
  private async resolveMentions(wid: string, body: string, authorId: string) {
    const emailRe = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = Array.from(new Set(Array.from(body.matchAll(emailRe), (m: any) => m[1].toLowerCase())));
    const mentioned = emails.length === 0 ? [] : await this.prisma.workspaceMember.findMany({
      where: { workspaceId: wid, isActive: true, user: { email: { in: emails } } },
      include: { user: { select: { email: true, name: true } } },
    });
    return mentioned.filter(m => m.id !== authorId);
  }

  private async syncMentions(wid: string, t: { id: string; title: string }, commentId: string, authorId: string, editorId: string, body: string) {
    const targets = (await this.resolveMentions(wid, body, authorId)).filter(m => m.id !== editorId);
    const wantIds = new Set(targets.map(m => m.id));
    const existing = await this.prisma.mention.findMany({ where: { commentId }, select: { mentionedMemberId: true } });
    const haveIds = new Set(existing.map(m => m.mentionedMemberId));
    const added = targets.filter(m => !haveIds.has(m.id));
    const removed = Array.from(haveIds).filter(id => !wantIds.has(id));
    await this.prisma.$transaction([
      ...(removed.length ? [this.prisma.mention.deleteMany({ where: { commentId, mentionedMemberId: { in: removed } } })] : []),
      ...(added.length ? [this.prisma.mention.createMany({ data: added.map(m => ({ commentId, mentionedMemberId: m.id })), skipDuplicates: true })] : []),
    ]);
    if (added.length === 0) return;
    const editor = await this.prisma.workspaceMember.findUnique({ where: { id: editorId }, include: { user: { select: { name: true } } } });
    const editorName = editor?.user?.name || 'Someone';
    await Promise.all(added.map(m => this.notifications.dispatch({
      workspaceId: wid, recipientMemberId: m.id, channel: 'mention',
      type: 'mention', title: `${editorName} mentioned you`,
      body: `In "${t.title}"`, url: `/?task=${t.id}`, entityType: 'comment', entityId: commentId,
      suppressIfActiveScreen: `task:${t.id}`, pushTag: `task:${t.id}`,
    })));
  }

  /** One pass: write Mention rows, dispatch 'mention' to each mentioned member, and dispatch
   *  'task_comment' to the task's creator + assignee (unless they were also mentioned, since
   *  the mention dispatch already covers them). */
  private async notifyForComment(wid: string, t: { id: string; title: string; creatorId: string; assigneeId: string | null }, commentId: string, authorId: string, body: string) {
    const mentionTargets = await this.resolveMentions(wid, body, authorId);
    if (mentionTargets.length > 0) {
      await this.prisma.mention.createMany({
        data: mentionTargets.map(m => ({ commentId, mentionedMemberId: m.id })), skipDuplicates: true,
      });
    }
    const author = await this.prisma.workspaceMember.findUnique({ where: { id: authorId }, include: { user: { select: { name: true } } } });
    const authorName = author?.user?.name || 'Someone';
    const screen = `task:${t.id}`;
    const url = `/?task=${t.id}`;
    const truncate = (s: string) => s.length > 140 ? s.slice(0, 137) + '…' : s;

    // 1) Mentions
    await Promise.all(mentionTargets.map(m => this.notifications.dispatch({
      workspaceId: wid, recipientMemberId: m.id, channel: 'mention',
      type: 'mention', title: `${authorName} mentioned you`,
      body: `In "${t.title}"`, url, entityType: 'comment', entityId: commentId,
      suppressIfActiveScreen: screen, pushTag: `task:${t.id}`,
    })));

    // 2) Followers (creator + assignee) — excluding author + already-mentioned.
    const mentionedIds = new Set(mentionTargets.map(m => m.id));
    const followerIds = [t.creatorId, t.assigneeId].filter((id): id is string => !!id && id !== authorId && !mentionedIds.has(id));
    await Promise.all(followerIds.map(id => this.notifications.dispatch({
      workspaceId: wid, recipientMemberId: id, channel: 'task_comment',
      type: 'task_comment', title: `${authorName} commented`,
      body: `On "${t.title}": ${truncate(body)}`,
      url, entityType: 'comment', entityId: commentId,
      suppressIfActiveScreen: screen, pushTag: `task:${t.id}`,
    })));
  }

  /** Delete a comment. Author can delete their own; workspace admins can delete any.
   *  Cascades to Mention + Attachment rows via Prisma onDelete in the schema. Notification
   *  rows reference the comment via JSON `data.entityId` (not an FK) so they linger as
   *  history — clicking them just no-ops once the entity is gone. */
  async delete(wid: string, tid: string, cid: string, actorMemberId: string, actorRole: string) {
    const comment = await this.prisma.comment.findFirst({
      where: { id: cid, taskId: tid, task: { workspaceId: wid } },
      select: { id: true, authorId: true },
    });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.authorId !== actorMemberId && actorRole !== 'admin') {
      throw new ForbiddenException('Only the author or an admin can delete this comment');
    }
    await this.prisma.comment.delete({ where: { id: cid } });
  }

  async findByTask(wid: string, tid: string, page: number, perPage: number) {
    const task = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid }, select: { id: true } });
    if (!task) throw new NotFoundException('Task not found');
    const [comments, total] = await Promise.all([
      this.prisma.comment.findMany({
        where: { taskId: tid },
        include: { author: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, mentions: true, attachments: true },
        skip: (page - 1) * perPage, take: perPage, orderBy: { createdAt: 'asc' },
      }),
      this.prisma.comment.count({ where: { taskId: tid } }),
    ]);
    return { comments, meta: paginationMeta(total, page, perPage) };
  }
}

@Controller('workspaces/:wid/tasks/:tid/comments') @UseGuards(WorkspaceGuard)
export class CommentsController {
  constructor(private svc: CommentsService) {}
  @Post() async create(@Param('wid') w: string, @Param('tid') t: string, @Body() d: CreateCommentDto, @CurrentMember() m: any) { return successResponse(await this.svc.create(w, t, d, m.id)); }
  @Get() async findAll(@Param('wid') w: string, @Param('tid') t: string, @Query() p: PaginationDto) { const r = await this.svc.findByTask(w, t, p.page, p.perPage); return successResponse(r.comments, r.meta); }
  @Patch(':cid') async update(@Param('wid') w: string, @Param('tid') t: string, @Param('cid') c: string, @Body() d: UpdateCommentDto, @CurrentMember() m: any) {
    return successResponse(await this.svc.update(w, t, c, d, m.id, m.role));
  }
  @Delete(':cid') async remove(@Param('wid') w: string, @Param('tid') t: string, @Param('cid') c: string, @CurrentMember() m: any) {
    await this.svc.delete(w, t, c, m.id, m.role);
    return successResponse({ deleted: true });
  }
}

@Module({
  imports: [NotificationsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
