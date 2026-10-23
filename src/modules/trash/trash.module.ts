import { Injectable, NotFoundException, Module, Controller, Get, Delete, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';

@Injectable()
export class TrashService {
  constructor(private prisma: PrismaService) {}
  async findAll(wid: string, page: number, perPage: number) {
    const [t, n] = await Promise.all([
      this.prisma.task.findMany({ where: { workspaceId: wid, deletedAt: { not: null } }, include: { creator: { include: { user: { select: { name: true } } } }, list: { select: { name: true } } }, skip: (page - 1) * perPage, take: perPage, orderBy: { deletedAt: 'desc' } }),
      this.prisma.task.count({ where: { workspaceId: wid, deletedAt: { not: null } } }),
    ]);
    return { tasks: t, meta: paginationMeta(n, page, perPage) };
  }
  /** Only a task that is (a) in this workspace and (b) already in the trash can be purged. */
  async permanentDelete(wid: string, tid: string) {
    const { count } = await this.prisma.task.deleteMany({ where: { id: tid, workspaceId: wid, deletedAt: { not: null } } });
    if (count === 0) throw new NotFoundException('Task not found in trash');
  }
}

@Controller('workspaces/:wid/trash') @UseGuards(WorkspaceGuard)
export class TrashController {
  constructor(private svc: TrashService) {}
  @Get() async all(@Param('wid') w: string, @Query() p: PaginationDto) { const r = await this.svc.findAll(w, p.page, p.perPage); return successResponse(r.tasks, r.meta); }
  @Delete(':tid') @UseGuards(RolesGuard) @Roles('admin') async remove(@Param('wid') w: string, @Param('tid') t: string) { await this.svc.permanentDelete(w, t); return successResponse({ deleted: true }); }
}

@Module({ controllers: [TrashController], providers: [TrashService], exports: [TrashService] })
export class TrashModule {}
