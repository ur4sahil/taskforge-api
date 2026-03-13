import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Module, Controller, Post, Get, Delete, Param, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';

const BLOCKED = ['.exe', '.bat', '.sh', '.ps1', '.cmd', '.vbs', '.jar', '.msi', '.scr', '.dll'];

@Injectable()
export class AttachmentsService {
  constructor(private prisma: PrismaService) {}
  async uploadToTask(wid: string, tid: string, file: any, uid: string) {
    if (file.size > 50 * 1024 * 1024) throw new BadRequestException('File too large');
    const ext = '.' + (file.originalname || '').split('.').pop()?.toLowerCase();
    if (BLOCKED.includes(ext)) throw new BadRequestException('Blocked file type');
    const task = await this.prisma.task.findFirst({ where: { id: tid, workspaceId: wid, deletedAt: null } });
    if (!task) throw new NotFoundException('Task not found');
    return this.prisma.attachment.create({ data: { workspaceId: wid, taskId: tid, commentId: null, uploadedById: uid, fileName: file.originalname, fileSize: file.size, mimeType: file.mimetype, storageKey: `${wid}/${tid}/${uuidv4()}-${file.originalname}` } });
  }
  async getUrl(wid: string, aid: string) {
    const a = await this.prisma.attachment.findFirst({ where: { id: aid, workspaceId: wid } });
    if (!a) throw new NotFoundException('Not found');
    return { url: `/files/${a.storageKey}`, fileName: a.fileName, mimeType: a.mimeType };
  }
  async remove(wid: string, aid: string, member: any) {
    const a = await this.prisma.attachment.findFirst({ where: { id: aid, workspaceId: wid } });
    if (!a) throw new NotFoundException('Not found');
    if (member.role !== 'admin' && a.uploadedById !== member.id) throw new ForbiddenException('No permission');
    await this.prisma.attachment.delete({ where: { id: aid } });
  }
}

@Controller('workspaces/:wid') @UseGuards(WorkspaceGuard)
export class AttachmentsController {
  constructor(private svc: AttachmentsService) {}
  @Post('tasks/:tid/attachments') @UseInterceptors(FileInterceptor('file'))
  async toTask(@Param('wid') w: string, @Param('tid') t: string, @UploadedFile() f: any, @CurrentMember() m: any) { return successResponse(await this.svc.uploadToTask(w, t, f, m.id)); }
  @Get('attachments/:aid/url')
  async url(@Param('wid') w: string, @Param('aid') a: string) { return successResponse(await this.svc.getUrl(w, a)); }
  @Delete('attachments/:aid')
  async remove(@Param('wid') w: string, @Param('aid') a: string, @CurrentMember() m: any) { await this.svc.remove(w, a, m); return successResponse({ deleted: true }); }
}

@Module({ controllers: [AttachmentsController], providers: [AttachmentsService], exports: [AttachmentsService] })
export class AttachmentsModule {}
