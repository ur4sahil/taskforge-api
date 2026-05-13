import { Injectable, NotFoundException, Module, Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

export class CreateCommentDto { @IsString() @IsNotEmpty() body: string = ''; }

@Injectable()
export class CommentsService {
  constructor(private prisma: PrismaService) {}

  async create(wid: string, tid: string, dto: CreateCommentDto, authorId: string) {
    const t = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid, deletedAt: null } });
    if (!t) throw new NotFoundException('Task not found');
    const body = dto.body.trim();
    const comment = await this.prisma.comment.create({
      data: { taskId: tid, authorId, body },
      include: { author: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, attachments: true },
    });
    await this.processMentions(wid, tid, comment.id, authorId, body, t.title);
    return comment;
  }

  private async processMentions(wid: string, tid: string, commentId: string, authorId: string, body: string, taskTitle: string) {
    const emailRe = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
    const emails = Array.from(new Set(Array.from(body.matchAll(emailRe), (m: any) => m[1].toLowerCase())));
    if (emails.length === 0) return;
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId: wid, isActive: true, user: { email: { in: emails } } },
      include: { user: { select: { email: true, name: true } } },
    });
    const targets = members.filter((m: any) => m.id !== authorId);
    if (targets.length === 0) return;
    const author = await this.prisma.workspaceMember.findUnique({ where: { id: authorId }, include: { user: { select: { name: true } } } });
    const authorName = author?.user?.name || 'Someone';
    await this.prisma.$transaction([
      this.prisma.mention.createMany({ data: targets.map((m: any) => ({ commentId, mentionedMemberId: m.id })), skipDuplicates: true }),
      this.prisma.notification.createMany({ data: targets.map((m: any) => ({
        workspaceId: wid,
        recipientId: m.id,
        type: 'mention',
        title: `${authorName} mentioned you`,
        body: `In comment on "${taskTitle}"`,
        data: { taskId: tid, commentId },
      })) }),
    ]);
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

@Module({ controllers: [CommentsController], providers: [CommentsService], exports: [CommentsService] })
export class CommentsModule {}
