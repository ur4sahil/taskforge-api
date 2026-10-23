import { Injectable, Module, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember } from '../../common/decorators';
import { WorkspaceGuard } from '../../common/guards';
import { successResponse, PaginationDto, paginationMeta } from '../../common/dto/response.dto';
import { listScopeWhere } from '../../common/utils/list-access';

/** Hard caps (QA #32). Prisma's `contains` + mode:'insensitive' compiles to
 *  ILIKE '%q%', which the pg_trgm GIN indexes in prisma/migrations/custom_indexes.sql
 *  serve directly. */
export const SEARCH_TASK_CAP = 25;
export const SEARCH_COMMENT_CAP = 25;

@Injectable()
export class SearchService {
  constructor(private prisma: PrismaService) {}
  /** Non-admins only ever match tasks in lists they can open (same rule as
   *  GET /tasks) and comments on those tasks. Archived and trashed tasks are
   *  excluded for everyone. The list scope rides inside each query as a
   *  relation filter (no id-resolution round trips), and the four statements
   *  (tasks page + total, comments + total) run in parallel. */
  async search(wid: string, member: any, q: string, page: number, perPage: number) {
    const take = Math.min(perPage, SEARCH_TASK_CAP);
    const term = q.trim();
    if (!term) return { tasks: [], comments: [], totals: { tasks: 0, comments: 0 }, meta: paginationMeta(0, page, take) };
    const taskScope = { workspaceId: wid, deletedAt: null, archivedAt: null, ...listScopeWhere(wid, member) };
    const taskWhere = { ...taskScope, OR: [{ title: { contains: term, mode: 'insensitive' as const } }, { description: { contains: term, mode: 'insensitive' as const } }] };
    const commentWhere = { body: { contains: term, mode: 'insensitive' as const }, task: taskScope };
    const [tasks, taskTotal, comments, commentTotal] = await Promise.all([
      this.prisma.task.findMany({
        where: taskWhere,
        include: { list: { select: { id: true, name: true } }, assignee: { include: { user: { select: { name: true } } } } },
        orderBy: { updatedAt: 'desc' },
        take, skip: (page - 1) * take,
      }),
      this.prisma.task.count({ where: taskWhere }),
      this.prisma.comment.findMany({
        where: commentWhere,
        include: { task: { select: { id: true, title: true, listId: true } }, author: { include: { user: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: SEARCH_COMMENT_CAP,
      }),
      this.prisma.comment.count({ where: commentWhere }),
    ]);
    return { tasks, comments, totals: { tasks: taskTotal, comments: commentTotal }, meta: paginationMeta(taskTotal, page, take) };
  }
}

@Controller('workspaces/:wid/search') @UseGuards(WorkspaceGuard)
export class SearchController {
  constructor(private svc: SearchService) {}
  /** data: { tasks[≤25], comments[≤25], totals: { tasks, comments } }; meta pages the tasks. */
  @Get() async search(@Param('wid') w: string, @CurrentMember() m: any, @Query('q') q: string, @Query() p: PaginationDto) {
    const r = await this.svc.search(w, m, q || '', p.page, p.perPage);
    return successResponse({ tasks: r.tasks, comments: r.comments, totals: r.totals }, r.meta);
  }
}

@Module({ controllers: [SearchController], providers: [SearchService], exports: [SearchService] })
export class SearchModule {}
