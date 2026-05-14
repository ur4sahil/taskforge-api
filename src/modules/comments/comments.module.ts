import { Injectable, NotFoundException, Module, Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { NotificationsModule, NotificationsService } from '../notifications/notifications.module';

export class CreateCommentDto { @IsString() @IsNotEmpty() body: string = ''; }

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

  /** One pass: write Mention rows, dispatch 'mention' to each mentioned member, and dispatch
   *  'task_comment' to the task's creator + assignee (unless they were also mentioned, since
   *  the mention dispatch already covers them). */
  private async notifyForComment(wid: string, t: { id: string; title: string; creatorId: string; assigneeId: string | null }, commentId: string, authorId: string, body: string) {
    const emailRe = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = Array.from(new Set(Array.from(body.matchAll(emailRe), (m: any) => m[1].toLowerCase())));
    const mentioned = emails.length === 0 ? [] : await this.prisma.workspaceMember.findMany({
      where: { workspaceId: wid, isActive: true, user: { email: { in: emails } } },
      include: { user: { select: { email: true, name: true } } },
    });
    const mentionTargets = mentioned.filter(m => m.id !== authorId);
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

  async findByTask(tid: string, page: number, perPage: number) {
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
  @Get() async findAll(@Param('tid') t: string, @Query() p: PaginationDto) { const r = await this.svc.findByTask(t, p.page, p.perPage); return successResponse(r.comments, r.meta); }
}

@Module({
  imports: [NotificationsModule],
  controllers: [CommentsController],
  providers: [CommentsService],
  exports: [CommentsService],
})
export class CommentsModule {}
