import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Module, Controller, Post, Get, Delete, Param, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '@/prisma/prisma.service';
import { CurrentMember, CurrentWorkspaceMember } from '@/common/decorators';
import { WorkspaceGuard } from '@/common/guards';
import { successResponse } from '@/common/dto/response.dto';
const BLOCKED = ['.exe','.bat','.sh','.ps1','.cmd','.vbs','.jar','.msi','.scr','.dll'];
@Injectable() export class AttachmentsService {
  constructor(private prisma: PrismaService) {}
  async uploadToTask(wid: string, tid: string, file: Express.Multer.File, uid: string) {
    if (file.size > 50*1024*1024) throw new BadRequestException('File too large (50MB max)');
    const ext = '.'+file.originalname.split('.').pop()?.toLowerCase(); if (BLOCKED.includes(ext)) throw new BadRequestException('Blocked file type');
    const task = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid, deletedAt: null } }); if (!task) throw new NotFoundException('Task not found');
    return this.prisma.attachment.create({ data: { workspaceId: wid, taskId: tid, commentId: null, uploadedById: uid, fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype, storageKey: `${wid}/${tid}/${uuidv4()}-${file.originalname}` } });
  }
  async uploadToComment(wid: string, cid: string, file: Express.Multer.File, uid: string) {
    const c = await this.prisma.comment.findUnique({ where: { id: cid }, include: { task: true } }); if (!c) throw new NotFoundException('Comment not found');
    return this.prisma.attachment.create({ data: { workspaceId: wid, taskId: c.taskId, commentId: cid, uploadedById: uid, fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype, storageKey: `${wid}/${c.taskId}/comments/${cid}/${uuidv4()}-${file.originalname}` } });
  }
  async getUrl(wid: string, aid: string) { const a = await this.prisma.attachment.findFirst({ where: { id: aid, workspaceId: wid } }); if (!a) throw new NotFoundException('Not found'); return { url: `/files/${a.storageKey}`, fileName: a.fileName, mimeType: a.mimeType }; }
  async delete(wid: string, aid: string, m: CurrentWorkspaceMember) { const a = await this.prisma.attachment.findFirst({ where: { id: aid, workspaceId: wid } }); if (!a) throw new NotFoundException('Not found'); if (m.role !== 'admin' && a.uploadedById !== m.id) throw new ForbiddenException('No permission'); await this.prisma.attachment.delete({ where: { id: aid } }); }
}
@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard) export class AttachmentsController {
  constructor(private svc: AttachmentsService) {}
  @Post('tasks/:tid/attachments') @UseInterceptors(FileInterceptor('file')) async toTask(@Param('wid') w: string, @Param('tid') t: string, @UploadedFile() f: Express.Multer.File, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.uploadToTask(w, t, f, m.id)); }
  @Post('comments/:cid/attachments') @UseInterceptors(FileInterceptor('file')) async toComment(@Param('wid') w: string, @Param('cid') c: string, @UploadedFile() f: Express.Multer.File, @CurrentMember() m: CurrentWorkspaceMember) { return successResponse(await this.svc.uploadToComment(w, c, f, m.id)); }
  @Get('attachments/:aid/url') async url(@Param('wid') w: string, @Param('aid') a: string) { return successResponse(await this.svc.getUrl(w, a)); }
  @Delete('attachments/:aid') async remove(@Param('wid') w: string, @Param('aid') a: string, @CurrentMember() m: CurrentWorkspaceMember) { await this.svc.delete(w, a, m); return successResponse({ deleted: true }); }
}
@Module({ controllers: [AttachmentsController], providers: [AttachmentsService], exports: [AttachmentsService] }) export class AttachmentsModule {}
