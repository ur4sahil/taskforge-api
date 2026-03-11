import { Injectable, Module, Controller, Get, Delete, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '@/prisma/prisma.service';
import { Roles } from '@/common/decorators';
import { WorkspaceGuard, RolesGuard } from '@/common/guards';
import { successResponse, PaginationDto, paginationMeta } from '@/common/dto/response.dto';
@Injectable() export class TrashService {
  constructor(private prisma: PrismaService) {}
  async findAll(wid: string, p: PaginationDto) { const [t, n] = await Promise.all([this.prisma.task.findMany({ where: { workspaceId: wid, deletedAt: { not: null } }, include: { creator: { include: { user: { select: { name: true } } } }, list: { select: { name: true } } }, skip: (p.page-1)*p.perPage, take: p.perPage, orderBy: { deletedAt: 'desc' } }), this.prisma.task.count({ where: { workspaceId: wid, deletedAt: { not: null } } })]); return { tasks: t, meta: paginationMeta(n, p.page, p.perPage) }; }
  async permanentDelete(tid: string) { await this.prisma.task.delete({ where: { id: tid } }); }
}
@Controller('workspaces/:wid/trash') @UseGuards(WorkspaceGuard) export class TrashController {
  constructor(private svc: TrashService) {}
  @Get() async all(@Param('wid') w: string, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, p); return successResponse(r.tasks, r.meta); }
  @Delete(':tid') @UseGuards(RolesGuard) @Roles('admin') async remove(@Param('tid') t: string) { await this.svc.permanentDelete(t); return successResponse({ deleted: true }); }
}
@Module({ controllers: [TrashController], providers: [TrashService], exports: [TrashService] }) export class TrashModule {}
