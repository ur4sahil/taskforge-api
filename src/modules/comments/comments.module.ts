import { Injectable, NotFoundException, Module, Controller, Post, Get, Body, Param, Query, UseGuards } from '@nestjs/common';
import { IsString, IsNotEmpty } from 'class-validator';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard } from '@/common/guards';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
export class CreateCommentDto { @IsString() @IsNotEmpty() body: string = ''; }
@Injectable() export class CommentsService {
  constructor(private prisma: PrismaService) {}
  async create(wid: string, tid: string, dto: CreateCommentDto, authorId: string) {
    const t = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid, deletedAt: null } }); if (!t) throw new NotFoundException('Task not found');
    const mentions = Array.from(dto.body.matchAll(/@([a-zA-Z0-9._-]+)/g), m => m[1]);
    const comment = await this.prisma.comment.create({ data: { taskId: tid, authorId, body: dto.body.trim() }, include: { author: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, attachments: true } });
    if (mentions.length) { const members = await this.prisma.workspaceMember.findMany({ where: { workspaceId: wid, isActive: true, user: { name: { in: mentions, mode: 'insensitive' } } }, select: { id: true } }); if (members.length) await this.prisma.mention.createMany({ data: members.map(m => ({ commentId: comment.id, mentionedMemberId: m.id })) }); }
    return comment;
  }
  async findByTask(tid: string, p: PaginationDto) {
    const [comments, total] = await Promise.all([this.prisma.comment.findMany({ where: { taskId: tid }, include: { author: { include: { user: { select: { id: true, name: true, avatarUrl: true } } } }, mentions: true, attachments: true }, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { createdAt: 'asc' } }), this.prisma.comment.count({ where: { taskId: tid } })]);
    return { comments, meta: paginationMeta(total, p.page, p.perPage) };
  }
}
@Controller('workspaces/:wid/tasks/:tid/comments') @UseGuards(WorkspaceGuard) export class CommentsController {
  constructor(private svc: CommentsService) {}
  @Post() async create(@Param('wid') w: string, @Param('tid') t: string, @Body() d: CreateCommentDto, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.create(w, t, d, m.id)); }
  @Get() async findAll(@Param('tid') t: string, @Query() p: PaginationDto) { const r = await this.svc.findByTask(t, p); return successResponse(r.comments, r.meta); }
}
@Module({ controllers: [CommentsController], providers: [CommentsService], exports: [CommentsService] }) export class CommentsModule {}
