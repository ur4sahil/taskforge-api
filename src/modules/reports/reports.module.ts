import { Injectable, Module, Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentMember, Roles } from '../../common/decorators';
import { WorkspaceGuard, RolesGuard } from '../../common/guards';
import { successResponse } from '../../common/dto/response.dto';
import { workspaceTimezone, todayKey, dateKeyToDb } from '../../common/utils/dates';
import { getAccessibleListIds } from '../../common/utils/list-access';

export class HomeQueryDto {
  /** mine = tasks assigned to the caller; all = every task in lists the caller can see. */
  @IsOptional() @IsIn(['mine', 'all']) scope: 'mine' | 'all' = 'mine';
}

/** Light row for Home tiles — enough to render a task line and link to it,
 *  without TASK_INCLUDE's checklist/counts joins. */
const HOME_TASK_SELECT = {
  id: true, title: true, status: true, priority: true, dueDate: true, dueTime: true, listId: true,
  list: { select: { id: true, name: true } },
  assignee: { select: { id: true, user: { select: { name: true } } } },
} as const;
const HOME_ROWS = 10;

@Injectable()
export class ReportsService {
  constructor(private prisma: PrismaService) {}

  /** "Today" as the workspace sees it — see common/utils/dates.ts. Overdue
   *  means the due day is before today; due today means it is today. */
  private async dayBounds(wid: string) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: wid }, select: { settings: true } });
    const today = dateKeyToDb(todayKey(workspaceTimezone(ws?.settings)));
    const tomorrow = new Date(today.getTime() + 86400000);
    return { today, tomorrow };
  }

  async personal(wid: string, mid: string, bounds?: { today: Date; tomorrow: Date }) {
    const { today, tomorrow } = bounds ?? await this.dayBounds(wid);
    const weekAgo = new Date(Date.now() - 7 * 86400000);
    const [open, overdue, dueToday, done7d] = await Promise.all([
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, status: { not: 'done' }, deletedAt: null, archivedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, status: { not: 'done' }, dueDate: { lt: today }, deletedAt: null, archivedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, dueDate: { gte: today, lt: tomorrow }, deletedAt: null, archivedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, assigneeId: mid, status: 'done', completedAt: { gte: weekAgo }, deletedAt: null, archivedAt: null } }),
    ]);
    return { open, overdue, dueToday, completedThisWeek: done7d };
  }
  /** Everything the Home screen needs in one request (QA #5/#6 — the web used
   *  to page 200 tasks and compute tiles client-side, 5–9 s).
   *
   *  Semantics match GET /tasks: top-level tasks only (no subtasks), archived
   *  and trashed excluded. "Open" = status ≠ done. Overdue / due-today are
   *  calendar days in the workspace timezone (dates.ts); due-today counts only
   *  open tasks. completedThisWeek = done with completedAt in the last 7 days,
   *  same as my-stats.
   *
   *  scope=mine → assigneeId = caller (whatever list; it's their work).
   *  scope=all  → the lists the caller may see (admins: every list).
   *
   *  Two round trips: [workspace tz ‖ list scope], then 5 parallel queries
   *  (counts + byList as two single-scan SQL statements, three ≤10-row lists). */
  async home(wid: string, member: { id: string; role: string }, scope: 'mine' | 'all') {
    const [ws, listIds] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: wid }, select: { settings: true } }),
      scope === 'all' && member.role !== 'admin' ? getAccessibleListIds(this.prisma, wid, member) : Promise.resolve(null),
    ]);
    const today = todayKey(workspaceTimezone(ws?.settings));
    const todayDb = dateKeyToDb(today);
    const weekAgo = new Date(Date.now() - 7 * 86400000);

    // Prisma where (for the row lists) and the equivalent SQL (for the two
    // aggregate statements) — keep them in lockstep.
    const base: any = { workspaceId: wid, parentTaskId: null, deletedAt: null, archivedAt: null };
    const sqlParts = [
      Prisma.sql`t.workspace_id = ${wid}::uuid`, Prisma.sql`t.parent_task_id IS NULL`,
      Prisma.sql`t.deleted_at IS NULL`, Prisma.sql`t.archived_at IS NULL`,
    ];
    if (scope === 'mine') {
      base.assigneeId = member.id;
      sqlParts.push(Prisma.sql`t.assignee_id = ${member.id}::uuid`);
    } else if (listIds) {
      base.listId = { in: listIds };
      sqlParts.push(Prisma.sql`t.list_id = ANY(${listIds}::uuid[])`);
    }
    const scopeSql = Prisma.join(sqlParts, ' AND ');
    const open = { ...base, status: { not: 'done' as const } };

    const [countRows, byList, overdue, dueToday, inProgress] = await Promise.all([
      this.prisma.$queryRaw<{ open: number; overdue: number; dueToday: number; completedThisWeek: number; inProgress: number }[]>(Prisma.sql`
        SELECT
          count(*) FILTER (WHERE t.status <> 'done')::int AS "open",
          count(*) FILTER (WHERE t.status <> 'done' AND t.due_date < ${today}::date)::int AS "overdue",
          count(*) FILTER (WHERE t.status <> 'done' AND t.due_date = ${today}::date)::int AS "dueToday",
          count(*) FILTER (WHERE t.status = 'done' AND t.completed_at >= ${weekAgo})::int AS "completedThisWeek",
          count(*) FILTER (WHERE t.status = 'in_progress')::int AS "inProgress"
        FROM tasks t WHERE ${scopeSql}`),
      this.prisma.$queryRaw<{ listId: string; name: string; openCount: number }[]>(Prisma.sql`
        SELECT l.id AS "listId", l.name, count(*)::int AS "openCount"
        FROM tasks t JOIN lists l ON l.id = t.list_id
        WHERE ${scopeSql} AND t.status <> 'done'
        GROUP BY l.id, l.name ORDER BY count(*) DESC, l.name ASC`),
      this.prisma.task.findMany({ where: { ...open, dueDate: { lt: todayDb } }, select: HOME_TASK_SELECT, take: HOME_ROWS, orderBy: [{ dueDate: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }] }),
      this.prisma.task.findMany({ where: { ...open, dueDate: todayDb }, select: HOME_TASK_SELECT, take: HOME_ROWS, orderBy: [{ dueTime: { sort: 'asc', nulls: 'last' } }, { priority: 'desc' }, { createdAt: 'asc' }] }),
      this.prisma.task.findMany({ where: { ...base, status: 'in_progress' }, select: HOME_TASK_SELECT, take: HOME_ROWS, orderBy: { updatedAt: 'desc' } }),
    ]);
    const counts = countRows[0] ?? { open: 0, overdue: 0, dueToday: 0, completedThisWeek: 0, inProgress: 0 };
    return { scope, today, counts, overdue, dueToday, inProgress, byList };
  }

  async team(wid: string, managerId: string) {
    const bounds = await this.dayBounds(wid);
    const reports = await this.prisma.workspaceMember.findMany({ where: { workspaceId: wid, managerId, isActive: true }, include: { user: { select: { name: true } } } });
    const stats = await Promise.all(reports.map(async (r: any) => ({ memberId: r.id, name: r.user.name, ...await this.personal(wid, r.id, bounds) })));
    return { teamSize: reports.length, members: stats, caveat: 'Task counts do not reflect quality or complexity of work.' };
  }
  async workspace(wid: string) {
    const { today } = await this.dayBounds(wid);
    const [total, open, overdue, byStatus] = await Promise.all([
      this.prisma.task.count({ where: { workspaceId: wid, deletedAt: null, archivedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, status: { not: 'done' }, deletedAt: null, archivedAt: null } }),
      this.prisma.task.count({ where: { workspaceId: wid, status: { not: 'done' }, dueDate: { lt: today }, deletedAt: null, archivedAt: null } }),
      this.prisma.task.groupBy({ by: ['status'], _count: true, where: { workspaceId: wid, deletedAt: null, archivedAt: null } }),
    ]);
    return { total, open, overdue, byStatus };
  }
}

@Controller('workspaces/:wid/reports') @UseGuards(WorkspaceGuard)
export class ReportsController {
  constructor(private svc: ReportsService) {}
  @Get('my-stats') async my(@Param('wid') w: string, @CurrentMember() m: any) { return successResponse(await this.svc.personal(w, m.id)); }
  @Get('home') async home(@Param('wid') w: string, @CurrentMember() m: any, @Query() q: HomeQueryDto) { return successResponse(await this.svc.home(w, m, q.scope)); }
  @Get('team') @UseGuards(RolesGuard) @Roles('manager') async team(@Param('wid') w: string, @CurrentMember() m: any) { return successResponse(await this.svc.team(w, m.id)); }
  @Get('workspace') @UseGuards(RolesGuard) @Roles('admin') async ws(@Param('wid') w: string) { return successResponse(await this.svc.workspace(w)); }
}

@Module({ controllers: [ReportsController], providers: [ReportsService], exports: [ReportsService] })
export class ReportsModule {}
