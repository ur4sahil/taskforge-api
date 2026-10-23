import { Injectable, Module, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto } from '../../common/dto/response.dto';
import { listScope } from '../../common/utils/list-access';

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}
  /** Non-admins only ever match tasks in lists they can open (same rule as
   *  GET /tasks) and comments on those tasks. Archived and trashed tasks are
   *  excluded for everyone. */
  async search(wid: string, member: any, q: string, page: number, perPage: number) {
    if (!q || q.trim().length === 0) return { tasks: [], comments: [] };
    const taskScope = { workspaceId: wid, deletedAt: null, archivedAt: null, ...(await listScope(this.prisma, wid, member)) };
    const tasks = await this.prisma.task.findMany({
      where: { ...taskScope, OR: [{ title: { contains: q, mode: 'insensitive' } }, { description: { contains: q, mode: 'insensitive' } }] },
      include: { list: { select: { id: true, name: true } }, assignee: { include: { user: { select: { name: true } } } } },
      take: perPage, skip: (page - 1) * perPage,
    });
    const comments = await this.prisma.comment.findMany({
      where: { body: { contains: q, mode: 'insensitive' }, task: taskScope },
      include: { task: { select: { id: true, title: true, listId: true } }, author: { include: { user: { select: { name: true } } } } },
      take: 10,
    });
    return { tasks, comments };
  }
}

@Controller('workspaces/:wid/search') @UseGuards(WorkspaceGuard)
export class SearchController {
  constructor(private svc: SearchService) {}
  @Get() async search(@Param('wid') w: string, @CurrentMember() m: any, @Query('q') q: string, @Query() p: PaginationDto) { return successResponse(await this.svc.search(w, m, q || '', p.page, p.perPage)); }
}

@Module({ controllers: [SearchController], providers: [SearchService], exports: [SearchService] })
export class SearchModule {}
